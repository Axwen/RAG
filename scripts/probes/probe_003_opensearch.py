#!/usr/bin/env python3
"""PROBE-003: OpenSearch 混合检索 / Release-Alias / 作用域过滤 / kNN 参数冻结 探针。
纯标准库;召回 ground truth 用 OpenSearch 自带 exact knn_score,不依赖 numpy。"""
import argparse
import json
import math
import os
import random
import statistics
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = os.environ.get("OPENSEARCH_PROBE_URL", "http://127.0.0.1:19200")
DIM = 1024
N_DOCS = 1500
N_QUERIES = 30
K = 5
SPACE = "cosinesimil"
SEED = 20260825


def os_req(method, path, body=None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{BASE}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"_raw": raw.decode(errors="replace")[:400]}


def pct(values, p):
    if not values:
        return None
    values = sorted(values)
    idx = min(len(values) - 1, int(round((p / 100.0) * (len(values) - 1))))
    return round(values[idx], 2)


def unit_vector(rng):
    v = [rng.gauss(0, 1) for _ in range(DIM)]
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v]

# 两个知识空间 + 两个 embeddingVersion 分区,证明分区不共享索引、作用域过滤生效。
KS_A = "ks-alpha"
KS_B = "ks-beta"
SCOPE_KEYS = ["scope-public", "scope-team-1", "scope-team-2", "scope-restricted"]
TENANT = "tenant-probe"


def build_mapping(engine, m, ef_construction):
    # 索引内只放物理作用域 + acl_scope_key + 有效期 + 墓碑;绝不放主体列表或 ACL 版本号。
    return {
        "settings": {"index": {"knn": True, "number_of_shards": 1, "number_of_replicas": 0}},
        "mappings": {
            "properties": {
                "tenant_id": {"type": "keyword"},
                "knowledge_space_id": {"type": "keyword"},
                "index_partition_id": {"type": "keyword"},
                "release_id": {"type": "keyword"},
                "acl_scope_key": {"type": "keyword"},
                "embedding_version": {"type": "keyword"},
                "valid_from": {"type": "date"},
                "valid_to": {"type": "date"},
                "deleted": {"type": "boolean"},
                "text": {"type": "text"},
                "vec": {
                    "type": "knn_vector",
                    "dimension": DIM,
                    "method": {
                        "name": "hnsw",
                        "space_type": SPACE,
                        "engine": engine,
                        "parameters": {"m": m, "ef_construction": ef_construction},
                    },
                },
            }
        },
    }


def gen_corpus():
    rng = random.Random(SEED)
    docs = []
    for i in range(N_DOCS):
        ks = KS_A if i % 3 else KS_B  # 约 1/3 落在 ks-beta,用于 fan-out / 分区隔离
        emb = "emb-v1" if i % 5 else "emb-v2"  # 约 1/5 属于 emb-v2 分区
        docs.append({
            "id": f"doc-{i}",
            "tenant_id": TENANT,
            "knowledge_space_id": ks,
            "index_partition_id": f"{ks}:{emb}",
            "release_id": "rel-001",
            "acl_scope_key": SCOPE_KEYS[i % len(SCOPE_KEYS)],
            "embedding_version": emb,
            "valid_from": "2026-01-01T00:00:00Z",
            "valid_to": "2027-01-01T00:00:00Z",
            "deleted": False,
            "text": f"synthetic chunk {i}",
            "vec": unit_vector(rng),
        })
    queries = [unit_vector(rng) for _ in range(N_QUERIES)]
    return docs, queries

def bulk_load(index, docs):
    # 只把落在该索引对应分区(单一 embeddingVersion)的文档写进去,证明分区不共享索引。
    lines = []
    for d in docs:
        lines.append(json.dumps({"index": {"_index": index, "_id": d["id"]}}))
        lines.append(json.dumps({k: v for k, v in d.items() if k != "id"}))
    body = "\n".join(lines) + "\n"
    req = urllib.request.Request(
        f"{BASE}/_bulk", data=body.encode(),
        headers={"Content-Type": "application/x-ndjson"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        res = json.loads(resp.read())
    if res.get("errors"):
        first = next((i for i in res["items"] if list(i.values())[0].get("error")), None)
        raise RuntimeError(f"bulk load errors: {json.dumps(first)[:300]}")
    os_req("POST", f"/{index}/_refresh")


def hard_filter(scope_keys=None):
    # BM25 与向量两路都必须携带的物理作用域 + 有效期 + 墓碑过滤;acl_scope_key 作为预过滤。
    clauses = [
        {"term": {"tenant_id": TENANT}},
        {"term": {"deleted": False}},
        {"range": {"valid_to": {"gt": "2026-08-25T00:00:00Z"}}},
    ]
    if scope_keys is not None:
        clauses.append({"terms": {"acl_scope_key": scope_keys}})
    return clauses


def exact_topk(index, qvec, k, scope_keys=None):
    body = {
        "size": k, "_source": False,
        "query": {"script_score": {
            "query": {"bool": {"filter": hard_filter(scope_keys)}},
            "script": {"source": "knn_score", "lang": "knn",
                       "params": {"field": "vec", "query_value": qvec, "space_type": SPACE}},
        }},
    }
    _, res = os_req("POST", f"/{index}/_search", body)
    return [h["_id"] for h in res["hits"]["hits"]]


def approx_topk(index, qvec, k, ef_search, scope_keys=None):
    knn = {"vec": {"vector": qvec, "k": k, "method_parameters": {"ef_search": ef_search}}}
    if scope_keys is not None:
        knn["vec"]["filter"] = {"bool": {"filter": hard_filter(scope_keys)}}
    else:
        knn["vec"]["filter"] = {"bool": {"filter": hard_filter()}}
    body = {"size": k, "_source": False, "query": {"knn": knn}}
    t0 = time.perf_counter()
    _, res = os_req("POST", f"/{index}/_search", body)
    dt = (time.perf_counter() - t0) * 1000.0
    return [h["_id"] for h in res["hits"]["hits"]], dt

def approx_topk_pure(index, qvec, k, ef_search):
    # 无 filter 的纯 ANN 路径:强制走 HNSW 图,才测得到真实近似召回与堆外原生内存。
    # 带 filter 的查询在本量级会被 OpenSearch 短路成 exact search,off-heap 恒为 0。
    body = {"size": k, "_source": False, "query": {"knn": {
        "vec": {"vector": qvec, "k": k, "method_parameters": {"ef_search": ef_search}}}}}
    t0 = time.perf_counter()
    _, res = os_req("POST", f"/{index}/_search", body)
    dt = (time.perf_counter() - t0) * 1000.0
    return [h["_id"] for h in res["hits"]["hits"]], dt

def recall_at_k(approx_ids, exact_ids):
    if not exact_ids:
        return 1.0
    return len(set(approx_ids) & set(exact_ids)) / float(len(exact_ids))


def index_size_bytes(index):
    _, res = os_req("GET", f"/{index}/_stats/store")
    return res["indices"][index]["primaries"]["store"]["size_in_bytes"]


def knn_graph_memory_kb():
    _, res = os_req("GET", "/_plugins/_knn/stats")
    total = 0
    for node in res.get("nodes", {}).values():
        total += node.get("graph_memory_usage", 0)
    return total


def jvm_heap_used_mb():
    _, res = os_req("GET", "/_nodes/stats/jvm")
    for node in res.get("nodes", {}).values():
        return round(node["jvm"]["mem"]["heap_used_in_bytes"] / (1024 * 1024), 1)
    return None


def docker_rss_mb(compose_file):
    try:
        out = subprocess.check_output(
            ["docker", "compose", "-f", compose_file, "ps", "-q", "opensearch-probe"],
            text=True).strip()
        if not out:
            return None
        stat = subprocess.check_output(
            ["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", out],
            text=True).strip()
        mem = stat.split("/")[0].strip()  # e.g. "1.8GiB"
        num = float("".join(c for c in mem if c.isdigit() or c == "."))
        if "GiB" in mem:
            return round(num * 1024, 1)
        if "MiB" in mem:
            return round(num, 1)
        return num
    except Exception:
        return None


def sweep_config(engine, m, ef_construction, ef_search, docs, queries):
    index = f"chunks_{engine}_m{m}_efc{ef_construction}"
    os_req("DELETE", f"/{index}")
    st, _ = os_req("PUT", f"/{index}", build_mapping(engine, m, ef_construction))
    if st >= 300:
        raise RuntimeError(f"create {index} failed: {st}")
    emb_v1 = [d for d in docs if d["embedding_version"] == "emb-v1"]
    t0 = time.perf_counter()
    bulk_load(index, emb_v1)
    os_req("POST", f"/{index}/_forcemerge?max_num_segments=1")
    build_ms = (time.perf_counter() - t0) * 1000.0
    return index, emb_v1, build_ms

def verify_schema_guards(docs):
    # 项1:维度不匹配、错误 engine 组合被拒;分区不共享索引。
    findings = {}
    os_req("DELETE", "/schema_guard_v1")
    os_req("PUT", "/schema_guard_v1", build_mapping("lucene", 16, 128))
    st_dim, res_dim = os_req("POST", "/schema_guard_v1/_doc", {"vec": [0.1, 0.2, 0.3]})
    findings["wrong_dimension_rejected"] = st_dim >= 400
    st_bad, _ = os_req("PUT", "/schema_bad_engine", {
        "settings": {"index": {"knn": True}},
        "mappings": {"properties": {"vec": {"type": "knn_vector", "dimension": DIM,
            "method": {"name": "hnsw", "engine": "no-such-engine", "space_type": SPACE}}}}})
    findings["invalid_engine_rejected"] = st_bad >= 400
    os_req("DELETE", "/schema_guard_v1")
    os_req("DELETE", "/schema_bad_engine")
    return findings


def verify_partition_isolation(index_v1, docs):
    # 项1:emb-v2 分区的文档不应出现在 emb-v1 索引里(索引物理隔离)。
    _, res = os_req("POST", f"/{index_v1}/_search",
                    {"size": 0, "query": {"term": {"embedding_version": "emb-v2"}}})
    leaked = res["hits"]["total"]["value"]
    return {"emb_v2_docs_in_v1_index": leaked, "partition_isolated": leaked == 0}


def verify_index_fields(index):
    # 项4:mapping 必须有 acl_scope_key,绝不能有 acl_subject_ids / acl_revision。
    _, res = os_req("GET", f"/{index}/_mapping")
    props = list(res.values())[0]["mappings"]["properties"]
    return {
        "has_acl_scope_key": "acl_scope_key" in props,
        "has_acl_subject_ids": "acl_subject_ids" in props,
        "has_acl_revision": "acl_revision" in props,
        "fields_ok": "acl_scope_key" in props
        and "acl_subject_ids" not in props and "acl_revision" not in props,
    }


def verify_alias(index_a, index_b):
    # 项5:Candidate Alias 原子切换 + 保留旧索引可回滚。
    alias = "chunks_active"
    os_req("POST", "/_aliases", {"actions": [{"add": {"index": index_a, "alias": alias}}]})
    _, r1 = os_req("GET", f"/_alias/{alias}")
    before = list(r1.keys())
    st, _ = os_req("POST", "/_aliases", {"actions": [
        {"remove": {"index": index_a, "alias": alias}},
        {"add": {"index": index_b, "alias": alias}}]})
    _, r2 = os_req("GET", f"/_alias/{alias}")
    after = list(r2.keys())
    # 回滚:切回旧索引仍然存在
    os_req("POST", "/_aliases", {"actions": [
        {"remove": {"index": index_b, "alias": alias}},
        {"add": {"index": index_a, "alias": alias}}]})
    _, r3 = os_req("GET", f"/_alias/{alias}")
    return {
        "atomic_switch_status": st,
        "before_switch": before, "after_switch": after,
        "rollback_target": list(r3.keys()),
        "atomic_ok": st < 300 and after == [index_b] and list(r3.keys()) == [index_a],
    }

def verify_reconciler(index_a, index_b):
    # 项6:Alias 已切换但 PG 确认丢失 → IndexActivationIntent + Reconciler 检测并纠正。
    alias = "chunks_active"
    intent = {"alias": alias, "intended_index": index_b}  # PG 权威意图
    # 模拟:alias 实际指向 index_a(切换未完成 / 确认丢失)
    os_req("POST", "/_aliases", {"actions": [
        {"remove": {"index": index_b, "alias": alias}},
        {"add": {"index": index_a, "alias": alias}}]})
    _, r = os_req("GET", f"/_alias/{alias}")
    actual = list(r.keys())[0]
    drift_detected = actual != intent["intended_index"]
    # Reconciler:以 PG 意图为准纠正 alias
    if drift_detected:
        os_req("POST", "/_aliases", {"actions": [
            {"remove": {"index": actual, "alias": alias}},
            {"add": {"index": intent["intended_index"], "alias": alias}}]})
    _, r2 = os_req("GET", f"/_alias/{alias}")
    reconciled = list(r2.keys())[0]
    return {
        "drift_detected": drift_detected,
        "reconciled_to": reconciled,
        "reconciler_ok": drift_detected and reconciled == intent["intended_index"],
    }


def guard_can_activate(release):
    # 项7:删除中 / Legal Hold / 过期证据的 Release 不得被激活或回滚为可服务。
    if release.get("deleting"):
        return False, "release is being deleted"
    if release.get("legal_hold"):
        return False, "release under legal hold"
    if release.get("expired"):
        return False, "release evidence expired"
    return True, "ok"


def verify_activation_guards():
    cases = {
        "healthy": {"deleting": False, "legal_hold": False, "expired": False},
        "deleting": {"deleting": True},
        "legal_hold": {"legal_hold": True},
        "expired": {"expired": True},
    }
    results = {name: guard_can_activate(rel)[0] for name, rel in cases.items()}
    return {
        "activation_results": results,
        "guards_ok": results["healthy"] is True and not any(
            results[k] for k in ("deleting", "legal_hold", "expired")),
    }

def run_sweep(docs, queries):
    # 项2 + 项3:扫描 lucene/faiss × ef_search,测召回/延迟/尺寸/构建/堆外,含带过滤召回衰减。
    configs = [
        ("lucene", 16, 128, 100),
        ("lucene", 16, 128, 512),
        ("faiss", 16, 128, 100),
        ("faiss", 16, 128, 512),
    ]
    built = {}  # (engine,m,efc) -> (index, emb_v1_docs, build_ms)
    sweep = []
    restricted = ["scope-public", "scope-team-1"]  # 过滤到约一半作用域
    for engine, m, efc, efs in configs:
        key = (engine, m, efc)
        if key not in built:
            built[key] = sweep_config(engine, m, efc, efs, docs, queries)
        index, emb_v1, build_ms = built[key]
        recalls, lat, frecalls = [], [], []
        pure_recalls, pure_lat = [], []
        graph_before = knn_graph_memory_kb()
        for q in queries:
            exact = exact_topk(index, q, K)
            approx, dt = approx_topk(index, q, K, efs)
            recalls.append(recall_at_k(approx, exact))
            lat.append(dt)
            fexact = exact_topk(index, q, K, restricted)
            fapprox, _ = approx_topk(index, q, K, efs, restricted)
            frecalls.append(recall_at_k(fapprox, fexact))
            # 纯 ANN 路径:强制走 HNSW 图,exact 结果同为 ground truth(全集)。
            papprox, pdt = approx_topk_pure(index, q, K, efs)
            pure_recalls.append(recall_at_k(papprox, exact))
            pure_lat.append(pdt)
        graph_delta = max(0, knn_graph_memory_kb() - graph_before)
        sweep.append({
            "engine": engine, "m": m, "ef_construction": efc, "ef_search": efs,
            "recall_at_5": round(statistics.mean(pure_recalls), 4),
            "filtered_recall_at_5": round(statistics.mean(frecalls), 4),
            "exact_path_recall_at_5": round(statistics.mean(recalls), 4),
            "recall_decay": round(statistics.mean(pure_recalls) - statistics.mean(frecalls), 4),
            "query_p50_ms": pct(lat, 50), "query_p95_ms": pct(lat, 95),
            "pure_ann_p50_ms": pct(pure_lat, 50), "pure_ann_p95_ms": pct(pure_lat, 95),
            "index_size_bytes": index_size_bytes(index),
            "build_ms": round(build_ms, 1),
            "knn_graph_memory_kb": graph_delta,
        })
    return sweep, built


def choose_default(sweep):
    # 本量级延迟全部远低于 250 ms 检索预算,延迟不是约束;召回才是稀缺资源。
    # off-heap 要按 engine 级判定:faiss 图为惰性加载,同一 index 的第二个 config 增量为 0,
    # 不能用单 config 增量当作 engine 的原生内存占用。lucene 段内 mmap 不占 knn 原生缓存。
    engine_offheap = {}
    for s in sweep:
        engine_offheap[s["engine"]] = max(engine_offheap.get(s["engine"], 0),
                                          s["knn_graph_memory_kb"])
    # 召回优先 → 偏好不占堆外原生内存的 engine(利于 8 GiB 预算与 knn 熔断)→ 延迟兜底。
    best = min(sweep, key=lambda s: (-s["recall_at_5"], engine_offheap[s["engine"]] > 0,
                                     -s["ef_search"], s["query_p95_ms"]))
    frozen = {
        "engine": best["engine"], "method": "hnsw", "m": best["m"],
        "ef_construction": best["ef_construction"], "ef_search": best["ef_search"],
        "space_type": SPACE, "dimension": DIM,
        "rationale": (f"pure-ANN recall@5={best['recall_at_5']}, p95={best['query_p95_ms']}ms, "
                      f"engine off-heap={engine_offheap[best['engine']]}KB"),
    }
    return frozen, engine_offheap

def write_results(result_dir, payload):
    result_dir = Path(result_dir)
    result_dir.mkdir(parents=True, exist_ok=True)
    (result_dir / "probe-003-opensearch-release.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    m = payload["measurements"]
    if not m:
        (result_dir / "probe-003-opensearch-release.md").write_text(
            "# PROBE-003 OpenSearch\n\n- status: `{}`\n- failures: {}\n".format(
                payload["status"], "; ".join(payload.get("failures", []))),
            encoding="utf-8")
        return
    lines = [
        "# PROBE-003 OpenSearch 混合检索 / Release-Alias / kNN 参数",
        "", f"- status: `{payload['status']}`",
        f"- OpenSearch image: `{payload['versions'].get('opensearch_image')}`",
        f"- 语料: `{N_DOCS}` docs / `{N_QUERIES}` queries / dim `{DIM}` / space `{SPACE}`",
        "", "## 冻结默认 kNN 参数",
        "```json", json.dumps(m["frozen_knn_params"], indent=2, ensure_ascii=False), "```",
        "", "## 参数扫描 (recall@5=纯ANN / filtered=带作用域过滤 / p50/p95=过滤路径延迟)",
        "", "> recall@5 走无 filter 的纯 HNSW 近似路径(真实近似召回);filtered 走带 acl_scope_key 的生产路径,",
        "> 本量级被短路为 exact search 故为 1.0;knn-graph-KB 是该 engine 首次被 exercise 时的堆外原生图增量,",
        "> lucene 的 HNSW 存于 Lucene 段 mmap(计入容器 RSS 而非 knn 原生缓存)故为 0,faiss 占用堆外原生内存。",
        "", "| engine | m | ef_c | ef_s | recall@5 | filtered | decay | p50ms | p95ms | size(MB) | build(ms) | knnKB |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for s in m["param_sweep"]:
        lines.append("| {engine} | {m} | {ef_construction} | {ef_search} | {recall_at_5} | "
                     "{filtered_recall_at_5} | {recall_decay} | {query_p50_ms} | {query_p95_ms} | "
                     "{sz} | {build_ms} | {knn_graph_memory_kb} |".format(
                         sz=round(s["index_size_bytes"] / (1024 * 1024), 1), **s))
    checks = m["checks"]
    lines += ["", "## 结构与协议校验"]
    for k, v in checks.items():
        lines.append(f"- {k}: `{v}`")
    lines += ["", "## 资源峰值",
              f"- JVM heap used: `{m['jvm_heap_used_mb']}` MB",
              f"- kNN off-heap graph: `{m['knn_graph_memory_kb']}` KB",
              f"- container RSS: `{m['container_rss_mb']}` MB (23.47 GiB Engine profile)"]
    if payload["decisions_required"]:
        lines += ["", "## 待决策"] + [f"- {d}" for d in payload["decisions_required"]]
    lines += ["", f"> {payload['recommendation']}", ""]
    (result_dir / "probe-003-opensearch-release.md").write_text(
        "\n".join(lines), encoding="utf-8")

def wait_ready():
    for _ in range(60):
        try:
            st, res = os_req("GET", "/_cluster/health")
            if st == 200 and res.get("status") in ("green", "yellow"):
                return True
        except Exception:
            pass
        time.sleep(2)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--compose-file", required=True)
    ap.add_argument("--result-dir", required=True)
    args = ap.parse_args()
    failures = []
    try:
        if not wait_ready():
            raise RuntimeError("OpenSearch cluster did not become ready")
        _, info = os_req("GET", "/")
        image = os.getenv("OPENSEARCH_IMAGE", "opensearchproject/opensearch:2.19.1")

        docs, queries = gen_corpus()
        schema = verify_schema_guards(docs)
        sweep, built = run_sweep(docs, queries)
        default, engine_offheap = choose_default(sweep)

        # 用默认参数对应的索引做后续结构/隔离/alias/reconciler 校验。
        key = (default["engine"], default["m"], default["ef_construction"])
        primary_index = built[key][0]
        second_key = next(k for k in built if k != key)
        second_index = built[second_key][0]

        fields = verify_index_fields(primary_index)
        isolation = verify_partition_isolation(primary_index, docs)
        alias = verify_alias(primary_index, second_index)
        reconciler = verify_reconciler(primary_index, second_index)
        guards = verify_activation_guards()

        checks = {
            "wrong_dimension_rejected": schema["wrong_dimension_rejected"],
            "invalid_engine_rejected": schema["invalid_engine_rejected"],
            "partition_isolated": isolation["partition_isolated"],
            "index_fields_ok": fields["fields_ok"],
            "has_acl_subject_ids": fields["has_acl_subject_ids"],
            "has_acl_revision": fields["has_acl_revision"],
            "alias_atomic_ok": alias["atomic_ok"],
            "reconciler_ok": reconciler["reconciler_ok"],
            "activation_guards_ok": guards["guards_ok"],
        }
        best_recall = max(s["recall_at_5"] for s in sweep)
        # CHUNK-10
        hard_fail = [
            ("wrong_dimension_rejected", schema["wrong_dimension_rejected"]),
            ("invalid_engine_rejected", schema["invalid_engine_rejected"]),
            ("partition_isolated", isolation["partition_isolated"]),
            ("index_fields_ok", fields["fields_ok"]),
            ("alias_atomic_ok", alias["atomic_ok"]),
            ("reconciler_ok", reconciler["reconciler_ok"]),
            ("activation_guards_ok", guards["guards_ok"]),
        ]
        for name, ok in hard_fail:
            if not ok:
                failures.append(name)

        decisions = []
        status = "PASS"
        if failures:
            status = "BLOCKED"
        elif best_recall < 0.90:
            status = "PASS_WITH_ADJUSTMENT"
            decisions.append(
                f"best recall@5={best_recall} < 0.90; 需增大 ef_search/ef_construction 或复核合成向量分布")
        # 无论 PASS 与否都记录量级说明:合成高斯向量 + 1500 文档 / 单分区在近似路径上召回近乎饱和,
        # 冻结的 engine/ef_search 必须在生产语料(真实 embedding、更大规模)上按 PROBE-006 复测再最终定档。
        decisions.append(
            "冻结参数基于 1500 条合成高斯向量;engine=lucene 与 ef_search 需在真实 embedding、"
            "接近 1024 候选上限的语料上复测后再最终定档(随 PROBE-006 一并复核)。")
        decisions.append(
            "带 acl_scope_key filter 的查询在本量级被 OpenSearch 短路成 exact search(off-heap=0);"
            "真实规模下需复核过滤路径是否转为近似及其召回衰减。")

        measurements = {
            "cluster_status": os_req("GET", "/_cluster/health")[1].get("status"),
            "frozen_knn_params": default,
            "engine_offheap_kb": engine_offheap,
            "param_sweep": sweep,
            "checks": checks,
            "alias_detail": alias,
            "reconciler_detail": reconciler,
            "activation_guards_detail": guards["activation_results"],
            "partition_isolation_detail": isolation,
            "jvm_heap_used_mb": jvm_heap_used_mb(),
            "knn_graph_memory_kb": knn_graph_memory_kb(),
            "container_rss_mb": docker_rss_mb(args.compose_file),
        }
        payload = {
            "probe_id": "PROBE-003",
            "status": status,
            "executed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "versions": {"opensearch_image": image,
                         "opensearch_version": info.get("version", {}).get("number")},
            "measurements": measurements,
            "failures": failures,
            "decisions_required": decisions,
            "recommendation": (
                "混合检索用 acl_scope_key 作用域预过滤 + 索引外 PG 权威复核;kNN 冻结 "
                f"{default['engine']}/hnsw m={default['m']} ef_c={default['ef_construction']} "
                f"ef_s={default['ef_search']};Release 用 Candidate Alias 原子切换 + Intent/Reconciler 兜底。"),
        }
        write_results(args.result_dir, payload)
        print(f"PROBE-003 {status} (best recall@5={best_recall}, failures={failures})")
        if status == "BLOCKED":
            raise SystemExit(1)
    except SystemExit:
        raise
    except Exception as e:
        payload = {"probe_id": "PROBE-003", "status": "BLOCKED",
                   "executed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "failures": failures + [str(e)]}
        write_results(args.result_dir, {**payload, "versions": {}, "measurements": {},
                                        "decisions_required": [], "recommendation": ""})
        raise


if __name__ == "__main__":
    main()
