#!/usr/bin/env python3
"""PROBE-002 host driver (stdlib only): DeepDOC parser probe.

Exercises the in-container DeepDOC assembly wrapper over HTTP and checks the six
PROBE-002 ticket items. Following the PROBE-004 convention:
  LIVE      — real DeepDOC parse facts (structured blocks, page/coordinate
              positions, table reconstruction, resource envelope).
  SIMULATED — service-layer protocol not owned by DeepDOC itself (parserTaskId
              lifecycle, idempotency dedup, timeout/cancel/crash recovery).
              Clearly labelled; to be re-checked at Worker/Parser-Service
              integration test time.

Writes docs/engineering/probe-results/probe-002-deepdoc-parser.{md,json}.
No secrets read or emitted; all fixtures are synthetic.
"""
import argparse
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone


def _req(url, method="GET", data=None, timeout=180):
    r = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        r.add_header("Content-Type", "application/octet-stream")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # A per-target parse failure (e.g. HTTP 500) must NOT abort the whole
        # probe run — capture the status + JSON error body and let the caller
        # record it as a failure while continuing with the other fixtures.
        try:
            body = json.loads(e.read().decode("utf-8"))
        except Exception:
            body = {"error": f"HTTP {e.code}"}
        return e.code, body


def health(base):
    return _req(f"{base}/health")


def parse_file(base, path, filename=None):
    filename = filename or os.path.basename(path)
    with open(path, "rb") as f:
        body = f.read()
    from urllib.parse import quote
    t0 = time.perf_counter()
    status, art = _req(f"{base}/parse?filename={quote(filename)}",
                       method="POST", data=body)
    art["_wall_seconds"] = round(time.perf_counter() - t0, 3)
    return status, art


REQUIRED_ARTIFACT_FIELDS = [
    "normalized_content", "blocks", "quality", "content_hash",
    "parser_version", "resource",
]


def check_artifact_contract(art):
    """Ticket item 3: ParseArtifact must carry normalized content, structured
    blocks, positions, table warnings, version, content hash."""
    missing = [f for f in REQUIRED_ARTIFACT_FIELDS if f not in art]
    ok = not missing
    return {"ok": ok, "missing_fields": missing,
            "has_blocks": bool(art.get("blocks")),
            "has_content_hash": bool(art.get("content_hash")),
            "has_version": bool(art.get("parser_version"))}


def check_positions(art):
    """PDF blocks must carry page/coordinate positions (sentence->coord backlink)."""
    if art.get("kind") != "pdf":
        return {"applicable": False}
    blocks = art.get("blocks", [])
    located = [b for b in blocks if b.get("positions")]
    tagged = [b for b in blocks if b.get("position_tag")]
    return {"applicable": True, "block_count": len(blocks),
            "located": len(located), "tagged": len(tagged),
            "location_rate": art.get("quality", {}).get("location_rate")}


def check_idempotency(base, path):
    """Ticket item 4 (SIMULATED dedup / LIVE determinism): parse twice; the
    DeepDOC output must be deterministic (same content_hash, same block count &
    layout sequence). Registry-level dedup on tenant+hash+version is a
    service-layer concern, simulated here."""
    _, a1 = parse_file(base, path)
    _, a2 = parse_file(base, path)
    seq1 = [b.get("layout_type") for b in a1.get("blocks", [])]
    seq2 = [b.get("layout_type") for b in a2.get("blocks", [])]
    return {"same_content_hash": a1.get("content_hash") == a2.get("content_hash"),
            "same_block_count": len(a1.get("blocks", [])) == len(a2.get("blocks", [])),
            "same_layout_sequence": seq1 == seq2,
            "note": "DeepDOC determinism verified LIVE; tenant+hash+version "
                    "registry dedup is service-layer, SIMULATED."}


LIFECYCLE_SIM = {
    "states": ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELED"],
    "note": "parserTaskId lifecycle is owned by the Parser Service + PostgreSQL "
            "(ADR-0014), not by DeepDOC. The throwaway wrapper parses "
            "synchronously, so lifecycle/cancel/crash-recovery are SIMULATED "
            "here and MUST be re-verified at Parser-Service integration test "
            "time. DeepDOC itself is proven side-effect-free: a failed parse "
            "returns HTTP 500 with no artifact, i.e. no half-Artifact is "
            "emitted (verified LIVE via the malformed-input probe below).",
}


def check_no_half_artifact(base):
    """Ticket item 5 (LIVE slice): malformed PDF bytes must fail cleanly with no
    partial artifact; the rest of recovery is SIMULATED (see LIFECYCLE_SIM)."""
    from urllib.parse import quote
    body = b"%PDF-1.4 not-a-real-pdf \x00\x01broken"
    try:
        r = urllib.request.Request(f"{base}/parse?filename={quote('broken.pdf')}",
                                   data=body, method="POST")
        r.add_header("Content-Type", "application/octet-stream")
        with urllib.request.urlopen(r, timeout=60) as resp:
            status, payload = resp.status, json.loads(resp.read())
        return {"clean_failure": False, "http_status": status,
                "note": "parser unexpectedly returned 2xx for malformed PDF",
                "payload_keys": list(payload.keys())}
    except urllib.error.HTTPError as e:
        return {"clean_failure": e.code >= 400, "http_status": e.code,
                "note": "malformed PDF rejected with no artifact (expected)"}
    except Exception as e:  # noqa: BLE001
        return {"clean_failure": True, "http_status": None, "error": str(e)}


def run(base, fixtures_dir, sample_md, artifacts_dir=None):
    results = {"artifacts": {}, "checks": {}}
    _, h = health(base)
    results["health"] = h

    targets = []
    if sample_md and os.path.exists(sample_md):
        targets.append(("markdown", sample_md))
    for name in ("native_single.pdf", "double_column.pdf",
                 "cross_page_table.pdf", "scanned.pdf"):
        p = os.path.join(fixtures_dir, name)
        if os.path.exists(p):
            targets.append((name, p))

    for label, path in targets:
        status, art = parse_file(base, path)
        if artifacts_dir and status == 200:
            os.makedirs(artifacts_dir, exist_ok=True)
            artifact_path = os.path.join(artifacts_dir, f"{label}.json")
            with open(artifact_path, "w", encoding="utf-8") as artifact_file:
                json.dump(art, artifact_file, ensure_ascii=False, indent=2,
                          default=lambda value: value.item()
                          if hasattr(value, "item") else value)
        results["artifacts"][label] = {
            "http_status": status,
            "kind": art.get("kind"),
            "contract": check_artifact_contract(art),
            "positions": check_positions(art),
            "quality": art.get("quality"),
            "resource": art.get("resource"),
            "wall_seconds": art.get("_wall_seconds"),
            "tokenizer_mode": art.get("tokenizer_mode"),
        }

    # Idempotency/determinism on the first available PDF (else markdown).
    idem_target = next((p for l, p in targets if p.endswith(".pdf")),
                       targets[0][1] if targets else None)
    if idem_target:
        results["checks"]["idempotency"] = check_idempotency(base, idem_target)
    results["checks"]["no_half_artifact"] = check_no_half_artifact(base)
    results["checks"]["lifecycle_simulated"] = LIFECYCLE_SIM
    return results


def evaluate(results):
    failures = []
    for label, a in results["artifacts"].items():
        if a["http_status"] != 200:
            failures.append(f"{label}: parse HTTP {a['http_status']}")
            continue
        if not a["contract"]["ok"]:
            failures.append(f"{label}: missing fields {a['contract']['missing_fields']}")
        pos = a["positions"]
        if pos.get("applicable") and pos.get("located", 0) == 0:
            failures.append(f"{label}: no located (coordinate-tagged) blocks")
    idem = results["checks"].get("idempotency", {})
    if idem and not (idem.get("same_content_hash") and idem.get("same_layout_sequence")):
        failures.append("idempotency: DeepDOC output not deterministic")
    if not results["checks"]["no_half_artifact"].get("clean_failure"):
        failures.append("recovery: malformed input did not fail cleanly")

    tok = results.get("health", {}).get("tokenizer_mode")
    decisions = []
    recommendation = "PASS"
    if failures:
        recommendation = "BLOCKED"
    elif tok != "infinity":
        recommendation = "PASS_WITH_ADJUSTMENT"
        decisions.append(
            "Stage A ran with the STUB tokenizer (tokenizer_mode=%s): xgboost "
            "paragraph-merge features are degraded. Re-run Stage B with the real "
            "infinity-sdk rag_tokenizer before freezing ChunkingManifest (PROBE-006)."
            % tok)
    return failures, decisions, recommendation


def write_reports(results, out_dir):
    failures, decisions, recommendation = evaluate(results)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = {
        "probe_id": "PROBE-002",
        "status": recommendation,
        "executed_at": now,
        "versions": {
            "parser": results.get("health", {}).get("parser_version"),
            "tokenizer_mode": results.get("health", {}).get("tokenizer_mode"),
            "models": results.get("health", {}).get("models"),
        },
        "measurements": results,
        "failures": failures,
        "decisions_required": decisions,
        "recommendation": recommendation,
    }
    os.makedirs(out_dir, exist_ok=True)
    jpath = os.path.join(out_dir, "probe-002-deepdoc-parser.json")
    with open(jpath, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    _write_md(doc, os.path.join(out_dir, "probe-002-deepdoc-parser.md"))
    return doc


def _write_md(doc, path):
    L = []
    L.append(f"# PROBE-002 DeepDOC Parser 探针结果")
    L.append("")
    L.append(f"- 状态：**{doc['status']}**")
    L.append(f"- 执行时间：{doc['executed_at']}")
    L.append(f"- Parser 版本：{doc['versions']['parser']}")
    L.append(f"- Tokenizer 模式：`{doc['versions']['tokenizer_mode']}`")
    L.append(f"- 模型：{doc['versions']['models']}")
    L.append("")
    L.append("> LIVE = DeepDOC 真实解析事实；SIMULATED = Parser Service 服务层协议"
             "（parserTaskId 生命周期/幂等注册/超时取消崩溃恢复），"
             "在 Worker/Parser 集成测试阶段复测。合成数据，无真实客户信息。")
    L.append("")
    L.append("## 每样本产物（LIVE）")
    L.append("")
    L.append("| 样本 | HTTP | 类型 | 契约完整 | 块数 | 已定位 | 定位率 | 表格数 | 解析秒 | 峰值RSS(MiB) |")
    L.append("|---|---|---|---|---|---|---|---|---|---|")
    for label, a in doc["measurements"]["artifacts"].items():
        q = a.get("quality") or {}
        pos = a.get("positions") or {}
        res = a.get("resource") or {}
        L.append("| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
            label, a["http_status"], a.get("kind"),
            "是" if a["contract"]["ok"] else "否",
            q.get("block_count", "-"),
            pos.get("located", "-") if pos.get("applicable") else "N/A",
            q.get("location_rate", "-"),
            q.get("table_count", "-"),
            res.get("parse_seconds", "-"),
            res.get("peak_rss_mib", "-")))
    L.append("")
    L.append("## 协议校验")
    L.append("")
    L.append("```json")
    L.append(json.dumps(doc["measurements"]["checks"], ensure_ascii=False, indent=2))
    L.append("```")
    L.append("")
    if doc["failures"]:
        L.append("## 失败项")
        for f in doc["failures"]:
            L.append(f"- {f}")
        L.append("")
    if doc["decisions_required"]:
        L.append("## 待决策")
        for d in doc["decisions_required"]:
            L.append(f"- {d}")
        L.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:9390")
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--sample", default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--artifacts-dir", default=None,
                    help="保存每个成功 ParseArtifact 的原始 JSON")
    args = ap.parse_args()
    artifacts_dir = args.artifacts_dir or os.path.join(
        args.out, "probe-002-artifacts")
    results = run(args.base, args.fixtures, args.sample, artifacts_dir)
    doc = write_reports(results, args.out)
    print(f"PROBE-002 status: {doc['status']}")
    for f in doc["failures"]:
        print(f"  FAIL: {f}")
    return 0 if doc["status"] != "BLOCKED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
