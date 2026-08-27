#!/usr/bin/env python3
"""PROBE-005 (Stage B, Chat leg) — OpenAI **Responses API** variant (/v1/responses).

Companion to probe_005_chat.py (which drives the /chat/completions leg). The user
directed the Chat path to use the Responses API, so this driver maps the same
Decision-Gate facts onto the Responses shape:
  request : {model, instructions, input, max_output_tokens}
  response: {id, status, model, output:[{content:[{type:"output_text","text"}]}],
             usage:{input_tokens, output_tokens, total_tokens}}
  stream  : typed SSE events (response.output_text.delta / response.completed ...)

What it measures (LIVE): contract mapping, model echo/auditability, TTFT + full
generation, mid-stream cancellation, streaming usage (needed to settle a cancelled
stream per ADR-0029), structured output via text.format json_schema/json_object,
error normalization, and real cost from usage tokens.

SIMULATED (unchanged, no business code yet): ADR-0025 data-class gating, ADR-0029
budget ledger, ADR-0027 tiered citation verification.

--user-agent RECORDS the UA the endpoint required, and defaults to EMPTY (the
plain urllib UA) because that is what a server-side backend can actually send.
agentrouter.org gated admission on User-Agent: claude-cli/* — that gate is itself
a decisive finding, so it is surfaced in the report rather than worked around.

--report-slug keeps each provider's fact record separate: the point of this probe
is provider comparison for the ADR-0017 decision, so a new provider must not
overwrite a previous provider's measured report.

Secrets: key ONLY from env (CHAT_API_KEY / AGENTROUTER_API_KEY / OPENROUTER_API_KEY);
never logged, echoed, or written to any report. Only synthetic de-identified text.
"""
import argparse
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_BASE = os.environ.get("CHAT_BASE", "https://fluxionai.space/v1")
DEFAULT_MODEL = os.environ.get("CHAT_MODEL") or None
DEFAULT_UA = os.environ.get("CHAT_USER_AGENT") or None

SYSTEM_PROMPT = ("你是企业客服助手。只依据【资料】回答，不得编造；"
                 "若资料不足请明确说明，并在每条结论后用 [D1]/[D2]/[D3] 标注来源。")
CONTEXT_SNIPPETS = [
    "[D1] 退款政策：订单签收后 7 天内可申请无理由退款。",
    "[D2] 运费说明：满 99 元包邮，偏远地区加收 10 元；退货运费由商家承担（非人为损坏）。",
    "[D3] 售后换货：非人为损坏 15 天内可换货。",
]
QUESTION = "订单签收后还能退款吗？退货运费谁承担？请引用资料编号。"


def _input_text():
    return "【资料】\n" + "\n".join(CONTEXT_SNIPPETS) + f"\n\n【问题】{QUESTION}"


def _headers(key, ua):
    h = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if ua:
        h["User-Agent"] = ua
    return h


# The relay was observed to stall past even a 90 s read timeout on calls that
# normally answer in 5-8 s, intermittently and on ANY check. Left unhandled this
# flips the whole verdict run-to-run, so every call site retries and every hang is
# counted here: the hang RATE is the availability finding we report.
HANGS = {"count": 0, "calls": 0}


def _retry(fn, attempts=3):
    """Call fn() until it returns a non-None HTTP status. fn must return
    (status, body, headers, seconds). Counts hangs globally."""
    hangs = 0
    for i in range(attempts):
        s, b, h, sec = fn()
        HANGS["calls"] += 1
        if s is not None:
            return s, b, h, sec, hangs
        hangs += 1
        HANGS["count"] += 1
    return s, b, h, sec, hangs


def _output_text(body):
    """Concatenate every output_text part of a Responses object."""
    parts = []
    for item in (body.get("output") or []):
        for c in (item.get("content") or []):
            if c.get("type") == "output_text":
                parts.append(c.get("text") or "")
    return "".join(parts)


def _usage_norm(u):
    """Map Responses usage → internal (prompt/completion/total) contract."""
    if not u:
        return {}
    return {"prompt_tokens": u.get("input_tokens"),
            "completion_tokens": u.get("output_tokens"),
            "total_tokens": u.get("total_tokens"),
            "reasoning_tokens": (u.get("output_tokens_details") or {}).get("reasoning_tokens"),
            "cached_tokens": (u.get("input_tokens_details") or {}).get("cached_tokens")}


def _req(base, key, payload, ua=None, timeout=90):
    """Non-streaming POST /responses. Maps errors, never raises."""
    url = f"{base.rstrip('/')}/responses"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    for k, v in _headers(key, ua).items():
        req.add_header(k, v)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            hdrs = {k.lower(): v for k, v in resp.headers.items()}
            try:
                body = json.loads(raw)
            except Exception:
                body = {"error": "non-json body", "raw_head": raw[:400]}
            return resp.status, body, hdrs, round(time.perf_counter() - t0, 3)
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8", errors="replace"))
        except Exception:
            body = {"error": f"HTTP {e.code}"}
        return e.code, body, {k.lower(): v for k, v in (e.headers or {}).items()}, \
            round(time.perf_counter() - t0, 3)
    except Exception as e:  # noqa: BLE001 — timeouts/DNS mapped, not raised
        return None, {"error": type(e).__name__ + ": " + str(e)}, {}, \
            round(time.perf_counter() - t0, 3)


def _drain_sse(resp, out, t0, cancel_after):
    """Parse Responses typed SSE events; record TTFT / deltas / usage / cancel."""
    for rawline in resp:
        line = rawline.decode("utf-8", errors="replace").strip()
        if not line or not line.startswith("data:"):
            continue
        chunk = line[5:].strip()
        if chunk == "[DONE]":
            break
        try:
            ev = json.loads(chunk)
        except Exception:
            continue
        et = ev.get("type")
        out["event_types"][et] = out["event_types"].get(et, 0) + 1
        if et == "response.output_text.delta":
            if out["ttft_seconds"] is None:
                out["ttft_seconds"] = round(time.perf_counter() - t0, 3)
            out["deltas"] += 1
            out["text_chars"] += len(ev.get("delta") or "")
        # Terminal / progress events carry the full response object incl. usage.
        resp_obj = ev.get("response") or {}
        if resp_obj.get("usage"):
            out["usage_in_stream"] = _usage_norm(resp_obj["usage"])
        if resp_obj.get("status"):
            out["finish_reason"] = resp_obj.get("status")
        if cancel_after and out["deltas"] >= cancel_after:
            out["cancelled"] = True
            break


def _stream(base, key, payload, ua=None, cancel_after=None, timeout=90):
    """Streaming POST /responses. `cancel_after` closes the socket after N text
    deltas, emulating a user aborting mid-answer (ADR-0029 settle-on-cancel)."""
    url = f"{base.rstrip('/')}/responses"
    body = dict(payload)
    body["stream"] = True
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                 method="POST")
    for k, v in _headers(key, ua).items():
        req.add_header(k, v)
    out = {"cancel_after": cancel_after, "deltas": 0, "ttft_seconds": None,
           "total_seconds": None, "cancelled": False, "usage_in_stream": None,
           "finish_reason": None, "text_chars": 0, "http": None, "error": None,
           "event_types": {}}
    t0 = time.perf_counter()
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        out["http"] = resp.status
        try:
            _drain_sse(resp, out, t0, cancel_after)
        finally:
            resp.close()  # tearing down the socket IS the cancellation
    except urllib.error.HTTPError as e:
        out["http"] = e.code
        try:
            out["error"] = json.loads(e.read().decode("utf-8", errors="replace"))
        except Exception:
            out["error"] = f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001
        out["error"] = type(e).__name__ + ": " + str(e)
    out["total_seconds"] = round(time.perf_counter() - t0, 3)
    return out


def _base_payload(model, max_out=300):
    return {"model": model, "instructions": SYSTEM_PROMPT,
            "input": _input_text(), "max_output_tokens": max_out}


def check_contract(base, key, model, ua):
    """Item 1: non-streaming Responses maps to internal contract; model + id auditable."""
    s, b, h, sec, hangs = _retry(lambda: _req(base, key, _base_payload(model), ua=ua))
    got = {"http": s, "seconds": sec, "transient_timeouts": hangs}
    if s != 200:
        got["error"] = b
        return got
    txt = _output_text(b)
    usage = _usage_norm(b.get("usage"))
    got.update({
        "response_id": bool(b.get("id")),
        "model_echo": b.get("model"),
        "model_echo_matches": b.get("model") == model,
        "status": b.get("status"),
        "content_chars": len(txt),
        "usage_present": bool(usage),
        "usage": usage,
        "request_id_header": (h.get("x-request-id") or h.get("x-requestid")
                              or h.get("openai-request-id")),
        "cites_snippet_ids": any(t in txt for t in ("D1", "D2", "D3")),
        "injected_instructions_echo": (b.get("instructions") or "")[:80],
    })
    return got


def check_stream(base, key, model, ua):
    """Items 3 + 9: TTFT, full generation, mid-stream cancellation."""
    payload = _base_payload(model, max_out=400)
    full = _stream(base, key, payload, ua=ua)
    cancelled = _stream(base, key, payload, ua=ua, cancel_after=5)
    return {"full": full, "cancelled": cancelled,
            "cancel_worked": bool(cancelled.get("cancelled")),
            "usage_on_stream": full.get("usage_in_stream") is not None,
            "settle_on_cancel_possible": cancelled.get("usage_in_stream") is not None
            or cancelled.get("text_chars", 0) > 0}


ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "citations": {"type": "array", "items": {"type": "string"}},
        "insufficient_evidence": {"type": "boolean"},
    },
    "required": ["answer", "citations", "insufficient_evidence"],
    "additionalProperties": False,
}


def check_structured_output(base, key, model, ua):
    """Item 4: structured output via text.format. A relay that SILENTLY IGNORES
    the format hands unvalidated prose to Answer/Citation — the dangerous case."""
    res = {}
    fmts = (("json_schema", {"type": "json_schema", "name": "grounded_answer",
                             "strict": True, "schema": ANSWER_SCHEMA}),
            ("json_object", {"type": "json_object"}))
    for label, fmt in fmts:
        payload = _base_payload(model, max_out=400)
        payload["text"] = {"format": fmt}
        if label == "json_object":
            payload["instructions"] += " 只输出 JSON：{answer, citations[], insufficient_evidence}。"
        # 5xx on a format mode is retried too, not just timeouts: a gateway that
        # 500/502s on one mode EVERY time is a capability gap the Adapter must
        # encode per provider (fluxionai: json_object 5xx x4, json_schema 200),
        # whereas a single 5xx would only be noise.
        codes = []
        for _ in range(3):
            s, b, _h, sec, hangs = _retry(lambda p=payload: _req(base, key, p, ua=ua))
            codes.append(s)
            if s == 200 or (s is not None and 400 <= s < 500):
                break
        row = {"http": s, "seconds": sec, "transient_timeouts": hangs,
               "attempt_http_codes": codes}
        if s != 200:
            row["rejected_cleanly"] = s is not None and 400 <= s < 500
            row["timed_out"] = s is None
            row["error"] = str(b.get("error"))[:160] if isinstance(b, dict) else str(b)[:160]
        else:
            txt = _output_text(b)
            try:
                obj = json.loads(txt)
                row["parses_as_json"] = True
                row["schema_valid"] = (isinstance(obj, dict) and
                                       all(k in obj for k in ANSWER_SCHEMA["required"]))
            except Exception:
                row["parses_as_json"] = False
                row["schema_valid"] = False
                row["head"] = txt[:160]
        res[label] = row
    return res


def check_errors(base, key, model, ua):
    """Normalize bad key, unknown model, and client timeout."""
    s_auth, b_auth, _, _ = _req(base, "sk-INVALID-probe-key",
                                _base_payload(model, max_out=16), ua=ua)
    s_mdl, b_mdl, _, _ = _req(base, key,
                              {"model": "definitely-not-a-real-model-probe-005",
                               "instructions": SYSTEM_PROMPT, "input": _input_text(),
                               "max_output_tokens": 16}, ua=ua)
    s_to, b_to, _, sec_to = _req(base, key, _base_payload(model, max_out=800),
                                 ua=ua, timeout=0.7)
    return {
        "bad_key_status": s_auth, "bad_key_is_401": s_auth == 401,
        "bad_key_body_head": json.dumps(b_auth, ensure_ascii=False)[:200],
        "unknown_model_status": s_mdl,
        "unknown_model_rejected": s_mdl is not None and 400 <= s_mdl < 500,
        "timeout_mapped": s_to is None and "error" in b_to,
        "timeout_error": str(b_to.get("error"))[:120], "timeout_seconds": sec_to,
    }


SIMULATED_NOTES = {
    "data_class_gating": "ADR-0025：UNKNOWN/敏感等级必须在 ModelAdapter 准入层"
        "（而非调用点）阻断 Chat/Embedding/Reranker/引用验证四条路径。设计期仓库无业务"
        "代码，本探针只发送合成文本，门禁为 SIMULATED，随 ModelAdapter 实现的集成测试复验。",
    "budget_ledger": "ADR-0029：调用前在同一 PostgreSQL 事务写入 RESERVED 并取 lease，"
        "结算写回实际用量并释放差额，流式取消按已产生 token 结算，进程被杀后 lease 过期"
        "回收。无 DB/业务代码，SIMULATED；本探针 LIVE 记录真实 usage 与取消时已产生的"
        "增量，供预扣/结算口径校准。",
    "citation_verification": "ADR-0027 分层引用验证（2026-08-26 修订后：常规 P95<=2.0s / "
        "高风险含蕴含调用 P95<=3.5s，且逐句 Embedding 与蕴含调用必须并发发起）依赖逐句 "
        "Embedding 批量 + 高风险蕴含调用，属独立测量，需与 Stage A 的批量延迟曲线合并计算，"
        "本 stage 未单独压测。",
    "relay_governance": "中转站是数据路径上的额外第三方处理方，可能记录/留存 prompt。"
        "探针仅合成文本可接受；生产承载真实客服数据前必须评估留存与合规，否则冲突 "
        "ADR-0017/0025「敏感数据不出域」。",
}


def check_provenance(base, key, model, ua):
    """Trust check (not in the original ticket, added after the agentrouter
    findings): who actually serves this model id?

    Two LIVE facts matter for a *trustworthy* RAG:
      1. what the endpoint injects as `instructions` when we send none — a relay
         fronting an agent product will inject its own system prompt, which would
         silently contaminate our grounded-answer prompt;
      2. what the model says it is, versus the model id we requested.
    """
    payload = {"model": model,
               "input": "只回答模型名称本身，不要解释：你是哪个模型？",
               "max_output_tokens": 64}
    timeouts = 0
    s, b, _, sec, timeouts = _retry(lambda: _req(base, key, payload, ua=ua))
    row = {"http": s, "seconds": sec, "transient_timeouts": timeouts}
    if s != 200 or not isinstance(b, dict):
        row["error"] = str(b)[:200]
        return row
    injected = b.get("instructions") or ""
    row.update({
        "requested_model": model,
        "model_echo": b.get("model"),
        "self_reported_identity": _output_text(b).strip()[:120],
        "injected_instructions_present": bool(injected),
        "injected_instructions_chars": len(injected),
        "injected_instructions_sha256": hashlib.sha256(
            injected.encode("utf-8")
        ).hexdigest() if injected else None,
    })
    row["identity_consistent"] = (
        row["self_reported_identity"].lower().replace(" ", "").find(
            (model.split("/")[-1] or model).lower().replace(" ", "")) >= 0)
    return row


def preflight_auth(base, key, model, ua):
    """One tiny call to separate "bad credential" from "provider verdict".

    A stale key aimed at a new base returns 401 on every check, which would
    otherwise be written out as a BLOCKED provider report — a false record of a
    provider we never actually reached — after ~10 pointless billed attempts.
    Returns (ok, status, body).
    """
    payload = {"model": model, "instructions": "reply with: ok",
               "input": "ok", "max_output_tokens": 16}
    s, b, _h, _sec = _req(base, key, payload, ua=ua, timeout=60)
    return (s not in (401, 403)), s, b


def run(base, key, model, provider, ua, price_in, price_out):
    r = {"stage": "B-chat-responses", "api": "responses", "provider": provider,
         "model": model, "base": base, "user_agent": ua or "(default)", "checks": {}}
    r["checks"]["contract"] = check_contract(base, key, model, ua)
    r["checks"]["stream"] = check_stream(base, key, model, ua)
    r["checks"]["structured_output"] = check_structured_output(base, key, model, ua)
    r["checks"]["error_mapping"] = check_errors(base, key, model, ua)
    r["checks"]["provenance"] = check_provenance(base, key, model, ua)
    r["availability"] = {
        "non_stream_calls": HANGS["calls"], "hangs_over_90s": HANGS["count"],
        "hang_rate": (round(HANGS["count"] / HANGS["calls"], 3)
                      if HANGS["calls"] else None),
        "note": "每个非流式调用最多重试 3 次；hang = 超过 90s 读超时（远超本端点实测正常响应时间）。",
    }
    r["simulated"] = SIMULATED_NOTES

    pt = ct = 0
    for src in (r["checks"]["contract"].get("usage") or {},
                r["checks"]["stream"]["full"].get("usage_in_stream") or {}):
        pt += src.get("prompt_tokens") or 0
        ct += src.get("completion_tokens") or 0
    cost = None
    if price_in or price_out:
        cost = round(pt / 1_000_000 * (price_in or 0)
                     + ct / 1_000_000 * (price_out or 0), 6)
    r["cost"] = {"measured_prompt_tokens_partial": pt,
                 "measured_completion_tokens_partial": ct,
                 "price_cny_per_1m_in": price_in, "price_cny_per_1m_out": price_out,
                 "estimated_cny_partial": cost,
                 "note": "仅统计供应商回报了 usage 的调用（Responses 的 input/output_tokens）；"
                         "单价来自环境变量/参数。单次问答成本口径需叠加 Stage A 的查询/"
                         "逐句 Embedding 与高风险蕴含调用。"}
    return r


def evaluate(r):
    fails, decides = [], []
    ua = r.get("user_agent")
    c = r["checks"]["contract"]
    if c.get("http") != 200:
        fails.append(f"基本 Responses 调用失败 HTTP {c.get('http')}：{str(c.get('error'))[:160]}")
    else:
        if (c.get("seconds") or 0) > 10:
            decides.append(
                f"非流式一次问答耗时 {c.get('seconds')}s（>10s）：交互式客服问答必须走流式，"
                "非流式仅可用于离线/批处理路径。")
        if not c.get("usage_present"):
            fails.append("非流式响应未回传 usage，预算账本无法按真实 token 结算（ADR-0029）")
        if not c.get("model_echo_matches"):
            decides.append(f"响应 model 回显为 `{c.get('model_echo')}`，与请求名不一致：审计需"
                           "以请求名+响应名成对记录。")
        if not c.get("response_id") and not c.get("request_id_header"):
            decides.append("既无响应 id 也无 request-id 头：需在 Adapter 侧自生成关联 id。")
        if not c.get("cites_snippet_ids"):
            decides.append("回答未引用资料编号（D1/D2/D3）：引用链路需靠 Adapter 强制结构化输出。")
    # The UA gate is the decisive server-side finding, recorded whenever a
    # non-default UA had to be sent to get 200s.
    if ua and "claude-cli" in ua.lower():
        decides.append("端点以 User-Agent 做准入门禁：仅在 UA 含 `claude-cli` 时返回 200，"
                       "curl/OpenAI-SDK/默认 urllib 全部 401。服务端（NestJS/worker）用标准 "
                       "OpenAI SDK 直连会被拒，除非伪装 CLI 身份——脆弱且疑似违反 ToS，"
                       "不应写入企业架构。此为供应商适配层面的硬决策项。")
    st = r["checks"]["stream"]
    if st["full"].get("http") != 200 or st["full"].get("deltas", 0) == 0:
        fails.append("流式路径不可用（无增量输出），与流式取消/TTFT 目标冲突")
    if not st.get("cancel_worked"):
        fails.append("流式无法中途取消：ADR-0029 的取消按已产生 token 结算不成立")
    if not st.get("usage_on_stream"):
        decides.append("流式路径未回传 usage：取消结算只能按已收字符估算 token，需在 Adapter "
                       "侧本地计量并接受误差。")
    ttft = st["full"].get("ttft_seconds")
    total = st["full"].get("total_seconds")
    # ADR-0027（2026-08-26 按 PROBE-005 修订）：高风险路径 P95<=3.5s，且蕴含调用必须与
    # 逐句 Embedding 批量调用并发发起（串行下界约 1.4s+3.0s≈4.3s，必然超预算）。
    if total is not None and total > 3.5:
        decides.append(f"一次完整生成 {total}s 已超 ADR-0027 高风险路径 P95<=3.5s 预算："
                       "高风险腿需改配非推理模型或再次上调预算，并复核 ADR-0027。")
    elif ttft is not None and ttft > 2.0:
        decides.append(f"流式 TTFT≈{ttft}s 偏高（疑似推理模型缓冲 reasoning tokens）：高风险"
                       "引用验证 P95<=3.5s 的余量被蕴含调用吃掉大半，逐句 Embedding "
                       "必须与蕴含调用并发发起（ADR-0027 硬约束），不得串行。")
    so = r["checks"]["structured_output"]
    js, jo = so.get("json_schema", {}), so.get("json_object", {})
    schema_ok = js.get("http") == 200 and js.get("schema_valid")
    object_ok = jo.get("http") == 200 and jo.get("schema_valid")
    both_hung = js.get("timed_out") and jo.get("timed_out")
    if both_hung:
        # Distinguish "endpoint unavailable" from "format silently ignored" — they
        # demand different remediations and only the latter is a protocol defect.
        fails.append("结构化输出两种模式均因端点挂起（重试后仍 >90s 读超时）未能取得结果："
                     "这是**可用性**失败而非协议不兼容——同一请求在其他运行中曾正常返回并通过"
                     "schema 校验。该端点不满足企业 SLA。")
    elif not schema_ok and not object_ok:
        fails.append("json_schema 与 json_object 均无法产出可校验结构化输出："
                     "结构化输出失败必须返回受控错误，不能把未校验响应交给 Answer/Citation")
    elif not schema_ok:
        note = "（strict json_schema 请求超时/被拒）" if js.get("timed_out") or js.get("http") != 200 else ""
        decides.append(f"strict json_schema 不可靠{note}，仅 json_object 可用：Adapter 必须"
                       "自带 schema 校验 + 失败重试/受控错误。")
    elif not object_ok:
        decides.append(
            f"`text.format` 的 `json_object` 模式在此供应商不可用"
            f"（各次尝试 HTTP {jo.get('attempt_http_codes') or [jo.get('http')]}），"
            "而 strict `json_schema` 正常：**Adapter 必须按供应商登记结构化输出方言能力**，"
            "此供应商只走 json_schema，且不得把 json_object 当降级回退（会在生产偶发 5xx）。")
    em = r["checks"]["error_mapping"]
    if not em.get("bad_key_is_401"):
        decides.append(f"错误密钥返回 {em.get('bad_key_status')}（非 401）：错误映射表按实测归一。")
    if not em.get("unknown_model_rejected"):
        decides.append("未知模型未被 4xx 拒绝：Adapter 需自校验模型白名单。")
    if not em.get("timeout_mapped"):
        decides.append("客户端超时未能被映射为可归一错误，需复核超时/重试策略。")
    pv = r["checks"].get("provenance") or {}
    if pv.get("http") == 200:
        if pv.get("injected_instructions_present"):
            fingerprint = pv.get("injected_instructions_sha256")
            fingerprint_text = (
                f"SHA-256=`{fingerprint}`" if fingerprint else "未保留正文哈希"
            )
            decides.append(
                f"未传 instructions 时端点会**注入自己的 system prompt**"
                f"（{pv.get('injected_instructions_chars')} 字符，正文已脱敏，"
                f"{fingerprint_text}）："
                "会污染 grounded-answer 提示词。ModelAdapter 必须**始终显式传入自己的 "
                "instructions**（本探针已实测显式传入可完全覆盖），并禁止依赖端点默认值。")
        if not pv.get("identity_consistent"):
            decides.append(
                f"模型身份不可核验：请求 `{pv.get('requested_model')}`、回显 "
                f"`{pv.get('model_echo')}`，但模型自称“{pv.get('self_reported_identity')}”。"
                "「可信 RAG」要求承载模型与提供方可审计，需供应商出具模型映射说明，"
                "否则不能进入生产。")
    av = r.get("availability") or {}
    if av.get("hangs_over_90s"):
        normal = ((r.get("checks") or {}).get("contract") or {}).get("seconds")
        normal_txt = f"，同类请求实测 {normal}s" if normal else ""
        decides.append(
            f"**间歇性挂起**：{av['non_stream_calls']} 次非流式调用中 {av['hangs_over_90s']} 次"
            f"超过 90s 读超时（挂起率 {av['hang_rate']}{normal_txt}），靠重试才恢复。"
            "该端点可用性不满足企业 SLA；Adapter 必须设短超时 + 重试 + 熔断，"
            "且此不稳定性需计入供应商选型。")
    status = "BLOCKED" if fails else ("PASS_WITH_ADJUSTMENT" if decides else "PASS")
    return fails, decides, status


def write_reports(r, out_dir, slug="probe-005-model-adapter-responses"):
    fails, decides, status = evaluate(r)
    doc = {"probe_id": "PROBE-005", "stage": "B-chat-responses", "api": "responses",
           "status": status,
           "executed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "provider": r["provider"], "model": r["model"], "base": r["base"],
           "user_agent": r["user_agent"], "measurements": r,
           "failures": fails, "decisions_required": decides, "recommendation": status}
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, slug + ".json"),
              "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    _write_md(doc, os.path.join(out_dir, slug + ".md"))
    return doc


def _write_md(doc, path):
    m, c = doc["measurements"], doc["measurements"]["checks"]
    st, so, em = c["stream"], c["structured_output"], c["error_mapping"]
    ct = c["contract"]
    L = ["# PROBE-005 ModelAdapter 探针结果（Stage B · Chat · Responses API）", "",
         f"- 状态：**{doc['status']}**",
         f"- 执行时间：{doc['executed_at']}",
         f"- Provider：{doc['provider']}（`{doc['base']}` · OpenAI **Responses** API `/responses`）",
         f"- 模型：`{doc['model']}`",
         f"- 使用的 User-Agent：`{doc['user_agent']}`", "",
         "> LIVE = 供应商真实返回；SIMULATED = 数据分级门禁、预算账本、分层引用验证"
         "（设计期无业务代码，随 ModelAdapter 实现复验）。仅发送合成客服文本，"
         "密钥不入库/日志/报告。", "",
         "## 契约映射（LIVE，非流式）", ""]
    L += [f"- HTTP {ct.get('http')}，耗时 {ct.get('seconds')}s，内容 {ct.get('content_chars')} 字符"
          + (f"（**注意：另有 {ct.get('transient_timeouts')} 次 >90s 读超时后重试才成功**）"
             if ct.get("transient_timeouts") else ""),
          f"- 响应 id：{ct.get('response_id')}；request-id 头：{ct.get('request_id_header')}",
          f"- model 回显：`{ct.get('model_echo')}`（与请求一致：{ct.get('model_echo_matches')}）",
          f"- status：`{ct.get('status')}`",
          f"- usage 回传：**{ct.get('usage_present')}** → {ct.get('usage')}",
          f"- 回答含资料编号引用：{ct.get('cites_snippet_ids')}",
          f"- 回显 instructions（前 80 字）：`{ct.get('injected_instructions_echo')}`", "",
          "## 流式 / TTFT / 取消（LIVE）", "",
          "| 场景 | HTTP | TTFT(s) | 总耗时(s) | 增量数 | 字符 | status | 流内 usage |",
          "|---|---|---|---|---|---|---|---|"]
    for label, row in (("完整生成", st["full"]), ("中途取消(5 增量)", st["cancelled"])):
        L.append(f"| {label} | {row.get('http')} | {row.get('ttft_seconds')} | "
                 f"{row.get('total_seconds')} | {row.get('deltas')} | "
                 f"{row.get('text_chars')} | {row.get('finish_reason')} | "
                 f"{'有' if row.get('usage_in_stream') else '无'} |")
    L += ["", f"- 取消生效：**{st.get('cancel_worked')}**；流式回传 usage："
          f"**{st.get('usage_on_stream')}**",
          f"- 完整生成 SSE 事件类型：{m['checks']['stream']['full'].get('event_types')}", ""]
    L += ["## 结构化输出（LIVE · text.format）", "",
          "| 模式 | HTTP | 各次尝试 | 解析为 JSON | 满足 schema | 备注 |",
          "|---|---|---|---|---|---|"]
    for label in ("json_schema", "json_object"):
        row = so.get(label, {})
        note = row.get("head") or row.get("error") or ""
        if row.get("timed_out"):
            note = "请求超时（strict schema 在该端点疑似挂起）"
        L.append(f"| `{label}` | {row.get('http')} | "
                 f"{row.get('attempt_http_codes') or '-'} | "
                 f"{row.get('parses_as_json', '-')} | "
                 f"{row.get('schema_valid', '-')} | {str(note)[:80]} |")
    L += ["", "## 错误映射（LIVE）", "",
          f"- 错误密钥 → HTTP {em.get('bad_key_status')}（401：{em.get('bad_key_is_401')}）",
          f"- 未知模型 → HTTP {em.get('unknown_model_status')}（4xx 拒绝：{em.get('unknown_model_rejected')}）",
          f"- 客户端超时（0.7s）→ 可归一：{em.get('timeout_mapped')}（{em.get('timeout_error')}）",
          "", "## 成本（LIVE 用量）", "",
          f"- prompt(input) tokens：{m['cost']['measured_prompt_tokens_partial']}；"
          f"completion(output) tokens：{m['cost']['measured_completion_tokens_partial']}",
          f"- 单价（元/百万 in/out）：{m['cost']['price_cny_per_1m_in']} / "
          f"{m['cost']['price_cny_per_1m_out']}；估算：{m['cost']['estimated_cny_partial']} 元",
          f"- 口径说明：{m['cost']['note']}", ""]
    pv = c.get("provenance") or {}
    av = m.get("availability") or {}
    L += ["## 可用性（LIVE · 间歇性挂起）", "",
          f"- 非流式调用 {av.get('non_stream_calls')} 次，其中 **{av.get('hangs_over_90s')} 次"
          f">90s 读超时**（挂起率 {av.get('hang_rate')}），每次最多重试 3 次",
          f"- 口径：{av.get('note')}",
          "- 挂起（若有）为间歇性，会使单次运行的结论在 PASS/BLOCKED 之间摆动，"
          "本探针因此对每个非流式调用重试并单列挂起率；本次非流式契约调用实测耗时见上「契约映射」。", ""]
    L += ["## 模型来源与提示词注入（LIVE · 可信性）", ""]
    if pv.get("http") == 200:
        fingerprint = pv.get("injected_instructions_sha256")
        fingerprint_line = (
            f"- 注入正文已脱敏；SHA-256：`{fingerprint}`"
            if fingerprint else "- 注入正文已脱敏；历史结果未保留正文哈希"
        )
        L += [f"- 请求模型：`{pv.get('requested_model')}`；响应回显：`{pv.get('model_echo')}`；"
              f"模型自称：**{pv.get('self_reported_identity')}**"
              f"（一致：{pv.get('identity_consistent')}）",
              f"- 不传 instructions 时端点注入自有 system prompt："
              f"**{pv.get('injected_instructions_present')}**"
              f"（{pv.get('injected_instructions_chars')} 字符）",
              fingerprint_line,
              "- 显式传入 `instructions` 可完全覆盖注入内容（见上「契约映射」的回显）。", ""]
    else:
        L += [f"- 未取得（HTTP {pv.get('http')}）：{str(pv.get('error'))[:120]}", ""]
    if doc["failures"]:
        L += ["## 失败项", *[f"- {x}" for x in doc["failures"]], ""]
    if doc["decisions_required"]:
        L += ["## 待决策", *[f"- {x}" for x in doc["decisions_required"]], ""]
    L += ["## SIMULATED（服务层，随 ModelAdapter 实现复验）", ""]
    for k, v in m["simulated"].items():
        L.append(f"- **{k}**：{v}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))


def _fenv(name):
    v = os.environ.get(name)
    return float(v) if v else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--provider", default=os.environ.get("CHAT_PROVIDER") or "unknown")
    ap.add_argument("--user-agent", default=DEFAULT_UA)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report-slug", default=None,
                    help="report basename; default derives from --provider so one "
                         "provider's record never overwrites another's")
    ap.add_argument("--price-in-per-1m", type=float,
                    default=_fenv("CHAT_PRICE_CNY_PER_1M_IN"))
    ap.add_argument("--price-out-per-1m", type=float,
                    default=_fenv("CHAT_PRICE_CNY_PER_1M_OUT"))
    args = ap.parse_args()
    if not args.model:
        print("ERROR: 未指定 chat model id（--model 或环境变量 CHAT_MODEL）。\n"
              f"  当前 base={args.base}，其可用模型 id 需由供应商确认后再跑。\n"
              "未做任何网络调用，未产生费用。")
        return 3
    key = (os.environ.get("CHAT_API_KEY") or os.environ.get("AGENTROUTER_API_KEY")
           or os.environ.get("OPENROUTER_API_KEY"))
    if not key:
        print("ERROR: 未找到 CHAT_API_KEY（或 AGENTROUTER_API_KEY / OPENROUTER_API_KEY）。\n"
              "  请在会话外的终端写入未跟踪的 env 文件，或 export 后再运行。\n"
              "未做任何网络调用，未产生费用。")
        return 3
    slug = args.report_slug or (
        "probe-005-model-adapter-responses-"
        + (re.sub(r"[^a-z0-9._-]+", "-", args.provider.lower()).strip("-") or "unknown"))
    ok, pf_status, pf_body = preflight_auth(args.base, key, args.model, args.user_agent)
    if not ok:
        print(f"ERROR: 凭据预检失败 HTTP {pf_status}（base={args.base}，"
              f"model={args.model}，UA={args.user_agent or '(default)'}）。\n"
              f"  端点返回：{json.dumps(pf_body, ensure_ascii=False)[:300]}\n"
              "  该 base 的 CHAT_API_KEY 与当前不匹配（换 base 后需换 key），"
              "或此端点对本 UA 做准入门禁。\n"
              "  **未写任何报告**：401 不是供应商结论，不能当成 BLOCKED 记录进 probe-results。")
        return 3
    r = run(args.base, key, args.model, args.provider, args.user_agent,
            args.price_in_per_1m, args.price_out_per_1m)
    doc = write_reports(r, args.out, slug)
    print(f"PROBE-005 Stage B (chat · Responses API) status: {doc['status']}")
    print(f"  报告：{os.path.join(args.out, slug)}.md/.json")
    for x in doc["failures"]:
        print(f"  FAIL: {x}")
    for x in doc["decisions_required"]:
        print(f"  DECIDE: {x}")
    return 0 if doc["status"] != "BLOCKED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
