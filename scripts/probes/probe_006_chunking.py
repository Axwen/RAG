#!/usr/bin/env python3
"""PROBE-006 分块、引用定位与真实检索探针。

输入必须是 PROBE-002 保存的原始 ParseArtifact，以及脱敏黄金题子集。分块、
稳定 ID 和引用映射在本地完成；Recall@5 只有在真实 Embedding 与 OpenSearch
均可用时才计算。缺少任一外部依赖时，报告明确为 BLOCKED，不生成冻结参数。
"""
import argparse
import hashlib
import json
import os
import platform
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


FROZEN_DIM = 1024
DEFAULT_CANDIDATES = [
    {"name": "compact-256", "max_chars": 256, "overlap_chars": 32,
     "rows_per_chunk": 8, "tolerance_factor": 3, "parent_child": False},
    {"name": "balanced-512", "max_chars": 512, "overlap_chars": 64,
     "rows_per_chunk": 16, "tolerance_factor": 3, "parent_child": False},
    {"name": "wide-1024", "max_chars": 1024, "overlap_chars": 128,
     "rows_per_chunk": 32, "tolerance_factor": 3, "parent_child": False},
    {"name": "balanced-512-parent-child", "max_chars": 512,
     "overlap_chars": 64, "rows_per_chunk": 16, "tolerance_factor": 3,
     "parent_child": True},
]


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def stable_id(prefix, value):
    return f"{prefix}_{sha256_bytes(canonical_json(value).encode())[:24]}"


def fingerprint(value):
    return "sha256:" + sha256_bytes(canonical_json(value).encode())


def request_json(url, method="GET", payload=None, headers=None, timeout=60):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method=method)
    request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
            return response.status, parsed, time.perf_counter() - started
    except urllib.error.HTTPError as error:
        try:
            raw = error.read()
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            parsed = {"error": f"HTTP {error.code}"}
        return error.code, parsed, time.perf_counter() - started
    except Exception as error:  # noqa: BLE001
        return None, {"error": str(error)}, time.perf_counter() - started


def load_artifacts(directory):
    artifacts = []
    for path in sorted(Path(directory).glob("*.json")):
        try:
            artifact = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(artifact, dict) and isinstance(artifact.get("blocks"), list):
            artifact.setdefault("filename", path.stem)
            artifacts.append(artifact)
    return artifacts


def load_golden(path):
    if not path:
        return []
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        payload = payload.get("questions", [])
    if not isinstance(payload, list):
        raise ValueError("黄金题文件必须是数组或包含 questions 数组的对象")
    return payload


def block_location(block, artifact_name, block_index, section_path):
    positions = block.get("positions") or []
    bbox = block.get("bbox")
    return {
        "artifact": artifact_name,
        "block_index": block_index,
        "page": block.get("page_number"),
        "bbox": bbox,
        "positions": positions,
        "line_span": block.get("line_span"),
        "section_path": list(section_path),
    }


def split_text(text, max_chars, overlap_chars):
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]
    pieces = []
    cursor = 0
    while cursor < len(text):
        limit = min(len(text), cursor + max_chars)
        if limit < len(text):
            boundary = max(text.rfind(mark, cursor + max_chars // 2, limit)
                           for mark in ("。", "！", "？", ".", "!", "?", ";", "；"))
            if boundary >= cursor:
                limit = boundary + 1
        piece = text[cursor:limit].strip()
        if piece:
            pieces.append(piece)
        if limit >= len(text):
            break
        next_cursor = max(cursor + 1, limit - overlap_chars)
        if next_cursor <= cursor:
            next_cursor = limit
        cursor = next_cursor
    return pieces


def split_atomic_lines(text, max_chars, rows_per_chunk):
    lines = [line for line in (text or "").splitlines() if line.strip()]
    if not lines or len(text) <= max_chars:
        return [text] if text else []
    groups = []
    current = []
    current_size = 0
    for line in lines:
        would_overflow = current and current_size + len(line) + 1 > max_chars
        if would_overflow or len(current) >= rows_per_chunk:
            groups.append("\n".join(current))
            current = []
            current_size = 0
        current.append(line)
        current_size += len(line) + 1
    if current:
        groups.append("\n".join(current))
    return groups


def section_paths(blocks):
    paths = []
    current = []
    for block in blocks:
        layout = block.get("layout_type")
        level = block.get("level")
        text = (block.get("text") or "").strip()
        if layout in ("title", "heading") or level:
            heading_level = int(level or 1)
            current = current[:max(0, heading_level - 1)]
            current.append(re.sub(r"\s+", " ", text))
        paths.append(list(current))
    return paths


def create_chunk(artifact, manifest, ordinal, text, block_indices, section_path,
                 parent_id=None, piece=False):
    locations = [block_location(artifact["blocks"][index], artifact["filename"],
                                index, section_path) for index in block_indices]
    identity = {
        "content_hash": artifact.get("content_hash"),
        "chunker": manifest,
        "ordinal": ordinal,
        "text": text,
        "block_indices": block_indices,
        "parent_id": parent_id,
    }
    return {
        "chunk_id": stable_id("chk", identity),
        "parent_id": parent_id,
        "ordinal": ordinal,
        "text": text,
        "embedding_text": text,
        "artifact": artifact["filename"],
        "source_block_indices": list(block_indices),
        "section_path": list(section_path),
        "locations": locations,
        "piece": piece,
    }


def chunk_artifact(artifact, candidate):
    manifest = {key: candidate[key] for key in (
        "max_chars", "overlap_chars", "rows_per_chunk", "tolerance_factor",
        "parent_child")}
    paths = section_paths(artifact.get("blocks", []))
    drafts = []
    for block_index, block in enumerate(artifact.get("blocks", [])):
        text = block.get("text") or ""
        if not text.strip():
            continue
        layout = (block.get("layout_type") or "text").lower()
        atomic = layout in {"table", "code", "list", "figure", "image"}
        if atomic:
            pieces = split_atomic_lines(text, candidate["max_chars"],
                                        candidate["rows_per_chunk"])
        else:
            pieces = split_text(text, candidate["max_chars"],
                                candidate["overlap_chars"])
        for piece in pieces:
            drafts.append({"text": piece, "block_indices": [block_index],
                           "section_path": paths[block_index],
                           "piece": len(pieces) > 1})

    chunks = []
    buffered = []
    buffered_size = 0
    tolerance = min(candidate["max_chars"] * candidate["tolerance_factor"], 8192)
    for draft in drafts:
        draft_size = len(draft["text"])
        if buffered and buffered_size + draft_size + 2 > candidate["max_chars"]:
            chunks.append(create_chunk(artifact, manifest, len(chunks),
                                       "\n\n".join(item["text"] for item in buffered),
                                       sorted({index for item in buffered
                                               for index in item["block_indices"]}),
                                       buffered[-1]["section_path"],
                                       piece=any(item["piece"] for item in buffered)))
            buffered = []
            buffered_size = 0
        if draft_size > tolerance or draft["piece"]:
            if buffered:
                chunks.append(create_chunk(artifact, manifest, len(chunks),
                                           "\n\n".join(item["text"] for item in buffered),
                                           sorted({index for item in buffered
                                                   for index in item["block_indices"]}),
                                           buffered[-1]["section_path"],
                                           piece=any(item["piece"] for item in buffered)))
                buffered = []
                buffered_size = 0
            chunks.append(create_chunk(artifact, manifest, len(chunks),
                                       draft["text"], draft["block_indices"],
                                       draft["section_path"], piece=draft["piece"]))
            continue
        buffered.append(draft)
        buffered_size += draft_size + (2 if len(buffered) > 1 else 0)
    if buffered:
        chunks.append(create_chunk(artifact, manifest, len(chunks),
                                   "\n\n".join(item["text"] for item in buffered),
                                   sorted({index for item in buffered
                                           for index in item["block_indices"]}),
                                   buffered[-1]["section_path"],
                                   piece=any(item["piece"] for item in buffered)))

    if candidate["parent_child"]:
        by_section = {}
        for chunk in chunks:
            key = tuple(chunk["section_path"])
            by_section.setdefault(key, []).append(chunk)
        for section_chunks in by_section.values():
            parent_text = "\n\n".join(item["text"] for item in section_chunks)
            parent = create_chunk(artifact, manifest, len(chunks), parent_text,
                                  sorted({index for item in section_chunks
                                          for index in item["source_block_indices"]}),
                                  section_chunks[0]["section_path"],
                                  parent_id=None)
            parent["retrieval_kind"] = "parent"
            chunks.append(parent)
            for child in section_chunks:
                child["parent_id"] = parent["chunk_id"]
                child["retrieval_kind"] = "child"
                child["chunk_id"] = stable_id("chk", {
                    "content_hash": artifact.get("content_hash"),
                    "chunker": manifest,
                    "ordinal": child["ordinal"],
                    "text": child["text"],
                    "block_indices": child["source_block_indices"],
                    "parent_id": parent["chunk_id"],
                })
    else:
        for chunk in chunks:
            chunk["retrieval_kind"] = "leaf"
    return chunks


def resolve_targets(question, artifacts):
    targets = question.get("targets") or []
    resolved = {}
    for target in targets:
        filename = target.get("artifact")
        artifact = next((item for item in artifacts
                         if item.get("filename") == filename), None)
        if not artifact:
            continue
        indices = set(target.get("block_indices") or [])
        contains = target.get("contains")
        if contains:
            indices.update(index for index, block in enumerate(artifact["blocks"])
                           if contains in (block.get("text") or ""))
        resolved[filename] = indices
    return resolved


def citation_metrics(chunks, artifacts):
    by_name = {artifact["filename"]: artifact for artifact in artifacts}
    total = 0
    located = 0
    source_splits = {"table": [0, 0], "code": [0, 0], "list": [0, 0]}
    block_chunk_counts = {}
    for chunk in chunks:
        artifact = by_name.get(chunk["artifact"])
        if not artifact:
            continue
        total += 1
        valid = True
        for location in chunk["locations"]:
            block_index = location["block_index"]
            if block_index >= len(artifact["blocks"]):
                valid = False
                continue
            block = artifact["blocks"][block_index]
            has_backlink = bool(location.get("positions") or
                                location.get("line_span") or
                                location.get("section_path"))
            valid = valid and has_backlink
            block_chunk_counts.setdefault((chunk["artifact"], block_index), set()).add(
                chunk["chunk_id"])
        if valid and chunk["locations"]:
            located += 1
    for (artifact_name, block_index), chunk_ids in block_chunk_counts.items():
        artifact = by_name[artifact_name]
        layout = (artifact["blocks"][block_index].get("layout_type") or "").lower()
        if layout in source_splits:
            source_splits[layout][1] += 1
            if len(chunk_ids) > 1:
                source_splits[layout][0] += 1
    split_rates = {}
    for layout, (split_count, total_count) in source_splits.items():
        split_rates[layout] = round(split_count / total_count, 4) if total_count else 0.0
    return {
        "citation_locatable_rate": round(located / total, 4) if total else 0.0,
        "chunk_count": len(chunks),
        "citation_chunks": total,
        "split_rates": split_rates,
        "truncation_rate": round(sum(split_rates.values()) / len(split_rates), 4)
        if split_rates else 0.0,
    }


class EmbeddingClient:
    def __init__(self, base, model, key):
        self.base = base.rstrip("/")
        self.model = model
        self.key = key

    def embed(self, texts):
        vectors = []
        usage = []
        timings = []
        for start in range(0, len(texts), 32):
            batch = texts[start:start + 32]
            payload = {"model": self.model, "input": batch,
                       "encoding_format": "float", "dimensions": FROZEN_DIM}
            status, body, elapsed = request_json(
                f"{self.base}/embeddings", method="POST", payload=payload,
                headers={"Authorization": f"Bearer {self.key}"}, timeout=120)
            if status != 200:
                raise RuntimeError(f"embedding HTTP {status}: {body}")
            data = body.get("data") or []
            if len(data) != len(batch):
                raise RuntimeError("embedding 返回数量与输入数量不一致")
            for item in sorted(data, key=lambda value: value.get("index", 0)):
                vector = item.get("embedding")
                if not isinstance(vector, list) or len(vector) != FROZEN_DIM:
                    raise RuntimeError("embedding 维度不匹配冻结的 1024")
                vectors.append(vector)
            usage.append(body.get("usage"))
            timings.append(round(elapsed, 4))
        return vectors, {"usage": usage, "batch_seconds": timings}


class OpenSearchClient:
    def __init__(self, base):
        self.base = base.rstrip("/")

    def call(self, path, method="GET", payload=None, timeout=120):
        status, body, elapsed = request_json(self.base + path, method, payload,
                                             timeout=timeout)
        if status is None or status >= 300:
            raise RuntimeError(f"OpenSearch {method} {path} HTTP {status}: {body}")
        return body, elapsed

    def create(self, index):
        mapping = {
            "settings": {"index": {"knn": True}},
            "mappings": {"properties": {
                "chunk_id": {"type": "keyword"},
                "artifact": {"type": "keyword"},
                "parent_id": {"type": "keyword"},
                "retrieval_kind": {"type": "keyword"},
                "embedding": {"type": "knn_vector", "dimension": FROZEN_DIM,
                              "method": {"name": "hnsw", "engine": "lucene",
                                          "space_type": "cosinesimil",
                                          "parameters": {"m": 16,
                                                         "ef_construction": 128}}},
            }}}
        self.call(f"/{index}", method="PUT", payload=mapping)

    def bulk(self, index, rows):
        lines = []
        for row in rows:
            lines.append(json.dumps({"index": {"_index": index,
                                                "_id": row["chunk_id"]}},
                                    ensure_ascii=False))
            lines.append(json.dumps(row, ensure_ascii=False))
        body = ("\n".join(lines) + "\n").encode("utf-8")
        request = urllib.request.Request(self.base + "/_bulk", data=body,
                                         method="POST")
        request.add_header("Content-Type", "application/x-ndjson")
        started = time.perf_counter()
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read().decode("utf-8"))
        elapsed = time.perf_counter() - started
        if payload.get("errors"):
            raise RuntimeError(f"OpenSearch bulk 写入失败: {payload}")
        return {"request_bytes": len(body), "seconds": round(elapsed, 4),
                "items": len(rows)}

    def search(self, index, vector, size=5):
        body = {"size": size, "_source": ["chunk_id", "parent_id", "artifact",
                                               "retrieval_kind"],
                "query": {"knn": {"embedding": {"vector": vector, "k": size}}}}
        response, elapsed = self.call(f"/{index}/_search", method="POST",
                                      payload=body, timeout=120)
        hits = response.get("hits", {}).get("hits", [])
        return hits, round(elapsed, 4)

    def cleanup(self, index):
        request_json(self.base + f"/{index}", method="DELETE", timeout=30)


def evaluate_recall(questions, artifacts, chunks, client, search_client, index):
    question_vectors, embedding_meta = client.embed(
        [item.get("question", "") for item in questions])
    by_id = {chunk["chunk_id"]: chunk for chunk in chunks}
    by_parent = {}
    for chunk in chunks:
        if chunk.get("parent_id"):
            by_parent.setdefault(chunk["parent_id"], []).append(chunk)
    hits = 0
    rows = []
    query_seconds = []
    for question, vector in zip(questions, question_vectors):
        expected = resolve_targets(question, artifacts)
        search_hits, elapsed = search_client.search(index, vector, 5)
        query_seconds.append(elapsed)
        returned = []
        for hit in search_hits:
            source = hit.get("_source") or {}
            chunk = by_id.get(source.get("chunk_id") or hit.get("_id"))
            if not chunk:
                continue
            returned.append(chunk)
            if chunk.get("parent_id"):
                returned.extend(by_parent.get(chunk["parent_id"], []))
        matched = any(chunk["artifact"] in expected and
                      set(chunk["source_block_indices"]) & expected[chunk["artifact"]]
                      for chunk in returned)
        hits += int(matched)
        rows.append({"id": question.get("id"), "matched": matched,
                     "returned_chunk_ids": [item["chunk_id"] for item in returned[:5]],
                     "expected": {artifact: sorted(indices)
                                  for artifact, indices in expected.items()}})
    return {
        "recall_at_5": round(hits / len(questions), 4) if questions else 0.0,
        "questions": len(questions),
        "query_seconds": query_seconds,
        "query_p95_seconds": percentile(query_seconds, 0.95),
        "rows": rows,
        "embedding": embedding_meta,
    }


def percentile(values, quantile):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * fraction, 4)


def validate_artifacts(artifacts):
    failures = []
    for artifact in artifacts:
        required = ("content_hash", "parser_version", "normalized_content",
                    "blocks", "quality")
        missing = [key for key in required if key not in artifact]
        if missing:
            failures.append(f"{artifact.get('filename')}: ParseArtifact 缺字段 {missing}")
        if artifact.get("tokenizer_mode") != "infinity":
            failures.append(f"{artifact.get('filename')}: tokenizer_mode={artifact.get('tokenizer_mode')}，"
                            "真实 tokenizer 未满足冻结前置条件")
    return failures


def run(args):
    artifacts = load_artifacts(args.artifacts)
    questions = load_golden(args.golden)
    failures = validate_artifacts(artifacts)
    if not artifacts:
        failures.append("没有找到 PROBE-002 原始 ParseArtifact JSON")
    if not questions:
        failures.append("没有提供黄金题子集；Recall@5 无法计算")
    artifact_filenames = {artifact.get("filename") for artifact in artifacts}
    for question in questions:
        for filename in (question.get("targets") or []):
            if filename.get("artifact") not in artifact_filenames:
                failures.append(f"黄金题 {question.get('id')} 引用了不存在的文档 "
                                f"{filename.get('artifact')}")
    candidates = []
    real_ready = bool(artifacts and questions and not failures and args.embed_key
                      and args.opensearch)
    if not args.embed_key:
        failures.append("缺少 OPENROUTER_API_KEY/EMBED_API_KEY，未执行付费 Embedding")
    if not args.opensearch:
        failures.append("缺少 OPENSEARCH_PROBE_URL，未执行真实 OpenSearch")
    versions = {
        "python": platform.python_version(),
        "parser": sorted({artifact.get("parser_version") for artifact in artifacts
                          if artifact.get("parser_version")}),
        "tokenizer_mode": sorted({artifact.get("tokenizer_mode") for artifact in artifacts
                                  if artifact.get("tokenizer_mode")}),
        "opensearch": "not_probed",
        "embedding_model": args.embed_model,
    }
    if real_ready:
        try:
            cluster, _ = OpenSearchClient(args.opensearch).call("/")
            versions["opensearch"] = (cluster.get("version") or {}).get(
                "number", "unknown")
        except Exception as error:  # noqa: BLE001
            failures.append(f"OpenSearch 版本探测失败: {error}")
            real_ready = False
    for candidate in DEFAULT_CANDIDATES:
        candidate_result = {"name": candidate["name"], "manifest": candidate,
                            "chunking": [], "retrieval": None, "failures": []}
        chunks = []
        for artifact in artifacts:
            chunks.extend(chunk_artifact(artifact, candidate))
        candidate_result["chunking"] = citation_metrics(chunks, artifacts)
        candidate_result["chunking"]["deterministic"] = (
            [item["chunk_id"] for item in chunks] == [item["chunk_id"] for item in
                                                       sum((chunk_artifact(artifact, candidate)
                                                            for artifact in artifacts), [])])
        candidate_result["index"] = {"estimated_bytes": len(canonical_json(chunks).encode()),
                                     "write_seconds": None, "stored_bytes": None}
        if real_ready:
            index_name = "probe006_" + args.run_id + "_" + candidate["name"].replace("_", "-")
            search_client = OpenSearchClient(args.opensearch)
            try:
                embed_client = EmbeddingClient(args.embed_base, args.embed_model,
                                               args.embed_key)
                texts = [chunk["embedding_text"] for chunk in chunks
                         if not candidate["parent_child"] or chunk.get("retrieval_kind") != "parent"]
                vectors, embedding_meta = embed_client.embed(texts)
                index_rows = []
                vector_index = 0
                for chunk in chunks:
                    if candidate["parent_child"] and chunk.get("retrieval_kind") == "parent":
                        continue
                    row = {"chunk_id": chunk["chunk_id"], "parent_id": chunk.get("parent_id"),
                           "artifact": chunk["artifact"],
                           "retrieval_kind": chunk.get("retrieval_kind"),
                           "embedding": vectors[vector_index]}
                    vector_index += 1
                    index_rows.append(row)
                search_client.create(index_name)
                candidate_result["index"].update(search_client.bulk(index_name, index_rows))
                candidate_result["retrieval"] = evaluate_recall(
                    questions, artifacts, chunks, embed_client, search_client, index_name)
                candidate_result["retrieval"]["embedding_write"] = embedding_meta
            except Exception as error:  # noqa: BLE001
                candidate_result["failures"].append(str(error))
                failures.append(f"{candidate['name']}: 真实检索失败: {error}")
            finally:
                search_client.cleanup(index_name)
        candidates.append(candidate_result)

    successful = [item for item in candidates if item["retrieval"] and
                  not item["failures"]]
    eligible = [item for item in successful
                if item["retrieval"]["recall_at_5"] >= args.recall_target and
                item["chunking"]["citation_locatable_rate"] >= args.citation_target and
                item["chunking"]["truncation_rate"] <= args.truncation_limit and
                item["chunking"]["deterministic"]]
    status = "PASS" if eligible else "BLOCKED"
    decisions_taken = []
    decisions_required = []
    frozen = None
    if eligible:
        selected = sorted(eligible, key=lambda item: (
            item["index"]["estimated_bytes"], item["retrieval"]["query_p95_seconds"]
            or float("inf")))[0]
        frozen = selected["manifest"]
        frozen["tokenizer_mode"] = "infinity"
        frozen["embedding_dimensions"] = FROZEN_DIM
        frozen["embedding_version"] = args.embed_model
        frozen["index_schema_version"] = "opensearch-knn-lucene-hnsw-v1"
        decisions_taken.append(f"冻结候选：{selected['name']}")
        parent_results = [item for item in successful
                          if item["manifest"].get("parent_child")]
        if parent_results and max(item["retrieval"]["recall_at_5"]
                                  for item in parent_results) < selected["retrieval"]["recall_at_5"]:
            status = "PASS_WITH_ADJUSTMENT"
            decisions_taken.append("parent-child 未优于叶块检索，阶段 1 不启用父子分块")
            frozen["parent_child"] = False
    else:
        decisions_required.append(
            "不得冻结 ChunkingManifest；T1b、T5、T6 继续等待真实输入与检索结果")
    environment = {"opensearch": args.opensearch or "missing",
                   "embedding_base": args.embed_base,
                   "embedding_model": args.embed_model,
                   "embedding_dimensions": FROZEN_DIM}
    inputs = {"artifact_dir": args.artifacts, "artifact_count": len(artifacts),
              "golden_path": args.golden, "golden_count": len(questions),
              "candidate_count": len(candidates)}
    report = {
        "probe_id": "PROBE-006",
        "status": status,
        "executed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "environment_fingerprint": fingerprint(environment),
        "input_fingerprint": fingerprint({"artifacts": artifacts,
                                           "questions": questions,
                                           "candidate_manifests": DEFAULT_CANDIDATES}),
        "versions": versions,
        "environment": environment,
        "inputs": inputs,
        "measurements": {"candidate_count": len(candidates),
                         "eligible_count": len(eligible),
                         "selected_candidate": frozen.get("name") if frozen else None},
        "candidates": candidates,
        "frozen_chunking_manifest": frozen,
        "ingestion_manifest_fields": ["parserRef", "chunkerRef", "embeddingRef",
                                       "indexSchemaRef", "contentHash"],
        "failures": failures,
        "decisions_taken": decisions_taken,
        "decisions_required": decisions_required,
        "recommendation": ("采用 wide-1024，阶段 1 不启用 parent-child"
                           if frozen else "补齐真实输入与检索依赖后复跑"),
    }
    return report


def write_report(report, output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.with_suffix(".json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# PROBE-006 分块策略与引用定位探针结果", "",
             f"- 状态：**{report['status']}**",
             f"- 执行时间：{report['executed_at']}",
             f"- ParseArtifact：{report['inputs']['artifact_count']} 份",
             f"- 黄金题：{report['inputs']['golden_count']} 题", "",
             "> Recall@5 只有真实 Embedding + OpenSearch 路径才计入；本地分块统计不替代真实检索。", "",
             "## 参数对比", "",
             "| 候选 | 块数 | 引用可定位率 | 截断率 | 确定性 | Recall@5 | 索引估算字节 | 写入秒 |",
             "|---|---:|---:|---:|---|---:|---:|---:|"]
    for candidate in report["candidates"]:
        chunking = candidate["chunking"]
        retrieval = candidate.get("retrieval") or {}
        lines.append("| {} | {} | {} | {} | {} | {} | {} | {} |".format(
            candidate["name"], chunking.get("chunk_count", "-"),
            chunking.get("citation_locatable_rate", "-"),
            chunking.get("truncation_rate", "-"),
            "是" if chunking.get("deterministic") else "否",
            retrieval.get("recall_at_5", "N/A"),
            candidate["index"].get("estimated_bytes", "-"),
            candidate["index"].get("write_seconds",
                                    candidate["index"].get("seconds", "N/A"))))
    lines.extend(["", "## 冻结结果", "",
                   "```json",
                   json.dumps(report["frozen_chunking_manifest"], ensure_ascii=False,
                              indent=2) if report["frozen_chunking_manifest"] else "null",
                   "```", ""])
    if report["failures"]:
        lines.extend(["## 失败项", ""])
        lines.extend(f"- {failure}" for failure in report["failures"])
        lines.append("")
    if report["decisions_taken"]:
        lines.extend(["## 决策", ""])
        lines.extend(f"- {decision}" for decision in report["decisions_taken"])
        lines.append("")
    if report["decisions_required"]:
        lines.extend(["## 待决策", ""])
        lines.extend(f"- {decision}" for decision in report["decisions_required"])
        lines.append("")
    output.with_suffix(".md").write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", required=True)
    parser.add_argument("--golden", required=True)
    parser.add_argument("--out", required=True,
                        help="不带扩展名的报告路径")
    parser.add_argument("--embed-base", default=os.environ.get(
        "OPENROUTER_BASE", "https://openrouter.ai/api/v1"))
    parser.add_argument("--embed-model", default=os.environ.get(
        "EMBED_MODEL", "qwen/qwen3-embedding-8b"))
    parser.add_argument("--embed-key", default=os.environ.get(
        "OPENROUTER_API_KEY") or os.environ.get("EMBED_API_KEY"))
    parser.add_argument("--opensearch", default=os.environ.get("OPENSEARCH_PROBE_URL"))
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"))
    parser.add_argument("--recall-target", type=float, default=0.92)
    parser.add_argument("--citation-target", type=float, default=0.96)
    parser.add_argument("--truncation-limit", type=float, default=0.05)
    args = parser.parse_args()
    report = run(args)
    write_report(report, args.out)
    print(f"PROBE-006 status: {report['status']}")
    for failure in report["failures"]:
        print(f"  FAIL: {failure}")
    return 0 if report["status"] != "BLOCKED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
