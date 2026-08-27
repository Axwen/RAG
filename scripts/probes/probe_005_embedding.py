#!/usr/bin/env python3
"""PROBE-005 (Stage A, Embedding path): OpenRouter qwen/qwen3-embedding-8b.

Scope of THIS driver = the Embedding leg of the ModelAdapter probe only. It
exercises a real OpenAI-compatible /v1/embeddings endpoint (OpenRouter by
default; any OpenAI-compatible base works via --base) and measures the facts
the Decision Gate needs: vector dimension (incl. MRL `dimensions` truncation to
match PROBE-003's frozen 1024 contract), L2 norm (cosine vs dot), batch/latency
behaviour, determinism, error mapping, and REAL cost from usage.total_tokens.

LIVE      — everything the provider API actually returns.
SIMULATED — service-layer protocol NOT owned by the provider: data-class
            (UNKNOWN/sensitive) admission gating and the PostgreSQL budget
            ledger (RESERVED/lease/settle/recover). No business code exists yet
            (design-only repo); these are labelled and re-verified at
            ModelAdapter implementation time. The Chat leg is a separate stage.

Secrets: the API key is read ONLY from `OPENROUTER_API_KEY`. It is never logged,
echoed, or written to any report. Only synthetic text is sent.
"""
import argparse
import json
import math
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_BASE = os.environ.get("OPENROUTER_BASE", "https://openrouter.ai/api/v1")
DEFAULT_MODEL = os.environ.get("EMBED_MODEL", "qwen/qwen3-embedding-8b")
# PROBE-003 froze the kNN index at 1024-dim cosinesimil; request MRL 1024 as the
# primary so the embedding contract matches the already-frozen index contract.
FROZEN_DIM = 1024

# Synthetic, fully de-identified customer-service snippets (no real data).
SYNTH_SENTENCES = [
    "退款政策：订单签收后 7 天内可申请无理由退款。",
    "运费说明：满 99 元包邮，偏远地区加收 10 元。",
    "发票申请：支持电子普票与增值税专票，需提供税号。",
    "账户安全：连续 5 次密码错误将锁定账户 30 分钟。",
    "配送时效：现货商品 48 小时内发出，预售以页面为准。",
    "售后换货：非人为损坏 15 天内可换货，运费商家承担。",
    "会员权益：金卡会员享专属客服与优先发货。",
    "投诉渠道：可通过在线客服或 400 电话提交工单。",
]


def _post(base, key, payload, timeout=60):
    """POST /embeddings. Returns (status, json_body_or_error, headers, seconds).
    Never raises on HTTP errors — maps them so error cases are measurable."""
    url = f"{base}/embeddings"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            hdrs = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, body, hdrs, round(time.perf_counter() - t0, 3)
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8"))
        except Exception:
            body = {"error": f"HTTP {e.code}"}
        hdrs = {k.lower(): v for k, v in (e.headers or {}).items()}
        return e.code, body, hdrs, round(time.perf_counter() - t0, 3)
    except Exception as e:  # noqa: BLE001 - network/timeout mapped, not raised
        return None, {"error": str(e)}, {}, round(time.perf_counter() - t0, 3)


def _l2(vec):
    return math.sqrt(sum(x * x for x in vec))


def _cosine(a, b):
    na, nb = _l2(a), _l2(b)
    if na == 0 or nb == 0:
        return 0.0
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def _embed(base, key, texts, model, dimensions=None):
    payload = {"model": model, "input": texts, "encoding_format": "float"}
    if dimensions is not None:
        payload["dimensions"] = dimensions
    return _post(base, key, payload)


def check_contract_and_dim(base, key, model):
    """Items 1-2: request/response maps to internal contract; measure native dim
    and MRL `dimensions=1024` (must match PROBE-003's frozen 1024 contract)."""
    out = {}
    s, b, h, sec = _embed(base, key, [SYNTH_SENTENCES[0]], model)
    out["native"] = {"http": s, "seconds": sec,
                     "trace_id": (h.get("x-siliconcloud-trace-id")
                                  or h.get("x-request-id")
                                  or h.get("openrouter-request-id")),
                     "model_echo": b.get("model") if s == 200 else None,
                     "dim": len(b["data"][0]["embedding"]) if s == 200 else None,
                     "usage": b.get("usage") if s == 200 else b}
    s, b, h, sec = _embed(base, key, [SYNTH_SENTENCES[0]], model, dimensions=FROZEN_DIM)
    out["mrl_1024"] = {"http": s, "seconds": sec,
                       "dim": len(b["data"][0]["embedding"]) if s == 200 else None,
                       "matches_frozen": (s == 200 and len(b["data"][0]["embedding"]) == FROZEN_DIM),
                       "usage": b.get("usage") if s == 200 else b}
    return out


def check_normalization(base, key, model, dimensions=FROZEN_DIM):
    """Vectors L2-normalized? Decides OpenSearch space_type (cosinesimil is safe
    either way; dot-product/innerproduct requires unit norm)."""
    s, b, _, _ = _embed(base, key, SYNTH_SENTENCES[:3], model, dimensions=dimensions)
    if s != 200:
        return {"ok": False, "http": s, "error": b}
    norms = [round(_l2(d["embedding"]), 4) for d in b["data"]]
    unit = all(abs(n - 1.0) < 1e-2 for n in norms)
    return {"ok": True, "dimensions": dimensions, "norms": norms,
            "l2_normalized": unit,
            "recommended_space_type": "cosinesimil" if not unit else "innerproduct/cosinesimil"}


def check_batch_and_latency(base, key, model, dimensions=FROZEN_DIM):
    """Item 2: batch size + latency-vs-sentence-count curve (逐句批量口径).
    Also verifies order preservation via the response `index` field."""
    curve = []
    for n in (1, 4, 8, len(SYNTH_SENTENCES)):
        texts = (SYNTH_SENTENCES * 4)[:n]
        s, b, _, sec = _embed(base, key, texts, model, dimensions=dimensions)
        row = {"n": n, "http": s, "seconds": sec}
        if s == 200:
            row["returned"] = len(b["data"])
            row["order_preserved"] = [d["index"] for d in b["data"]] == list(range(n))
            row["total_tokens"] = (b.get("usage") or {}).get("total_tokens")
        else:
            row["error"] = b
        curve.append(row)
    return {"curve": curve}


def check_determinism(base, key, model, dimensions=FROZEN_DIM):
    """Same input twice -> (near-)identical vectors: safe for hash/cache dedup."""
    s1, b1, _, _ = _embed(base, key, [SYNTH_SENTENCES[1]], model, dimensions=dimensions)
    s2, b2, _, _ = _embed(base, key, [SYNTH_SENTENCES[1]], model, dimensions=dimensions)
    if s1 != 200 or s2 != 200:
        return {"ok": False, "http": [s1, s2]}
    v1, v2 = b1["data"][0]["embedding"], b2["data"][0]["embedding"]
    return {"ok": True, "cosine_self": round(_cosine(v1, v2), 6),
            "bitwise_identical": v1 == v2}


def check_errors(base, key, model):
    """Error mapping: bad key -> 401; oversized batch (>32) -> 4xx. Mapped, not raised."""
    s_auth, b_auth, _, _ = _post(base, "sk-INVALID-probe-key", {
        "model": model, "input": [SYNTH_SENTENCES[0]]})
    big = (SYNTH_SENTENCES * 5)[:33]  # >32 documented max
    s_big, b_big, _, _ = _embed(base, key, big, model)
    return {"bad_key_status": s_auth,
            "bad_key_is_401": s_auth == 401,
            "oversize_batch_status": s_big,
            "oversize_batch_rejected": (s_big is not None and s_big >= 400)}


SIMULATED_NOTES = {
    "data_class_gating": "ADR-0025: UNKNOWN/敏感等级必须在 ModelAdapter 准入层"
        "（而非调用点）阻断 Chat/Embedding/Reranker/引用验证四条路径。业务代码尚未"
        "存在（设计期仓库），本探针只发送合成文本，门禁为 SIMULATED，随 ModelAdapter "
        "实现的集成测试复验。",
    "budget_ledger": "ADR-0029: 调用前在同一 PostgreSQL 事务写入 RESERVED 并取 lease，"
        "结算写回实际用量、释放差额，进程被杀后 lease 过期回收。无 DB/业务代码，"
        "SIMULATED；本探针 LIVE 记录真实 usage.total_tokens 供预扣口径校准。",
    "chat_reranker": "Chat / 高风险蕴含已由 fluxionai gpt-5.6-terra Responses API "
        "定档；Reranker 已由 OpenRouter qwen/qwen3-reranker-8b 的 Cohere 形状 "
        "POST /rerank 定档。两条路径的数据分级门禁与预算账本仍需集成复验。",
}


def run(base, key, model, price_per_1m, provider="openrouter"):
    r = {"stage": "A-embedding", "provider": provider, "model": model,
         "checks": {}}
    r["checks"]["contract_and_dim"] = check_contract_and_dim(base, key, model)
    r["checks"]["normalization"] = check_normalization(base, key, model)
    r["checks"]["batch_latency"] = check_batch_and_latency(base, key, model)
    r["checks"]["determinism"] = check_determinism(base, key, model)
    r["checks"]["error_mapping"] = check_errors(base, key, model)
    r["simulated"] = SIMULATED_NOTES

    # LIVE cost: sum every usage.total_tokens we actually spent.
    toks = 0
    for c in (r["checks"]["contract_and_dim"].get("native"),
              r["checks"]["contract_and_dim"].get("mrl_1024")):
        toks += ((c or {}).get("usage") or {}).get("total_tokens", 0) or 0
    for row in r["checks"]["batch_latency"]["curve"]:
        toks += row.get("total_tokens", 0) or 0
    r["cost"] = {"measured_total_tokens_partial": toks,
                 "price_cny_per_1m_tokens": price_per_1m,
                 "estimated_cny": round(toks / 1_000_000 * price_per_1m, 6)
                 if price_per_1m else None,
                 "note": "仅统计部分校验调用的 token；单价来自环境变量，未提供则只记录用量。"}
    return r


def evaluate(r):
    failures, decisions = [], []
    cd = r["checks"]["contract_and_dim"]
    if cd["native"]["http"] != 200:
        failures.append(f"native embedding 调用失败 HTTP {cd['native']['http']}")
    if not cd["mrl_1024"]["matches_frozen"]:
        failures.append("MRL dimensions=1024 未能匹配 PROBE-003 冻结的 1024 维契约")
    norm = r["checks"]["normalization"]
    if not norm.get("ok"):
        failures.append("归一化探测调用失败")
    det = r["checks"]["determinism"]
    if det.get("ok") and det["cosine_self"] < 0.9999:
        decisions.append(f"同输入自相似 cosine={det['cosine_self']}（<1）：dedup/缓存需按"
                         "阈值而非位相等判定。")
    em = r["checks"]["error_mapping"]
    if not em["bad_key_is_401"]:
        decisions.append(f"错误密钥返回 {em['bad_key_status']}（非 401），错误映射表需按实测归一。")
    if not em["oversize_batch_rejected"]:
        decisions.append("超 32 条批量未被拒绝，需在 Adapter 侧做批量上限保护。")

    native_dim = cd["native"].get("dim")
    if native_dim and native_dim != FROZEN_DIM:
        decisions.append(f"模型原生维度 {native_dim} 与冻结的 kNN 维度 {FROZEN_DIM} 不一致；"
                         f"PROBE-006 已用 {FROZEN_DIM} 维真实 Embedding 完成小规模 "
                         f"Recall@5，但未执行同语料 {native_dim} 维对照，因此不宣称 "
                         f"{FROZEN_DIM} 维相对原生维度无召回损失。")
    status = "PASS"
    if failures:
        status = "BLOCKED"
    elif decisions:
        status = "PASS_WITH_ADJUSTMENT"
    return failures, decisions, status


def write_reports(r, out_dir):
    failures, decisions, status = evaluate(r)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = {"probe_id": "PROBE-005", "stage": "A-embedding", "status": status,
           "executed_at": now, "provider": r.get("provider", "openrouter"),
           "model": r["model"],
           "measurements": r, "failures": failures,
           "decisions_required": decisions, "recommendation": status}
    os.makedirs(out_dir, exist_ok=True)
    jp = os.path.join(out_dir, "probe-005-model-adapter.json")
    with open(jp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    _write_md(doc, os.path.join(out_dir, "probe-005-model-adapter.md"))
    return doc


def _write_md(doc, path):
    m = doc["measurements"]
    cd = m["checks"]["contract_and_dim"]
    prov = doc.get("provider", "openrouter")
    L = [f"# PROBE-005 ModelAdapter 探针结果（Stage A · Embedding）", "",
         f"- 状态：**{doc['status']}**",
         f"- 执行时间：{doc['executed_at']}",
         f"- Provider：{prov}（OpenAI 兼容 /v1/embeddings）",
         f"- 模型：`{doc['model']}`", "",
         f"> LIVE = {prov} API 真实返回；SIMULATED = 数据分级门禁与 PostgreSQL "
         "预算账本（无业务代码，随 ModelAdapter 实现复验）。仅发送合成文本，密钥不入库/日志/报告。", "",
         "## 维度与契约（LIVE）", "",
         f"- 原生维度：**{cd['native'].get('dim')}**（trace-id 可审计：{bool(cd['native'].get('trace_id'))}）",
         f"- MRL `dimensions=1024`：返回 {cd['mrl_1024'].get('dim')} 维，"
         f"匹配 PROBE-003 冻结 1024 契约：**{cd['mrl_1024'].get('matches_frozen')}**", "",
         "## 归一化 / 空间度量（LIVE）", ""]
    norm = m["checks"]["normalization"]
    L.append(f"- L2 范数：{norm.get('norms')}；已单位归一化：**{norm.get('l2_normalized')}**；"
             f"建议 space_type：`{norm.get('recommended_space_type')}`")
    L += ["", "## 批量 / 延迟曲线（LIVE）", "",
          "| 句数 | HTTP | 秒 | 返回条数 | 顺序保持 | total_tokens |",
          "|---|---|---|---|---|---|"]
    for row in m["checks"]["batch_latency"]["curve"]:
        L.append(f"| {row['n']} | {row['http']} | {row.get('seconds')} | "
                 f"{row.get('returned','-')} | {row.get('order_preserved','-')} | "
                 f"{row.get('total_tokens','-')} |")
    det = m["checks"]["determinism"]
    em = m["checks"]["error_mapping"]
    L += ["", "## 确定性与错误映射（LIVE）", "",
          f"- 同输入自相似 cosine：{det.get('cosine_self')}；位相等：{det.get('bitwise_identical')}",
          f"- 错误密钥 → HTTP {em.get('bad_key_status')}（401：{em.get('bad_key_is_401')}）",
          f"- 超 32 条批量 → HTTP {em.get('oversize_batch_status')}（被拒：{em.get('oversize_batch_rejected')}）",
          "", "## 成本（LIVE 用量）", "",
          f"- 统计到的 token 用量（部分调用）：{m['cost']['measured_total_tokens_partial']}",
          f"- 单价（元/百万 token）：{m['cost']['price_cny_per_1m_tokens']}；"
          f"估算：{m['cost']['estimated_cny']} 元", ""]
    if failures := doc["failures"]:
        L += ["## 失败项", *[f"- {x}" for x in failures], ""]
    if decisions := doc["decisions_required"]:
        L += ["## 待决策", *[f"- {x}" for x in decisions], ""]
    L += ["## SIMULATED（服务层，随 ModelAdapter 实现复验）", ""]
    for k, v in m["simulated"].items():
        L.append(f"- **{k}**：{v}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--provider", default="openrouter")
    ap.add_argument("--out", required=True)
    ap.add_argument("--price-per-1m", type=float,
                    default=float(os.environ["EMBED_PRICE_CNY_PER_1M"])
                    if os.environ.get("EMBED_PRICE_CNY_PER_1M")
                    else 0.0)
    args = ap.parse_args()
    # Read from env only — never a CLI arg or a tracked file. The wrapper may
    # source an explicitly untracked env file into the process environment.
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        print("ERROR: 未找到 OPENROUTER_API_KEY。请先导出，"
              "不要写入仓库：\n"
              "  ! export OPENROUTER_API_KEY=你的密钥\n"
              "未做任何网络调用，未产生费用。")
        return 3
    r = run(args.base, key, args.model, args.price_per_1m, provider=args.provider)
    doc = write_reports(r, args.out)
    print(f"PROBE-005 Stage A status: {doc['status']}")
    for x in doc["failures"]:
        print(f"  FAIL: {x}")
    for x in doc["decisions_required"]:
        print(f"  DECIDE: {x}")
    return 0 if doc["status"] != "BLOCKED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
