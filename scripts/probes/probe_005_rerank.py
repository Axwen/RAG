#!/usr/bin/env python3
"""PROBE-005 (Stage C, Reranker path): OpenRouter `POST {base}/rerank`.

Scope of THIS driver = the Reranker leg of the ModelAdapter probe only. It
exercises a real Cohere-shaped rerank endpoint (OpenRouter by default; any
compatible base works via --base) and measures the facts the Decision Gate
needs: request/response contract mapping, ranking quality on a synthetic gold
set, behaviour at PROBE-003's frozen 1024-candidate ceiling, top_n /
return_documents handling, long-document truncation, error mapping, and REAL
cost from `usage` (OpenRouter returns both total_tokens and cost).

Background: ADR-0017 originally recorded "OpenRouter 无 rerank 端点" and left the
Reranker undecided. That premise is what this probe re-tests — route existence
was confirmed by 401-vs-404 discrimination before any billed call was made.

LIVE      — everything the provider API actually returns.
SIMULATED — service-layer protocol NOT owned by the provider: data-class
            (UNKNOWN/sensitive) admission gating (ADR-0025) and the PostgreSQL
            budget ledger RESERVED/lease/settle/recover (ADR-0029). No business
            code exists yet (design-only repo); these are labelled and
            re-verified at ModelAdapter implementation time.

Secrets: the API key is read ONLY from env (OPENROUTER_API_KEY / RERANK_API_KEY)
and is never logged, echoed, or written into any report. Only synthetic,
fully de-identified customer-service text is sent.
"""
import argparse
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_BASE = os.environ.get("RERANK_BASE", "https://openrouter.ai/api/v1")
DEFAULT_MODEL = os.environ.get("RERANK_MODEL", "qwen/qwen3-reranker-8b")
# PROBE-003 froze the retrieval budget at <=1024 fused candidates per query, so
# 1024 is the ceiling the reranker must survive, not an arbitrary stress point.
FROZEN_CANDIDATE_CAP = 1024
# Every HTTP 429 seen anywhere in the run (see _post): the endpoint throttles
# after large-candidate calls, which the retrieval path must survive.
RATE_LIMIT_EVENTS = []

SIMULATED_NOTES = {
    "data_class_gate": "ADR-0025 的 UNKNOWN/敏感等级准入必须在 ModelAdapter 层阻断，"
        "rerank 路径与 Chat/Embedding 同等适用；无业务代码，随实现复验。",
    "budget_ledger": "ADR-0029 预扣/lease/结算/回收为服务侧协议；本探针只提供真实 "
        "usage（total_tokens + cost）作为结算口径输入。",
    "retrieval_integration": "融合候选构造、Top5 截断与 ACL 权威复核属 PROBE-003/"
        "T6 范围，本 stage 只测 rerank 端点本身。",
}

# Synthetic, fully de-identified customer-service snippets (no real data).
# Each query has exactly one gold document; the rest are plausible distractors
# from the same domain (that is what makes rerank quality measurable at all).
GOLD_SET = [
    {"query": "订单发货后多久能收到快递",
     "gold": "标准快递在下单发货后 3 至 5 个工作日送达，偏远地区可能延长 2 天。"},
    {"query": "怎么申请开发票",
     "gold": "发票可在订单完成后 30 天内在个人中心自助申请开具，支持电子普票与专票。"},
    {"query": "密码输错太多次账号被锁了怎么办",
     "gold": "连续 5 次密码错误将锁定账户 30 分钟，到时自动解锁或联系客服重置。"},
]
DISTRACTORS = [
    "会员等级每季度重新计算，累计消费满 2000 元升级为白银会员。",
    "订单发货后可在物流页面查看运单号与实时轨迹。",
    "满 99 元包邮，偏远地区加收 10 元运费。",
    "非人为损坏 15 天内可换货，往返运费由商家承担。",
    "金卡会员享专属客服接入与优先发货权益。",
    "投诉可通过在线客服或 400 电话提交工单，24 小时内响应。",
    "预售商品的发货时间以商品页面标注为准，不适用现货时效。",
    "退款到账时间取决于支付渠道，银行卡通常 1 至 3 个工作日。",
]


def _post(base, key, payload, timeout=90, path="/rerank", retry_429=3):
    """POST {base}{path}. Returns (status, body, headers, seconds).

    Never raises on HTTP/network errors — they are measurable outcomes.

    A 429 is OUR pacing problem, never a provider verdict about the request
    (this endpoint throttles after a large-candidate call), so 429 is backed
    off and retried before the caller is allowed to judge anything. Every 429
    is still recorded in RATE_LIMIT_EVENTS: throttling of big rerank calls is
    itself a production fact the retrieval path has to survive.
    """
    for attempt in range(retry_429 + 1):
        s, b, h, sec = _post_once(base, key, payload, timeout, path)
        if s != 429:
            return s, b, h, sec
        ra = h.get("retry-after") or h.get("x-ratelimit-reset")
        RATE_LIMIT_EVENTS.append({"attempt": attempt + 1,
                                  "documents": len(payload.get("documents") or []),
                                  "retry_after": ra, "seconds": sec})
        if attempt == retry_429:
            return s, b, h, sec
        time.sleep(min(60, 8 * (attempt + 1)))
    return s, b, h, sec  # unreachable


def _post_once(base, key, payload, timeout=90, path="/rerank"):
    req = urllib.request.Request(base.rstrip("/") + path,
                                 data=json.dumps(payload).encode("utf-8"),
                                 method="POST")
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
        except Exception:  # noqa: BLE001
            body = {"error": f"HTTP {e.code}"}
        return e.code, body, {k.lower(): v for k, v in (e.headers or {}).items()}, \
            round(time.perf_counter() - t0, 3)
    except Exception as e:  # noqa: BLE001
        return None, {"error": f"{type(e).__name__}: {e}"}, {}, \
            round(time.perf_counter() - t0, 3)


def _usage(body):
    u = (body or {}).get("usage") or {}
    return {"total_tokens": u.get("total_tokens"), "cost": u.get("cost")}


def _results(body):
    return (body or {}).get("results") or []


def check_contract(base, key, model):
    """Field-level contract: does the response map onto the internal contract?"""
    docs = [GOLD_SET[0]["gold"]] + DISTRACTORS[:7]
    s, b, h, sec = _post(base, key, {"model": model, "query": GOLD_SET[0]["query"],
                                     "documents": docs, "top_n": 5})
    res = _results(b)
    scores = [x.get("relevance_score") for x in res]
    idxs = [x.get("index") for x in res]
    return {
        "http": s, "seconds": sec, "sent_documents": len(docs), "top_n": 5,
        "results": len(res),
        "has_index": all(isinstance(x.get("index"), int) for x in res) if res else False,
        "has_score": all(isinstance(x.get("relevance_score"), (int, float))
                         for x in res) if res else False,
        "echoes_document": all("document" in x for x in res) if res else False,
        "scores_descending": scores == sorted(scores, reverse=True) if scores else False,
        "indices_in_range": all(0 <= i < len(docs) for i in idxs if i is not None),
        "model_echo": (b or {}).get("model"),
        "upstream_provider": (b or {}).get("provider"),
        "response_id": (b or {}).get("id"),
        "request_id": h.get("x-request-id") or h.get("x-openrouter-request-id"),
        "usage": _usage(b),
        "error": None if s == 200 else str(b)[:200],
    }


def check_ranking_quality(base, key, model):
    """The point of a reranker: does the gold doc come first, and by how much?

    Gold is placed LAST in the candidate list so a provider that just echoes
    input order cannot accidentally look correct.
    """
    rows = []
    for case in GOLD_SET:
        docs = list(DISTRACTORS) + [case["gold"]]
        gold_idx = len(docs) - 1
        s, b, _h, sec = _post(base, key, {"model": model, "query": case["query"],
                                          "documents": docs, "top_n": 3})
        res = _results(b)
        top = res[0] if res else {}
        gold_score = next((x.get("relevance_score") for x in res
                           if x.get("index") == gold_idx), None)
        best_distractor = next((x.get("relevance_score") for x in res
                                if x.get("index") != gold_idx), None)
        rows.append({
            "query": case["query"], "http": s, "seconds": sec,
            "candidates": len(docs), "gold_index": gold_idx,
            "top1_index": top.get("index"),
            "gold_is_top1": top.get("index") == gold_idx,
            "gold_score": gold_score, "best_distractor_score": best_distractor,
            "margin": (round(gold_score - best_distractor, 4)
                       if isinstance(gold_score, (int, float))
                       and isinstance(best_distractor, (int, float)) else None),
            "usage": _usage(b),
        })
    ok = [r for r in rows if r["http"] == 200]
    return {"cases": rows, "queries": len(rows), "http_ok": len(ok),
            "gold_top1_count": sum(1 for r in ok if r["gold_is_top1"]),
            "gold_top1_rate": (round(sum(1 for r in ok if r["gold_is_top1"])
                                     / len(ok), 3) if ok else None)}


def _synth_corpus(n):
    """n synthetic candidates; index 0 is the ONLY gold answer.

    The filler is drawn from distractors only — never from the gold text — so a
    gold@1 miss at large n means a real ranking miss, not a duplicate of the
    gold outranking the original copy.
    """
    out = [GOLD_SET[0]["gold"]]
    while len(out) < n:
        src = DISTRACTORS[(len(out) - 1) % len(DISTRACTORS)]
        out.append(f"{src}（编号 {len(out):04d}）")
    return out[:n]


def check_candidate_scale(base, key, model, sizes):
    """Latency + acceptance at PROBE-003's 1024-candidate ceiling and beyond."""
    curve = []
    for n in sizes:
        docs = _synth_corpus(n)
        s, b, _h, sec = _post(base, key, {"model": model,
                                          "query": GOLD_SET[0]["query"],
                                          "documents": docs, "top_n": 5},
                              timeout=180)
        res = _results(b)
        curve.append({"candidates": n, "http": s, "seconds": sec,
                      "results": len(res),
                      "top1_index": res[0].get("index") if res else None,
                      "gold_is_top1": bool(res) and res[0].get("index") == 0,
                      "usage": _usage(b),
                      "error": None if s == 200 else str(b)[:160]})
    return {"curve": curve, "frozen_cap": FROZEN_CANDIDATE_CAP}


def check_options(base, key, model):
    """top_n honoured? return_documents suppressible? (payload size matters.)"""
    docs = [GOLD_SET[0]["gold"]] + DISTRACTORS
    s1, b1, _h, sec1 = _post(base, key, {"model": model,
                                         "query": GOLD_SET[0]["query"],
                                         "documents": docs, "top_n": 3})
    s2, b2, _h2, sec2 = _post(base, key, {"model": model,
                                          "query": GOLD_SET[0]["query"],
                                          "documents": docs, "top_n": 3,
                                          "return_documents": False})
    r1, r2 = _results(b1), _results(b2)
    return {
        "top_n_requested": 3, "top_n_http": s1, "top_n_returned": len(r1),
        "top_n_honoured": len(r1) == 3, "top_n_seconds": sec1,
        "no_documents_http": s2, "no_documents_seconds": sec2,
        "documents_suppressed": bool(r2) and all("document" not in x or
                                                 x.get("document") is None
                                                 for x in r2),
        "no_documents_results": len(r2),
    }


def check_long_document(base, key, model, chars=8000):
    """Chunk sizes are not frozen until PROBE-006: does a long chunk survive?"""
    long_doc = (GOLD_SET[0]["gold"] + "补充说明：") + ("这是与问题无关的填充说明文本。" * 400)
    long_doc = long_doc[:chars]
    docs = [long_doc] + DISTRACTORS[:5]
    s, b, _h, sec = _post(base, key, {"model": model,
                                      "query": GOLD_SET[0]["query"],
                                      "documents": docs, "top_n": 3},
                          timeout=120)
    res = _results(b)
    echoed = ""
    if res and isinstance(res[0].get("document"), dict):
        echoed = res[0]["document"].get("text") or ""
    return {"http": s, "seconds": sec, "sent_chars": len(long_doc),
            "results": len(res),
            "long_doc_is_top1": bool(res) and res[0].get("index") == 0,
            "echoed_chars": len(echoed),
            "echo_truncated": bool(echoed) and len(echoed) < len(long_doc),
            "usage": _usage(b),
            "error": None if s == 200 else str(b)[:200]}


def check_errors(base, key, model, oversize=2048):
    """Error mapping + whether the provider enforces a candidate cap at all."""
    docs = [GOLD_SET[0]["gold"]] + DISTRACTORS[:3]
    q = GOLD_SET[0]["query"]
    s_bad, b_bad, _h, _t = _post(base, "sk-invalid-probe-key",
                                 {"model": model, "query": q, "documents": docs})
    s_mdl, b_mdl, _h2, _t2 = _post(base, key,
                                   {"model": "qwen/definitely-not-a-model-xyz",
                                    "query": q, "documents": docs})
    s_empty, b_empty, _h3, _t3 = _post(base, key,
                                       {"model": model, "query": q,
                                        "documents": []})
    # Oversize (2x the frozen cap): does the provider enforce a candidate cap?
    # _post already backs off and retries 429 so a token-rate limit cannot be
    # misread here as a semantic candidate cap.
    big = _synth_corpus(oversize)
    s_big, b_big, h4, sec_big = _post(base, key, {"model": model, "query": q,
                                                  "documents": big,
                                                  "top_n": 5}, timeout=240)
    retry_after = h4.get("retry-after") or h4.get("x-ratelimit-reset")
    if s_big == 429:
        oversize_outcome = "rate_limited"     # inconclusive, NOT a cap
    elif s_big == 200:
        oversize_outcome = "accepted"
    elif s_big is not None and 400 <= s_big < 500:
        oversize_outcome = "rejected"
    else:
        oversize_outcome = "error"
    return {
        "bad_key_status": s_bad, "bad_key_is_401": s_bad == 401,
        "unknown_model_status": s_mdl,
        "unknown_model_is_4xx": s_mdl is not None and 400 <= s_mdl < 500,
        "unknown_model_error": str(b_mdl)[:160],
        "empty_documents_status": s_empty,
        "empty_documents_error": str(b_empty)[:160],
        "oversize_candidates": oversize, "oversize_status": s_big,
        "oversize_seconds": sec_big,
        "oversize_outcome": oversize_outcome,
        "oversize_retry_after": retry_after,
        "oversize_rejected": oversize_outcome == "rejected",
        "oversize_results": len(_results(b_big)),
        "oversize_usage": _usage(b_big),
    }


def preflight_auth(base, key, model):
    """One minimal call so a credential problem can never be recorded as a
    provider verdict (a 401 is OUR problem, not a BLOCKED endpoint)."""
    s, b, _h, _t = _post(base, key, {"model": model, "query": "ok",
                                     "documents": ["ok"], "top_n": 1},
                         timeout=60)
    return (s not in (401, 403)), s, b


def run(base, key, model, sizes, provider, usd_to_cny):
    r = {"stage": "C-rerank", "provider": provider, "model": model,
         "endpoint": base.rstrip("/") + "/rerank", "checks": {}}
    r["checks"]["contract"] = check_contract(base, key, model)
    r["checks"]["ranking_quality"] = check_ranking_quality(base, key, model)
    r["checks"]["candidate_scale"] = check_candidate_scale(base, key, model, sizes)
    r["checks"]["options"] = check_options(base, key, model)
    r["checks"]["long_document"] = check_long_document(base, key, model)
    r["checks"]["error_mapping"] = check_errors(base, key, model)
    r["simulated"] = SIMULATED_NOTES
    r["rate_limit_events"] = list(RATE_LIMIT_EVENTS)

    # LIVE cost: this endpoint returns usage.cost directly (USD), so the budget
    # ledger settlement unit is measured, not estimated from a price table.
    tokens, usd = 0, 0.0
    def _acc(u):
        nonlocal tokens, usd
        tokens += (u or {}).get("total_tokens") or 0
        usd += float((u or {}).get("cost") or 0.0)
    _acc(r["checks"]["contract"]["usage"])
    for c in r["checks"]["ranking_quality"]["cases"]:
        _acc(c["usage"])
    for c in r["checks"]["candidate_scale"]["curve"]:
        _acc(c["usage"])
    _acc(r["checks"]["long_document"]["usage"])
    _acc(r["checks"]["error_mapping"]["oversize_usage"])
    r["cost"] = {"measured_total_tokens_partial": tokens,
                 "measured_usd_partial": round(usd, 6),
                 "usd_to_cny_assumed": usd_to_cny,
                 "estimated_cny_partial": round(usd * usd_to_cny, 4),
                 "note": "只统计带 usage 的校验调用；汇率为假设值，不是供应商结算汇率。"}
    return r


def evaluate(r):
    fails, decides = [], []
    ct = r["checks"]["contract"]
    if ct["http"] != 200:
        fails.append(f"rerank 基本契约调用失败 HTTP {ct['http']}：{ct.get('error')}")
    else:
        if not (ct["has_index"] and ct["has_score"]):
            fails.append("响应缺少 index 或 relevance_score，无法映射到内部 rerank 契约")
        if not ct["scores_descending"]:
            fails.append("relevance_score 未按降序返回，Top-K 截断不能直接信任响应顺序")
        if not ct["indices_in_range"]:
            fails.append("返回的 index 越界，无法与候选集对齐")

    rq = r["checks"]["ranking_quality"]
    if rq["http_ok"] == 0:
        fails.append("排序质量校验全部调用失败，rerank 能力不可验证")
    elif rq["gold_top1_rate"] is not None and rq["gold_top1_rate"] < 1.0:
        decides.append(f"合成黄金集 gold@1 命中率 {rq['gold_top1_rate']}"
                       f"（{rq['gold_top1_count']}/{rq['http_ok']}）：需在 PROBE-006 "
                       "真实语料上以 Recall@5 复测，不能只凭本合成集定档。")

    cs = r["checks"]["candidate_scale"]["curve"]
    cap_row = next((c for c in cs if c["candidates"] == FROZEN_CANDIDATE_CAP), None)
    if cap_row and cap_row["http"] != 200:
        fails.append(f"{FROZEN_CANDIDATE_CAP} 候选（PROBE-003 冻结上限）rerank 失败 "
                     f"HTTP {cap_row['http']}：检索预算与 rerank 能力不相容")
    elif cap_row:
        decides.append(f"{FROZEN_CANDIDATE_CAP} 候选单次 rerank 实测 "
                       f"{cap_row['seconds']}s：必须作为检索链路独立计时项，且 Adapter "
                       "需按该延迟设置超时与降级（截断候选数而非放弃 rerank）。")
        # ADR-0029 的每日 16 元是最紧的一档上限，rerank 候选数直接决定它能撑多少次问答。
        rate = r.get("cost", {}).get("usd_to_cny_assumed") or 7.2
        cap_usd = float((cap_row.get("usage") or {}).get("cost") or 0.0)
        if cap_usd > 0:
            cap_cny = cap_usd * rate
            per_day = int(16.0 / cap_cny) if cap_cny > 0 else None
            cheap = min((c for c in cs if c["http"] == 200 and c["candidates"] <
                         FROZEN_CANDIDATE_CAP and (c.get("usage") or {}).get("cost")),
                        key=lambda c: c["candidates"], default=None)
            hint = ""
            if cheap:
                ccny = float(cheap["usage"]["cost"]) * rate
                hint = (f"；对比 {cheap['candidates']} 候选仅 ¥{ccny:.4f}/次、"
                        f"{cheap['seconds']}s")
            decides.append(
                f"满额 {FROZEN_CANDIDATE_CAP} 候选 rerank 单次成本 ¥{cap_cny:.4f}"
                f"（实测 usage.cost ${cap_usd}，汇率假设 {rate}）：仅 rerank 一项就把 "
                f"ADR-0029 每日 16 元压到约 {per_day} 次问答/日{hint}。"
                "PROBE-003 冻结的 1024 是**融合候选**上限，不等于必须全量 rerank："
                "需决策 rerank 输入是否截断到更小的 N（成本与延迟同时线性下降），"
                "该 N 应写入 ADR-0017 Adapter 约束与 ADR-0029 成本模型。")

    em = r["checks"]["error_mapping"]
    if not em["bad_key_is_401"]:
        decides.append(f"错误密钥返回 {em['bad_key_status']}（非 401），错误映射表按实测归一。")
    if not em["unknown_model_is_4xx"]:
        decides.append(f"未知模型返回 {em['unknown_model_status']}（非 4xx）："
                       "Adapter 必须自校验模型白名单，不得依赖供应商拒绝。")
    if em.get("oversize_outcome") == "accepted":
        decides.append(f"{em['oversize_candidates']} 条候选未被供应商拒绝"
                       f"（HTTP {em['oversize_status']}，耗时 {em['oversize_seconds']}s）："
                       "与 Embedding 腿同一结论——候选上限保护必须做在 ModelAdapter 侧。")
    elif em.get("oversize_outcome") == "rate_limited":
        decides.append(
            f"{em['oversize_candidates']} 条超量候选在退避重试后仍被限流（HTTP 429，"
            f"retry-after={em.get('oversize_retry_after')}）：本次运行**未能验证**"
            "供应商是否设候选上限（限流不是供应商对请求的裁决），候选上限保护仍必须"
            "做在 ModelAdapter 侧。")
    elif em.get("oversize_outcome") == "rejected":
        decides.append(f"{em['oversize_candidates']} 条候选被供应商以 HTTP "
                       f"{em['oversize_status']} 拒绝：该拒绝不是契约承诺，"
                       "Adapter 仍需自设候选上限。")

    rl = r.get("rate_limit_events") or []
    if rl:
        sizes_hit = sorted({(e.get("documents") or 0) for e in rl})
        decides.append(
            f"运行中出现 {len(rl)} 次 HTTP 429 限流（被限流调用的候选数 {sizes_hit}，"
            f"retry-after 头={rl[0].get('retry_after')}，退避重试后成功）："
            "大候选 rerank 会触发限流，且供应商未给出 retry-after 头。检索链路必须把 429 "
            "视为常规分支——按「退避重试 + 截断候选数」降级，不得让一次限流打穿问答请求；"
            "本探针对所有调用做 429 退避重试，否则限流会被误记为供应商契约缺陷"
            "（2026-08-26 03:34Z 那次运行未加退避，top_n 与 return_documents 两项检查"
            "被紧随 1024 大调用后的 429 污染，结论一度失真）。")

    op = r["checks"]["options"]
    if not op["top_n_honoured"]:
        decides.append(f"top_n=3 实际返回 {op['top_n_returned']} 条：Top-K 截断不能依赖"
                       "供应商，必须在 Adapter 侧再截一次。")
    if not op["documents_suppressed"]:
        decides.append("`return_documents=false` 未生效（响应仍回显全文）：大候选集下响应"
                       "体积与日志脱敏风险由 Adapter 侧承担，不得把回显正文写入日志。")

    ld = r["checks"]["long_document"]
    if ld["http"] != 200:
        decides.append(f"{ld['sent_chars']} 字符长候选 rerank 失败 HTTP {ld['http']}："
                       "PROBE-006 冻结 chunk 上限时必须把该长度纳入约束。")
    elif ld["echo_truncated"]:
        decides.append(f"长候选被截断（送 {ld['sent_chars']} 字符，回显 "
                       f"{ld['echoed_chars']} 字符）：超长 chunk 的尾部可能不参与打分，"
                       "PROBE-006 需据此限制 chunk 上限。")

    status = "PASS"
    if fails:
        status = "BLOCKED"
    elif decides:
        status = "PASS_WITH_ADJUSTMENT"
    return fails, decides, status


def write_reports(r, out_dir, slug):
    fails, decides, status = evaluate(r)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = {"probe_id": "PROBE-005", "stage": "C-rerank", "status": status,
           "executed_at": now, "provider": r.get("provider"),
           "model": r["model"], "endpoint": r["endpoint"],
           "measurements": r, "failures": fails,
           "decisions_required": decides, "recommendation": status}
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, slug + ".json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    _write_md(doc, os.path.join(out_dir, slug + ".md"))
    return doc


def _write_md(doc, path):
    m = doc["measurements"]
    c = m["checks"]
    ct, rq, cs, op, ld, em = (c["contract"], c["ranking_quality"],
                              c["candidate_scale"], c["options"],
                              c["long_document"], c["error_mapping"])
    L = ["# PROBE-005 ModelAdapter 探针结果（Stage C · Reranker）", "",
         f"- 状态：**{doc['status']}**",
         f"- 执行时间：{doc['executed_at']}",
         f"- 供应商：`{doc['provider']}`，端点 `{doc['endpoint']}`",
         f"- 模型：`{doc['model']}`（上游 `{ct.get('upstream_provider')}`，"
         f"回显 `{ct.get('model_echo')}`）",
         "- 数据：仅合成脱敏客服文本，无真实客户数据。", "",
         "## 1. 契约映射（LIVE）", "",
         f"- HTTP {ct['http']}，耗时 {ct['seconds']}s，送 {ct['sent_documents']} "
         f"条候选、`top_n={ct['top_n']}`，返回 {ct['results']} 条",
         f"- 字段：`index` {ct['has_index']}，`relevance_score` {ct['has_score']}，"
         f"回显 `document` {ct['echoes_document']}",
         f"- 分数降序：{ct['scores_descending']}；index 在候选范围内："
         f"{ct['indices_in_range']}",
         f"- 可审计标识：response id `{ct.get('response_id')}`，request-id "
         f"`{ct.get('request_id')}`",
         f"- 用量：{ct['usage']}（`cost` 为供应商直接返回的美元成本，可直接作为"
         "ADR-0029 结算口径）", "",
         "## 2. 排序质量（LIVE，合成黄金集）", "",
         f"gold 文档一律放在候选列表**最后一位**，避免「原序回显」被误判为排序正确。"
         f"命中率 gold@1 = **{rq['gold_top1_rate']}**"
         f"（{rq['gold_top1_count']}/{rq['http_ok']}）。", "",
         "| 查询 | HTTP | 耗时 | 候选数 | top1 index | gold index | gold@1 | "
         "gold 分 | 次优干扰分 | 间距 |", "|---|---|---|---|---|---|---|---|---|---|"]
    for x in rq["cases"]:
        L.append(f"| {x['query']} | {x['http']} | {x['seconds']}s | "
                 f"{x['candidates']} | {x['top1_index']} | {x['gold_index']} | "
                 f"{x['gold_is_top1']} | {x['gold_score']} | "
                 f"{x['best_distractor_score']} | {x['margin']} |")
    L += ["", "## 3. 候选规模与延迟（LIVE）", "",
          f"PROBE-003 冻结的检索预算是单次最多 {cs['frozen_cap']} 条融合候选，"
          "因此该值是 rerank 必须承受的上限，不是任意压力点。", "",
          "| 候选数 | HTTP | 耗时 | 返回条数 | gold@1 | 用量 |",
          "|---|---|---|---|---|---|"]
    for x in cs["curve"]:
        L.append(f"| {x['candidates']} | {x['http']} | {x['seconds']}s | "
                 f"{x['results']} | {x['gold_is_top1']} | {x['usage']} |")
    L += ["", "## 4. 选项与长候选（LIVE）", "",
          f"- `top_n=3` → 返回 {op['top_n_returned']} 条（HTTP {op['top_n_http']}，"
          f"{op['top_n_seconds']}s），生效：{op['top_n_honoured']}",
          f"- `return_documents=false` → HTTP {op['no_documents_http']}"
          f"（{op['no_documents_seconds']}s），回显被抑制：{op['documents_suppressed']}",
          f"- 长候选 {ld['sent_chars']} 字符 → HTTP {ld['http']}（{ld['seconds']}s），"
          f"回显 {ld['echoed_chars']} 字符，被截断：{ld['echo_truncated']}，"
          f"仍为 top1：{ld['long_doc_is_top1']}", "",
          "## 5. 错误映射与候选上限（LIVE）", "",
          f"- 错误密钥 → HTTP {em['bad_key_status']}（401：{em['bad_key_is_401']}）",
          f"- 未知模型 → HTTP {em['unknown_model_status']}"
          f"（4xx：{em['unknown_model_is_4xx']}）`{em['unknown_model_error']}`",
          f"- 空 `documents` → HTTP {em['empty_documents_status']} "
          f"`{em['empty_documents_error']}`",
          f"- {em['oversize_candidates']} 条超量候选 → HTTP {em['oversize_status']}"
          f"（{em['oversize_seconds']}s，返回 {em['oversize_results']} 条），"
          f"结论：`{em.get('oversize_outcome')}`，用量 {em['oversize_usage']}",
          f"- 运行中 HTTP 429 限流次数：{len(m.get('rate_limit_events') or [])}"
          f"（明细 {m.get('rate_limit_events') or '无'}）；所有调用均已做 429 退避重试，"
          "限流不计入供应商契约结论。", "",
          "## 6. 费用（LIVE）", "",
          f"- 本次探针带 usage 的调用合计 {m['cost']['measured_total_tokens_partial']} "
          f"tokens，供应商直接返回成本 ${m['cost']['measured_usd_partial']}"
          f"（按假设汇率 {m['cost']['usd_to_cny_assumed']} 约 "
          f"¥{m['cost']['estimated_cny_partial']}）",
          f"- {m['cost']['note']}", "",
          "## 7. SIMULATED（非供应商责任，随实现复验）", ""]
    for k, v in m["simulated"].items():
        L.append(f"- **{k}**：{v}")
    L += ["", "## 8. 结论", ""]
    if doc["failures"]:
        L.append("### 阻断项")
        L += [f"- {x}" for x in doc["failures"]] + [""]
    if doc["decisions_required"]:
        L.append("### 需决策/需实现侧承担")
        L += [f"- {x}" for x in doc["decisions_required"]] + [""]
    if not doc["failures"] and not doc["decisions_required"]:
        L.append("无阻断项，无待决策项。")
    L += ["", f"建议结论：**{doc['recommendation']}**", ""]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--provider", default="openrouter")
    ap.add_argument("--out", required=True)
    ap.add_argument("--report-slug", default=None)
    ap.add_argument("--sizes", default="8,64,256,1024",
                    help="候选规模曲线；1024 是 PROBE-003 冻结的候选上限")
    ap.add_argument("--usd-to-cny", type=float,
                    default=float(os.environ.get("USD_TO_CNY", "7.2")))
    args = ap.parse_args()

    key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("RERANK_API_KEY")
    if not key:
        print("ERROR: 未提供 OPENROUTER_API_KEY / RERANK_API_KEY（只从环境变量读取，"
              "不接受命令行传入）。未做任何网络调用，未产生费用。")
        return 3
    if not args.model:
        print("ERROR: 未指定 rerank model id（--model 或环境变量 RERANK_MODEL）。"
              "未做任何网络调用，未产生费用。")
        return 3

    ok, s, b = preflight_auth(args.base, key, args.model)
    if not ok:
        print(f"ERROR: 凭据预检失败 HTTP {s}：{str(b)[:300]}")
        print("**未写任何报告**：401/403 是凭据问题，不是供应商结论，不能记成 BLOCKED。")
        return 3

    sizes = [int(x) for x in args.sizes.split(",") if x.strip()]
    slug = args.report_slug or f"probe-005-model-adapter-rerank-{args.provider}"
    r = run(args.base, key, args.model, sizes, args.provider, args.usd_to_cny)
    doc = write_reports(r, args.out, slug)
    print(f"status={doc['status']}  ->  {os.path.join(args.out, slug + '.md')}")
    for x in doc["failures"]:
        print(f"  FAIL: {x}")
    for x in doc["decisions_required"]:
        print(f"  DECIDE: {x}")
    return 0 if doc["status"] != "BLOCKED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
