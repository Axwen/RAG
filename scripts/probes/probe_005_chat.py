#!/usr/bin/env python3
"""PROBE-005 (Stage B, Chat leg) — OpenAI **Chat Completions** (/v1/chat/completions).

Companion to probe_005_responses.py (the /responses leg). The chat provider was
switched to StepFun (阶跃星辰) on 2026-08-26; StepFun exposes OpenAI-compatible
Chat Completions and Anthropic-compatible Messages, but NO Responses API, so the
Chat leg runs on /chat/completions here. Unlike agentrouter/fluxionai (relays /
中转站 fronting an unnamed upstream), StepFun is a FIRST-PARTY foundation-model
provider serving its own Step family, so the model-identity and injected-prompt
findings that blocked the relays are expected to come back clean — this probe
verifies that rather than assuming it.

What it measures (LIVE): request/response contract mapping, model echo /
auditability, TTFT + full generation, mid-stream cancellation, streaming usage
(needed to settle a cancelled stream per ADR-0029), structured output via
response_format json_schema/json_object, error normalization, provenance
(self-reported identity vs requested id), availability (hang rate), and real cost
from usage token counts.

REASONING-MODEL SPECIFICS (step-3.5-flash). Its chain-of-thought comes back in a
SEPARATE field (`message.reasoning_content`) and spends the SAME `max_tokens`
budget as the visible answer. Two probe-artifact false verdicts came out of
ignoring that, both since fixed and both worth remembering as a class:

  * "json_object 不可用" — actually HTTP 200 + finish_reason=length + 0-char answer
    because the CoT ate all 400 tokens. TRUNCATION IS NOT A CAPABILITY GAP; the
    probe now escalates max_tokens once and judges support at the larger budget.
  * "模型身份不可核验（自称『』）" — same cause with max_tokens=64. Given 512 the
    model answers "Step".

Same class of error as the Stage C 429 contamination: an operational condition on
OUR side of the call read as a provider contract verdict. So finish_reason,
reasoning_chars, and the requested max_tokens are recorded on every row and judged
separately, and check_reasoning_accounting() additionally pins down whether the
CoT is broken out in usage (it is not: reasoning_tokens = 0) and whether
`reasoning_effort` actually does anything (it does not).

SIMULATED (unchanged, no business code yet): ADR-0025 data-class gating, ADR-0029
budget ledger, ADR-0027 tiered citation verification.

--report-slug keeps each provider's fact record separate (default derives from
--provider): the point of the probe is provider comparison for the ADR-0017
decision, so a new provider must never overwrite a previous provider's report.

Secrets: key ONLY from env (CHAT_API_KEY / STEPFUN_API_KEY / OPENROUTER_API_KEY);
never logged, echoed, or written to any report. Only synthetic de-identified text.
"""
import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_BASE = os.environ.get("CHAT_BASE", "https://api.stepfun.com/v1")
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



def _messages(system=SYSTEM_PROMPT):
    msgs = []
    if system is not None:
        msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": "【资料】\n" + "\n".join(CONTEXT_SNIPPETS)
                                             + f"\n\n【问题】{QUESTION}"})
    return msgs


def _headers(key, ua):
    h = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if ua:
        h["User-Agent"] = ua
    return h


# Any endpoint can stall past even a 90 s read timeout intermittently. Left
# unhandled that flips the whole verdict run-to-run, so every non-streaming call
# site retries and every hang is counted here: the hang RATE is the availability
# finding we report (StepFun was clean on the relays' failure modes; verify it).
HANGS = {"count": 0, "calls": 0}


def _retry(fn, attempts=3):
    """Call fn() until it returns a non-None HTTP status. fn returns
    (status, body, headers, seconds). Counts hangs globally."""
    hangs = 0
    s = b = h = sec = None
    for _ in range(attempts):
        s, b, h, sec = fn()
        HANGS["calls"] += 1
        if s is not None:
            return s, b, h, sec, hangs
        hangs += 1
        HANGS["count"] += 1
    return s, b, h, sec, hangs


def _content(body):
    """First choice message content (the VISIBLE answer) of a Chat Completions
    object. Deliberately excludes `reasoning_content` — see _reasoning()."""
    ch = (body.get("choices") or [{}])[0]
    return (ch.get("message") or {}).get("content") or ""


def _reasoning(body):
    """Visible-answer-adjacent CoT that step-3.5-flash returns in a SEPARATE
    field (`reasoning_content`, plus a `reasoning` alias). It is billed inside
    completion_tokens and consumes max_tokens, so ignoring it produces two false
    conclusions: an "empty answer" and a "format unsupported" — both observed."""
    msg = ((body.get("choices") or [{}])[0].get("message") or {})
    return msg.get("reasoning_content") or msg.get("reasoning") or ""


def _finish(body):
    return (body.get("choices") or [{}])[0].get("finish_reason")


def _usage_norm(u):
    """Chat usage is already (prompt/completion/total); keep reasoning/cached if any."""
    if not u:
        return {}
    return {"prompt_tokens": u.get("prompt_tokens"),
            "completion_tokens": u.get("completion_tokens"),
            "total_tokens": u.get("total_tokens"),
            "reasoning_tokens": (u.get("completion_tokens_details") or {}).get("reasoning_tokens"),
            "cached_tokens": (u.get("prompt_tokens_details") or {}).get("cached_tokens")}


class Pacer:
    """Keep request starts under the account's RPM ceiling.

    StepFun answers `request limited RPM reached, current: 11, limit: 10` on this
    account tier. An unpaced run of this probe lost the provenance call and 2 of 3
    high-effort samples to 429 — i.e. our own burst rate, not the provider's
    contract, decided two findings. Same class of error as the Stage C 429
    contamination. Requests are therefore paced to the ceiling and 429s are backed
    off and retried, never recorded as a contract result."""

    def __init__(self, rpm=0):
        self.rpm = int(rpm or 0)
        self.starts = []

    def wait(self):
        if self.rpm <= 0:
            return
        while True:
            now = time.monotonic()
            self.starts = [t for t in self.starts if now - t < 60.0]
            if len(self.starts) < self.rpm:
                self.starts.append(now)
                return
            time.sleep(max(0.5, 60.0 - (now - self.starts[0]) + 0.5))


PACER = Pacer(0)
RATE = {"absorbed_429": 0, "wait_seconds": 0.0}
# reasoning_effort applied to every payload (None = omit the field entirely).
EFFORT = None


def _pace_and_backoff(issue, is_429, attempts=4):
    """Run `issue()`, absorbing 429s with backoff so they never become findings."""
    for attempt in range(attempts + 1):
        PACER.wait()
        res = issue()
        if attempt == attempts or not is_429(res):
            return res
        RATE["absorbed_429"] += 1
        nap = min(60.0, 8.0 * (attempt + 1))  # no retry-after header is sent
        RATE["wait_seconds"] += nap
        time.sleep(nap)


def _req(base, key, payload, ua=None, timeout=90):
    """Non-streaming POST /chat/completions, paced and 429-retried."""
    return _pace_and_backoff(lambda: _req_once(base, key, payload, ua=ua, timeout=timeout),
                             lambda r: r[0] == 429)


def _req_once(base, key, payload, ua=None, timeout=90):
    """One non-streaming POST. Maps errors, never raises."""
    url = f"{base.rstrip('/')}/chat/completions"
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
    """Parse chat SSE chunks; record TTFT / deltas / usage / cancellation.

    step-3.5-flash streams its CoT first as `delta.reasoning_content`, and only
    then the visible answer. Timing only the visible text would report a TTFT of
    ~= total generation time and hide the fact that SOMETHING streamable arrives
    within ~1 s, so both are measured: ttft_any_seconds (first event of any kind,
    what a progress indicator can show) vs ttft_seconds (first visible answer
    token, what the user can actually read)."""
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
        if ev.get("usage"):
            out["usage_in_stream"] = _usage_norm(ev["usage"])
        for ch in ev.get("choices") or []:
            if ch.get("finish_reason"):
                out["finish_reason"] = ch["finish_reason"]
            delta = ch.get("delta") or {}
            rpiece = delta.get("reasoning_content") or delta.get("reasoning") or ""
            if rpiece:
                if out["ttft_any_seconds"] is None:
                    out["ttft_any_seconds"] = round(time.perf_counter() - t0, 3)
                out["reasoning_deltas"] += 1
                out["reasoning_chars"] += len(rpiece)
            piece = delta.get("content") or ""
            if piece:
                now = round(time.perf_counter() - t0, 3)
                if out["ttft_any_seconds"] is None:
                    out["ttft_any_seconds"] = now
                if out["ttft_seconds"] is None:
                    out["ttft_seconds"] = now
                out["deltas"] += 1
                out["text_chars"] += len(piece)
        if cancel_after and out["deltas"] >= cancel_after:
            out["cancelled"] = True
            break


def _stream(base, key, payload, ua=None, cancel_after=None, timeout=90):
    """Streaming POST /chat/completions, paced and 429-retried."""
    return _pace_and_backoff(
        lambda: _stream_once(base, key, payload, ua=ua, cancel_after=cancel_after,
                             timeout=timeout),
        lambda r: r["http"] == 429)


def _stream_once(base, key, payload, ua=None, cancel_after=None, timeout=90):
    """One streaming POST. `cancel_after` closes the socket after N content deltas,
    emulating a user aborting mid-answer (ADR-0029 settle-on-cancel)."""
    url = f"{base.rstrip('/')}/chat/completions"
    body = dict(payload)
    body["stream"] = True
    # Ask for usage on the stream; some providers drop it — that IS the finding.
    body.setdefault("stream_options", {"include_usage": True})
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                 method="POST")
    for k, v in _headers(key, ua).items():
        req.add_header(k, v)
    out = {"cancel_after": cancel_after, "deltas": 0, "ttft_seconds": None,
           "ttft_any_seconds": None, "reasoning_deltas": 0, "reasoning_chars": 0,
           "total_seconds": None, "cancelled": False, "usage_in_stream": None,
           "finish_reason": None, "text_chars": 0, "http": None, "error": None}
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


def _base_payload(model, max_out=1200, system=SYSTEM_PROMPT):
    # max_out must cover CoT + visible answer: step-3.5-flash spends 300-750 chars
    # of reasoning_content out of the SAME max_tokens budget, so a "reasonable"
    # 300-400 silently yields finish_reason=length with an EMPTY answer.
    p = {"model": model, "messages": _messages(system),
         "max_tokens": max_out, "temperature": 0}
    if EFFORT:
        p["reasoning_effort"] = EFFORT
    return p


def check_contract(base, key, model, ua):
    """Item 1: non-streaming maps to internal contract; model + id auditable."""
    s, b, h, sec, hangs = _retry(lambda: _req(base, key, _base_payload(model), ua=ua))
    got = {"http": s, "seconds": sec, "transient_timeouts": hangs}
    if s != 200:
        got["error"] = b
        return got
    txt = _content(b)
    reasoning = _reasoning(b)
    usage = _usage_norm(b.get("usage"))
    got.update({
        "response_id": bool(b.get("id")),
        "model_echo": b.get("model"),
        "model_echo_matches": b.get("model") == model,
        "finish_reason": _finish(b),
        "content_chars": len(txt),
        "reasoning_chars": len(reasoning),
        "reasoning_field_present": bool(reasoning),
        "max_tokens_requested": _base_payload(model)["max_tokens"],
        "truncated": _finish(b) == "length",
        "usage_present": bool(usage),
        "usage": usage,
        "request_id_header": (h.get("x-request-id") or h.get("x-requestid")
                              or h.get("openai-request-id")),
        "cites_snippet_ids": any(t in txt for t in ("D1", "D2", "D3")),
    })
    return got


def check_stream(base, key, model, ua):
    """Items 3 + 9: TTFT, full generation, mid-stream cancellation."""
    payload = _base_payload(model)
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
    """Item 4: structured output via response_format. A provider that SILENTLY
    IGNORES the format hands unvalidated prose to Answer/Citation — the dangerous
    case — so we verify the response actually parses AND validates.

    TRUNCATION IS NOT A CAPABILITY GAP. With max_tokens=400 this endpoint returned
    HTTP 200 + finish_reason=length + an EMPTY answer (all 400 tokens went to 710
    chars of reasoning_content), which an earlier run mis-reported as "json_object
    unavailable at this provider" — the same class of false verdict as the Stage C
    429 contamination. finish_reason is therefore recorded and judged separately."""
    res = {}
    fmts = (("json_schema", {"type": "json_schema", "json_schema":
                             {"name": "grounded_answer", "strict": True,
                              "schema": ANSWER_SCHEMA}}),
            ("json_object", {"type": "json_object"}))
    for label, rf in fmts:
        system = SYSTEM_PROMPT
        if label == "json_object":
            system += " 只输出 JSON：{answer, citations[], insufficient_evidence}。"
        payload = _base_payload(model, system=system)
        payload["response_format"] = rf
        # Retry 5xx too, not just timeouts: a gateway that 500/502s on one mode
        # EVERY time is a capability gap the Adapter must encode per provider,
        # whereas a single 5xx is noise.
        codes = []
        s = b = sec = hangs = None
        for _ in range(3):
            s, b, _h, sec, hangs = _retry(lambda p=payload: _req(base, key, p, ua=ua))
            codes.append(s)
            if s == 200 or (s is not None and 400 <= s < 500):
                break
        row = {"http": s, "seconds": sec, "transient_timeouts": hangs,
               "attempt_http_codes": codes,
               "max_tokens_requested": payload["max_tokens"]}
        if s != 200:
            row["rejected_cleanly"] = s is not None and 400 <= s < 500
            row["timed_out"] = s is None
            row["error"] = str(b.get("error"))[:160] if isinstance(b, dict) else str(b)[:160]
        else:
            txt = _content(b)
            row["finish_reason"] = _finish(b)
            row["truncated"] = _finish(b) == "length"
            row["content_chars"] = len(txt)
            row["reasoning_chars"] = len(_reasoning(b))
            try:
                obj = json.loads(txt)
                row["parses_as_json"] = True
                row["schema_valid"] = (isinstance(obj, dict) and
                                       all(k in obj for k in ANSWER_SCHEMA["required"]))
            except Exception:
                row["parses_as_json"] = False
                row["schema_valid"] = False
                row["head"] = txt[:160]
            # Truncation is a probe-budget artifact, not a provider capability gap:
            # escalate max_tokens once and re-judge, so the report states what the
            # provider CAN do plus the token-budget constraint separately.
            if row["truncated"] and not row["schema_valid"]:
                big = _base_payload(model, max_out=payload["max_tokens"] * 2, system=system)
                big["response_format"] = rf
                s2, b2, _h2, sec2, _hg2 = _retry(lambda p=big: _req(base, key, p, ua=ua))
                retry = {"http": s2, "seconds": sec2,
                         "max_tokens_requested": big["max_tokens"]}
                if s2 == 200:
                    t2 = _content(b2)
                    retry["finish_reason"] = _finish(b2)
                    retry["truncated"] = _finish(b2) == "length"
                    retry["content_chars"] = len(t2)
                    retry["reasoning_chars"] = len(_reasoning(b2))
                    try:
                        o2 = json.loads(t2)
                        retry["parses_as_json"] = True
                        retry["schema_valid"] = (isinstance(o2, dict) and all(
                            k in o2 for k in ANSWER_SCHEMA["required"]))
                    except Exception:
                        retry["parses_as_json"] = False
                        retry["schema_valid"] = False
                        retry["head"] = t2[:160]
                else:
                    retry["error"] = str(b2)[:160]
                row["budget_escalation_retry"] = retry
                row["supported_with_larger_budget"] = bool(retry.get("schema_valid"))
        res[label] = row
    return res


def check_latency_profile(base, key, model, ua, samples=5):
    """ADR-0027 is stated as a **P95**, so a single generation cannot adjudicate it.

    Earlier StepFun runs measured 7.698 s and 9.695 s full generation; a later run
    measured 2.521 s for the same payload. Reporting whichever one happens to land
    in the definitive run would either falsely clear or falsely condemn the
    provider. So sample the streaming path N times and report the spread plus how
    many samples breach the budget — a small n, stated as such, beats one sample
    dressed up as a P95."""
    rows = []
    for _ in range(samples):
        s = _stream(base, key, _base_payload(model), ua=ua)
        rows.append({"http": s.get("http"), "total_seconds": s.get("total_seconds"),
                     "ttft_seconds": s.get("ttft_seconds"),
                     "ttft_any_seconds": s.get("ttft_any_seconds"),
                     "reasoning_chars": s.get("reasoning_chars"),
                     "text_chars": s.get("text_chars"),
                     "completion_tokens": (s.get("usage_in_stream") or {}).get("completion_tokens"),
                     "error": s.get("error")})
    ok = [r for r in rows if r["http"] == 200 and r["total_seconds"] is not None]
    tot = sorted(r["total_seconds"] for r in ok)
    vis = sorted(r["ttft_seconds"] for r in ok if r["ttft_seconds"] is not None)

    def _stat(xs):
        if not xs:
            return None
        return {"n": len(xs), "min": xs[0], "median": xs[len(xs) // 2], "max": xs[-1]}

    return {
        "samples": rows, "sample_count": len(rows), "ok_count": len(ok),
        "full_generation_seconds": _stat(tot),
        "visible_ttft_seconds": _stat(vis),
        "over_high_risk_budget_3_5s": sum(1 for x in tot if x > 3.5),
        "over_regular_budget_2_0s": sum(1 for x in tot if x > 2.0),
        "note": "同一 payload 的流式完整生成，n={0}；ADR-0027 以 P95 表述，n 太小只能给"
                "区间与越界次数，不能自称 P95。".format(len(rows)),
    }


def check_errors(base, key, model, ua):
    """Normalize bad key, unknown model, and client timeout."""
    s_auth, b_auth, _, _ = _req(base, "sk-INVALID-probe-key",
                                _base_payload(model, max_out=16), ua=ua)
    s_mdl, b_mdl, _, _ = _req(base, key,
                              {"model": "definitely-not-a-real-model-probe-005",
                               "messages": _messages(), "max_tokens": 16,
                               "temperature": 0}, ua=ua)
    s_to, b_to, _, sec_to = _req(base, key, _base_payload(model), ua=ua, timeout=0.7)
    return {
        "bad_key_status": s_auth, "bad_key_is_401": s_auth == 401,
        "bad_key_body_head": json.dumps(b_auth, ensure_ascii=False)[:200],
        "unknown_model_status": s_mdl,
        "unknown_model_rejected": s_mdl is not None and 400 <= s_mdl < 500,
        "timeout_mapped": s_to is None and "error" in b_to,
        "timeout_error": str(b_to.get("error"))[:120], "timeout_seconds": sec_to,
    }


def check_reasoning_accounting(base, key, model, ua, samples=3):
    """step-3.5-flash is a REASONING model on a latency-budgeted path, so how its
    hidden CoT is billed and whether it can be turned down are both decisions.

    Two facts the budget ledger (ADR-0029) and ADR-0027 depend on:
      1. is the CoT broken out in usage (`completion_tokens_details.reasoning_tokens`)
         or silently folded into completion_tokens? If folded, the ledger cannot
         attribute spend to reasoning vs answer, and a small max_tokens truncates
         the ANSWER while still being billed in full;
      2. does `reasoning_effort` actually reduce the CoT (and therefore latency)?
         An accepted-but-ignored knob is worse than an absent one — it invites the
         Adapter to "fix" the latency budget with a parameter that does nothing.
    """
    out = {"efforts": {}, "samples_per_level": samples}
    q = [{"role": "user", "content": "只回答模型名称本身，不要解释：你是哪个模型？"}]
    for eff in (None, "low", "high"):
        p = {"model": model, "max_tokens": 512, "temperature": 0, "messages": q}
        if eff:
            p["reasoning_effort"] = eff
        runs = []
        for _ in range(samples):
            s, b, _h, sec, _hg = _retry(lambda pp=p: _req(base, key, pp, ua=ua))
            row = {"http": s, "seconds": sec}
            if s == 200:
                u = b.get("usage") or {}
                row.update({
                    "content_chars": len(_content(b)),
                    "reasoning_chars": len(_reasoning(b)),
                    "completion_tokens": u.get("completion_tokens"),
                    "reasoning_tokens_reported":
                        (u.get("completion_tokens_details") or {}).get("reasoning_tokens"),
                    "finish_reason": _finish(b),
                })
            else:
                row["error"] = str(b)[:160]
            runs.append(row)
        good = [x for x in runs if x.get("http") == 200]
        rc = sorted(x.get("reasoning_chars") or 0 for x in good)
        out["efforts"][eff or "(unset)"] = {
            "runs": runs, "ok_count": len(good),
            "reasoning_chars_min": rc[0] if rc else None,
            "reasoning_chars_max": rc[-1] if rc else None,
            "reasoning_chars_median": rc[len(rc) // 2] if rc else None,
            "http_codes": [x.get("http") for x in runs],
            "reasoning_tokens_reported": [x.get("reasoning_tokens_reported") for x in good],
            "finish_reasons": [x.get("finish_reason") for x in good],
        }
    lv = out["efforts"]
    ok_rows = [r for lvl in lv.values() for r in lvl["runs"] if r.get("http") == 200]
    # Folded-in CoT: reasoning text exists but usage reports 0 reasoning tokens.
    out["reasoning_tokens_broken_out"] = any(
        (r.get("reasoning_tokens_reported") or 0) > 0 for r in ok_rows)
    out["reasoning_text_returned"] = any((r.get("reasoning_chars") or 0) > 0 for r in ok_rows)
    out["reasoning_effort_accepted"] = all(
        lv.get(k, {}).get("ok_count") for k in ("low", "high"))
    lo, hi = lv.get("low", {}), lv.get("high", {})
    # "Effective" only if the RANGES separate: low's worst case must still be well
    # below high's best case. Per-call CoT length swings by >4x at a fixed effort
    # (measured), so comparing two single samples manufactures a verdict either way.
    out["reasoning_effort_effective"] = bool(
        lo.get("reasoning_chars_max") is not None
        and hi.get("reasoning_chars_min") is not None
        and hi["reasoning_chars_min"] > lo["reasoning_chars_max"] * 1.5)
    out["reasoning_char_range"] = {
        k: [v.get("reasoning_chars_min"), v.get("reasoning_chars_max")] for k, v in lv.items()}
    out["note"] = ("每档 {0} 次采样；判定「生效」要求 low 的上界与 high 的下界分离（>1.5x），"
                   "单样本对比会凭噪声造出结论。".format(samples))
    return out


def check_provenance(base, key, model, ua):
    """Trust check: who actually serves this model id?

    For the relay legs this exposed an injected agent system-prompt and a
    mismatched self-identity. StepFun is first-party, so a consistent identity is
    the expectation — but a trustworthy RAG verifies rather than assumes.

    max_tokens must be generous here: at 64 the CoT consumed the whole budget and
    the answer came back EMPTY (finish_reason=length), which an earlier run
    mis-reported as "模型身份不可核验". Chat Completions returns no `instructions`
    echo, so an injected system prompt is not directly observable in the body; the
    Adapter therefore ALWAYS sends its own system message regardless (ADR-0032)."""
    payload = {"model": model, "temperature": 0, "max_tokens": 512,
               "messages": [{"role": "user",
                             "content": "只回答模型名称本身，不要解释：你是哪个模型？"}]}
    s, b, _, sec, timeouts = _retry(lambda: _req(base, key, payload, ua=ua))
    row = {"http": s, "seconds": sec, "transient_timeouts": timeouts}
    if s != 200 or not isinstance(b, dict):
        row["error"] = str(b)[:200]
        return row
    row.update({
        "requested_model": model,
        "model_echo": b.get("model"),
        "self_reported_identity": _content(b).strip()[:120],
        "finish_reason": _finish(b),
        "reasoning_chars": len(_reasoning(b)),
        "max_tokens_requested": payload["max_tokens"],
    })
    ident = row["self_reported_identity"].lower().replace(" ", "")
    needle = (model.split("/")[-1] or model).lower().replace(" ", "")
    # Accept the family name too: `step-3.5-flash` answering "Step" is a
    # first-party-consistent identity, not an anonymous relabelled upstream.
    row["identity_consistent"] = bool(ident) and (
        needle in ident or "step" in ident or "阶跃" in row["self_reported_identity"])
    # Empty content is a truncation artifact, not an identity finding — keep them apart.
    row["identity_unobtainable_truncated"] = (not ident) and _finish(b) == "length"
    return row


def preflight_auth(base, key, model, ua):
    """One tiny call to separate "bad credential" from "provider verdict".

    A stale key aimed at a new base returns 401 on every check, which would
    otherwise be written out as a BLOCKED provider report — a false record of a
    provider we never actually reached — after ~10 pointless billed attempts.
    Returns (ok, status, body)."""
    payload = {"model": model, "max_tokens": 16, "temperature": 0,
               "messages": [{"role": "system", "content": "reply with: ok"},
                            {"role": "user", "content": "ok"}]}
    s, b, _h, _sec = _req(base, key, payload, ua=ua, timeout=60)
    return (s not in (401, 403)), s, b


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
    "provider_governance": "StepFun（阶跃星辰）是第一方模型厂商而非中转站，但仍是数据路径上"
        "的外部处理方，可能记录/留存 prompt。探针仅合成文本可接受；生产承载真实客服数据前"
        "必须评估留存与合规，否则冲突 ADR-0017/0025「敏感数据不出域」。",
}


def run(base, key, model, provider, ua, price_in, price_out, price_source=None):
    r = {"stage": "B-chat", "api": "chat.completions", "provider": provider,
         "model": model, "base": base, "user_agent": ua or "(default)", "checks": {}}
    r["checks"]["contract"] = check_contract(base, key, model, ua)
    r["checks"]["stream"] = check_stream(base, key, model, ua)
    r["checks"]["structured_output"] = check_structured_output(base, key, model, ua)
    r["checks"]["latency_profile"] = check_latency_profile(base, key, model, ua)
    r["checks"]["error_mapping"] = check_errors(base, key, model, ua)
    r["checks"]["reasoning_accounting"] = check_reasoning_accounting(base, key, model, ua)
    r["checks"]["provenance"] = check_provenance(base, key, model, ua)
    r["availability"] = {
        "non_stream_calls": HANGS["calls"], "hangs_over_90s": HANGS["count"],
        "hang_rate": (round(HANGS["count"] / HANGS["calls"], 3)
                      if HANGS["calls"] else None),
        "rpm_ceiling_paced_to": PACER.rpm,
        "rate_limit_429_absorbed": RATE["absorbed_429"],
        "rate_limit_wait_seconds": round(RATE["wait_seconds"], 1),
        "note": "每个非流式调用最多重试 3 次；hang = 超过 90s 读超时（远超正常响应时间）。"
                "429 按 RPM 上限限速 + 退避重试吸收，**不作为供应商契约结论**（未限速的"
                "运行曾把 provenance 与 high 档采样吃掉）。",
    }
    r["reasoning_effort_pinned"] = EFFORT or "(unset)"
    r["simulated"] = SIMULATED_NOTES

    # 单次问答口径（一次典型 grounded chat）与全探针合计分开报：ADR-0029 的单次<=5元/
    # 每日<=16元校验要的是前者，后者只是本次探针的真实开销。
    one = r["checks"]["contract"].get("usage") or {}
    one_pt = one.get("prompt_tokens") or 0
    one_ct = one.get("completion_tokens") or 0
    pt = ct = 0
    srcs = [r["checks"]["contract"].get("usage") or {},
            r["checks"]["stream"]["full"].get("usage_in_stream") or {},
            r["checks"]["stream"]["cancelled"].get("usage_in_stream") or {}]
    for s in (r["checks"].get("latency_profile") or {}).get("samples") or []:
        srcs.append({"prompt_tokens": one_pt if s.get("http") == 200 else 0,
                     "completion_tokens": s.get("completion_tokens") or 0})
    for lvl in ((r["checks"].get("reasoning_accounting") or {}).get("efforts") or {}).values():
        for row in lvl.get("runs") or []:
            srcs.append({"prompt_tokens": 0,
                         "completion_tokens": row.get("completion_tokens") or 0})
    for src in srcs:
        pt += src.get("prompt_tokens") or 0
        ct += src.get("completion_tokens") or 0

    def _cny(p, c_):
        if not (price_in or price_out):
            return None
        return round(p / 1_000_000 * (price_in or 0) + c_ / 1_000_000 * (price_out or 0), 6)

    r["cost"] = {"one_answer_prompt_tokens": one_pt,
                 "one_answer_completion_tokens": one_ct,
                 "one_answer_estimated_cny": _cny(one_pt, one_ct),
                 "measured_prompt_tokens_partial": pt,
                 "measured_completion_tokens_partial": ct,
                 "price_cny_per_1m_in": price_in, "price_cny_per_1m_out": price_out,
                 "price_source": price_source or "(未提供单价来源)",
                 "estimated_cny_partial": _cny(pt, ct),
                 "note": "仅统计供应商回报了 usage 的调用（结构化输出两次未逐行留存 usage，"
                         "故合计为下界）；单价来自 CHAT_PRICE_CNY_PER_1M_IN/OUT，未设则为 0。"
                         "**单次问答成本口径**需在 one_answer_* 之上叠加 Stage A 的查询/逐句 "
                         "Embedding、Stage C 的 rerank 与高风险蕴含调用。"
                         "注意 CoT 计入 completion_tokens 却不单列，无法拆分思考成本。"}
    return r


def evaluate(r):
    fails, decides = [], []
    av = r.get("availability") or {}
    if av.get("rate_limit_429_absorbed"):
        decides.append(
            f"账号 RPM 上限是真实容量约束：本次吸收 {av['rate_limit_429_absorbed']} 次 429"
            f"（退避等待 {av.get('rate_limit_wait_seconds')}s，限速 RPM="
            f"{av.get('rpm_ceiling_paced_to')}）。实测该账号档位 RPM=10 —— 生产侧需按并发"
            "问答量核算配额，并在 Adapter 内做排队/退避与截断降级；429 属我方运行条件，"
            "不计入供应商契约判定。")
    if not av.get("rpm_ceiling_paced_to"):
        decides.append(
            "本次未限速（--rpm=0）：若报告中出现 429，相关检查结论不可信，须按 RPM 上限复跑。")
    c = r["checks"]["contract"]
    if c.get("http") != 200:
        fails.append(f"基本 Chat 调用失败 HTTP {c.get('http')}：{str(c.get('error'))[:160]}")
    else:
        if (c.get("seconds") or 0) > 10:
            decides.append(f"非流式一次问答耗时 {c.get('seconds')}s（>10s）：交互式客服问答"
                           "必须走流式，非流式仅可用于离线/批处理路径。")
        if not c.get("usage_present"):
            fails.append("非流式响应未回传 usage，预算账本无法按真实 token 结算（ADR-0029）")
        if not c.get("model_echo_matches"):
            decides.append(f"响应 model 回显为 `{c.get('model_echo')}`，与请求名不一致："
                           "审计需以请求名+响应名成对记录。")
        if not c.get("response_id") and not c.get("request_id_header"):
            decides.append("既无响应 id 也无 request-id 头：需在 Adapter 侧自生成关联 id。")
        if not c.get("cites_snippet_ids"):
            decides.append("回答未引用资料编号（D1/D2/D3）：引用链路需靠 Adapter 强制结构化输出。")
    st = r["checks"]["stream"]
    if st["full"].get("http") != 200 or st["full"].get("deltas", 0) == 0:
        fails.append("流式路径不可用（无增量输出），与流式取消/TTFT 目标冲突")
    if not st.get("cancel_worked"):
        fails.append("流式无法中途取消：ADR-0029 的取消按已产生 token 结算不成立")
    if not st.get("usage_on_stream"):
        decides.append("流式路径未回传 usage（include_usage 被忽略）：取消结算只能按已收"
                       "字符估算 token，需在 Adapter 侧本地计量并接受误差。")
    ttft = st["full"].get("ttft_seconds")
    ttft_any = st["full"].get("ttft_any_seconds")
    lp = r["checks"].get("latency_profile") or {}
    fg = lp.get("full_generation_seconds") or {}
    vt = lp.get("visible_ttft_seconds") or {}
    over_hi = lp.get("over_high_risk_budget_3_5s")
    over_reg = lp.get("over_regular_budget_2_0s")
    # ADR-0027（2026-08-26 按 PROBE-005 修订）：常规 P95<=2.0s、高风险含蕴含调用 P95<=3.5s，
    # 且蕴含调用必须与逐句 Embedding 批量调用并发发起（串行下界约 1.4s+3.0s≈4.3s，必然超预算）。
    # 判定按 n 次采样的区间与越界次数，不按单次流式（实测同 payload 在 2.5s 与 9.7s 之间抖动）。
    if fg.get("n"):
        spread = (f"完整生成 n={fg['n']}：{fg['min']}–{fg['max']}s（中位 {fg['median']}s）；"
                  f"可读答案首字 {vt.get('min')}–{vt.get('max')}s")
        if over_hi:
            decides.append(
                f"**时延抖动跨越 ADR-0027 高风险预算**：{spread}，其中 {over_hi}/{fg['n']} 次 "
                f">3.5s（另有 {over_reg}/{fg['n']} 次 >2.0s 常规预算）。**这是本 stage 唯一的真实"
                "供应商级取舍**：`reasoning_effort` 实测不足以稳定压低 CoT（见 reasoning_accounting），"
                "故只剩三条路——高风险腿改配非推理模型、再次上调 ADR-0027 预算、或高风险验证转异步"
                "（先出答案、后补验证标记）。**不可只取一次快样本当结论**：早前两次运行的完整生成"
                "为 7.698s / 9.695s。")
        elif over_reg:
            decides.append(
                f"高风险 3.5s 预算本轮全部满足，但常规 2.0s 预算有 {over_reg}/{fg['n']} 次越界"
                f"（{spread}）：常规问答腿需按上界而非中位数设超时，且逐句 Embedding 与蕴含调用"
                "必须并发发起（ADR-0027 硬约束）。历史运行曾达 7.7-9.7s，抖动须计入选型。")
        else:
            decides.append(
                f"本轮时延全部落在 ADR-0027 预算内（{spread}），但**历史同 payload 曾测到 7.698s / "
                "9.695s**：该端点时延方差大，Adapter 必须按上界设超时并保留降级路径，不能按中位数"
                "承诺 SLA；正式定档前建议在不同时段各跑一轮。")
    if ttft is not None and ttft_any is not None and ttft - ttft_any > 1.0:
        decides.append(
            f"**推理内容先流完才出正文**：首个任意事件 {ttft_any}s、可读答案首字 {ttft}s（差 "
            f"{round(ttft - ttft_any, 2)}s，其间只有 {st['full'].get('reasoning_deltas')} 个 "
            "reasoning_content 增量）。UI 只能先显示「思考中」进度，不能把 reasoning_content 当"
            "答案渲染（未经引用校验的内容不得呈现，ADR-0027/0032）。")
    so = r["checks"]["structured_output"]
    js, jo = so.get("json_schema", {}), so.get("json_object", {})

    def _mode_ok(row):
        """Supported = validated at the first budget OR at the escalated budget.
        The escalated case is a token-budget constraint, reported separately."""
        return row.get("http") == 200 and (row.get("schema_valid")
                                           or row.get("supported_with_larger_budget"))

    schema_ok, object_ok = _mode_ok(js), _mode_ok(jo)
    both_hung = js.get("timed_out") and jo.get("timed_out")
    # 截断不是能力缺失：HTTP 200 + finish_reason=length + 空正文，说明 max_tokens 被 CoT
    # 吃光，属 Adapter 的 token 预算约束，不能记成「供应商不支持该方言」（曾误判一次）。
    js_trunc = bool(js.get("truncated")) and not js.get("schema_valid")
    jo_trunc = bool(jo.get("truncated")) and not jo.get("schema_valid")
    if both_hung:
        fails.append("结构化输出两种模式均因端点挂起（重试后仍 >90s 读超时）未能取得结果："
                     "这是**可用性**失败而非协议不兼容。该端点不满足企业 SLA。")
    elif not schema_ok and not object_ok:
        fails.append("json_schema 与 json_object 均无法产出可校验结构化输出（且非截断所致）："
                     "结构化输出失败必须返回受控错误，不能把未校验响应交给 Answer/Citation")
    elif not schema_ok:
        note = "（strict json_schema 请求超时/被拒）" if js.get("timed_out") or js.get("http") != 200 else ""
        decides.append(f"strict json_schema 不可靠{note}，仅 json_object 可用：Adapter 必须"
                       "自带 schema 校验 + 失败重试/受控错误。")
    elif not object_ok:
        decides.append(
            f"`response_format` 的 `json_object` 模式在此供应商不可用"
            f"（各次尝试 HTTP {jo.get('attempt_http_codes') or [jo.get('http')]}，"
            f"finish_reason={jo.get('finish_reason')}），而 strict `json_schema` 正常："
            "**Adapter 必须按供应商登记结构化输出方言能力**，此供应商只走 json_schema，"
            "且不得把 json_object 当降级回退。")
    if js_trunc or jo_trunc:
        rows = [(n, row) for n, row, t in (("json_schema", js, js_trunc),
                                           ("json_object", jo, jo_trunc)) if t]
        detail = "；".join(
            "{0}：max_tokens={1} 时 HTTP 200 + finish_reason=length + 正文 {2} 字 + CoT {3} 字，"
            "加大到 {4} 后 schema 通过={5}".format(
                n, row.get("max_tokens_requested"), row.get("content_chars"),
                row.get("reasoning_chars"),
                (row.get("budget_escalation_retry") or {}).get("max_tokens_requested"),
                (row.get("budget_escalation_retry") or {}).get("schema_valid"))
            for n, row in rows)
        decides.append(
            f"结构化输出曾被**截断**而非不受支持（{detail}）：这是 **Adapter 的 token 预算约束** —— "
            "推理模型的 CoT 与正文共用同一 `max_tokens`，结构化输出必须按「CoT 上限 + JSON 上限」"
            "两段预留，并把 finish_reason=length 当受控错误上抛，禁止把截断的 JSON 交给 "
            "Answer/Citation。**不得据此判定供应商不支持该方言。**")
    em = r["checks"]["error_mapping"]
    if not em.get("bad_key_is_401"):
        decides.append(f"错误密钥返回 {em.get('bad_key_status')}（非 401）：错误映射表按实测归一。")
    if not em.get("unknown_model_rejected"):
        decides.append("未知模型未被 4xx 拒绝：Adapter 需自校验模型白名单。")
    if not em.get("timeout_mapped"):
        decides.append("客户端超时未能被映射为可归一错误，需复核超时/重试策略。")
    ra = r["checks"].get("reasoning_accounting") or {}
    if ra.get("reasoning_text_returned") and not ra.get("reasoning_tokens_broken_out"):
        decides.append(
            "**推理用量不可分摊**：`message.reasoning_content` 实测数百字，但 "
            "`usage.completion_tokens_details.reasoning_tokens` 恒为 0 —— CoT 计费折进 "
            "`completion_tokens` 却不单列。ADR-0029 账本因此无法把成本拆成「思考 vs 答案」，"
            "只能按 completion_tokens 总量结算；且 Adapter 必须把 CoT 计入 max_tokens 预留，"
            f"否则正文被静默截断（实测 CoT 字数 {ra.get('reasoning_char_range')}）。")
    if ra.get("reasoning_effort_accepted") and not ra.get("reasoning_effort_effective"):
        decides.append(
            "`reasoning_effort` **不足以作为时延旋钮**：low/high 均返回 200，但同档 CoT 字数自身"
            f"抖动就与档间差异同量级（各档 min-max：{ra.get('reasoning_char_range')}，"
            f"每档 {ra.get('samples_per_level')} 次采样），区间无法分离 → 不能用它压低 ADR-0027 "
            "时延。Adapter 不应暴露这个旋钮，以免给出「可调时延」的假承诺。")
    elif ra.get("reasoning_effort_effective"):
        decides.append(
            f"`reasoning_effort` **在本检查的短问题上实测有效**（各档 CoT 字数 min-max："
            f"{ra.get('reasoning_char_range')}，每档 {ra.get('samples_per_level')} 次采样，"
            "low 上界与 high 下界分离）。**但作用域必须写清**：本检查用的是「只回答模型名称」"
            "这类琐碎问题，CoT 地板极低，旋钮才有余量；在 grounded 引用问答负载上"
            "（A/B 探针，每档 40 样本、max_tokens=1200）两档 CoT 分布完全重叠、completion "
            "tokens 仅差 3.2%、p95 也不更快，即**旋钮拧不动**。→ `reasoning_effort` 不是 RAG "
            "答案腿的时延手段；是否对蕴含判断等短任务有用，与「低 effort 是否降低判断质量」"
            "一并在 PROBE-006 评测，**未评测前不得为了达标 ADR-0027 而默认调低**。")
    pv = r["checks"].get("provenance") or {}
    if pv.get("http") == 200 and pv.get("identity_unobtainable_truncated"):
        decides.append(
            f"模型身份问询被截断（max_tokens={pv.get('max_tokens_requested')}、"
            f"finish_reason=length、CoT {pv.get('reasoning_chars')} 字、正文 0 字）："
            "属探针预算不足而**非身份不可核验**，需加大 max_tokens 复测后再判定。")
    elif pv.get("http") == 200 and not pv.get("identity_consistent"):
        decides.append(
            f"模型身份存疑：请求 `{pv.get('requested_model')}`、回显 `{pv.get('model_echo')}`，"
            f"但模型自称“{pv.get('self_reported_identity')}”。第一方厂商应可核验，"
            "如不一致需供应商出具模型映射说明后再进生产。")
    av = r.get("availability") or {}
    if av.get("hangs_over_90s"):
        normal = ((r.get("checks") or {}).get("contract") or {}).get("seconds")
        normal_txt = f"，同类请求实测 {normal}s" if normal else ""
        decides.append(
            f"**间歇性挂起**：{av['non_stream_calls']} 次非流式调用中 {av['hangs_over_90s']} 次"
            f"超过 90s 读超时（挂起率 {av['hang_rate']}{normal_txt}），靠重试才恢复。"
            "Adapter 必须设短超时 + 重试 + 熔断，且此不稳定性需计入供应商选型。")
    status = "BLOCKED" if fails else ("PASS_WITH_ADJUSTMENT" if decides else "PASS")
    return fails, decides, status


def write_reports(r, out_dir, slug="probe-005-model-adapter-chat"):
    fails, decides, status = evaluate(r)
    doc = {"probe_id": "PROBE-005", "stage": "B-chat", "api": "chat.completions",
           "status": status,
           "executed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "provider": r["provider"], "model": r["model"], "base": r["base"],
           "user_agent": r["user_agent"], "measurements": r,
           "failures": fails, "decisions_required": decides, "recommendation": status}
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, slug + ".json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    _write_md(doc, os.path.join(out_dir, slug + ".md"))
    return doc


def _write_md(doc, path):
    m, c = doc["measurements"], doc["measurements"]["checks"]
    st, so, em = c["stream"], c["structured_output"], c["error_mapping"]
    ct = c["contract"]
    L = ["# PROBE-005 ModelAdapter 探针结果（Stage B · Chat · Chat Completions API）", "",
         f"- 状态：**{doc['status']}**",
         f"- 执行时间：{doc['executed_at']}",
         f"- Provider：{doc['provider']}（`{doc['base']}` · OpenAI **Chat Completions** `/chat/completions`）",
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
          f"- finish_reason：`{ct.get('finish_reason')}`；"
          f"请求 max_tokens={ct.get('max_tokens_requested')}，被截断：{ct.get('truncated')}",
          f"- **隐藏推理正文**：`reasoning_content` 字段存在={ct.get('reasoning_field_present')}，"
          f"{ct.get('reasoning_chars')} 字符（与可见正文共用同一 max_tokens 预算）",
          f"- usage 回传：**{ct.get('usage_present')}** → {ct.get('usage')}",
          f"- 回答含资料编号引用：{ct.get('cites_snippet_ids')}", "",
          "## 流式 / TTFT / 取消（LIVE）", "",
          "两个 TTFT 必须分开看：`首事件` 是任意增量（含 reasoning_content）到达时刻——进度条"
          "能动的时刻；`可读答案` 是第一个可见正文 token——用户真正有字可读的时刻。推理模型下"
          "两者可能差好几秒。", "",
          "| 场景 | HTTP | 首事件TTFT(s) | 可读答案TTFT(s) | 总耗时(s) | 正文增量/字符 | "
          "推理增量/字符 | finish_reason | 流内 usage |",
          "|---|---|---|---|---|---|---|---|---|"]
    for label, row in (("完整生成", st["full"]), ("中途取消(5 增量)", st["cancelled"])):
        L.append(f"| {label} | {row.get('http')} | {row.get('ttft_any_seconds')} | "
                 f"{row.get('ttft_seconds')} | {row.get('total_seconds')} | "
                 f"{row.get('deltas')}/{row.get('text_chars')} | "
                 f"{row.get('reasoning_deltas')}/{row.get('reasoning_chars')} | "
                 f"{row.get('finish_reason')} | "
                 f"{'有' if row.get('usage_in_stream') else '无'} |")
    L += ["", f"- 取消生效：**{st.get('cancel_worked')}**；流式回传 usage："
          f"**{st.get('usage_on_stream')}**", ""]
    L += ["## 结构化输出（LIVE · response_format）", "",
          "**截断不等于不支持**：HTTP 200 + `finish_reason=length` + 正文 0 字，是 max_tokens "
          "被 CoT 吃光，属 Adapter 的 token 预算问题；曾据此误判「该供应商不支持 json_object」，"
          "与 Stage C 被 429 污染同属一类假结论。故 finish_reason 单列并单独判定。", "",
          "| 模式 | HTTP | 各次尝试 | 解析为 JSON | 满足 schema | finish_reason | 截断 | "
          "正文/推理字符 | max_tokens | 备注 |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    for label in ("json_schema", "json_object"):
        row = so.get(label, {})
        note = row.get("head") or row.get("error") or ""
        if row.get("timed_out"):
            note = "请求超时（strict schema 在该端点疑似挂起）"
        L.append(f"| `{label}` | {row.get('http')} | {row.get('attempt_http_codes') or '-'} | "
                 f"{row.get('parses_as_json', '-')} | {row.get('schema_valid', '-')} | "
                 f"{row.get('finish_reason', '-')} | {row.get('truncated', '-')} | "
                 f"{row.get('content_chars', '-')}/{row.get('reasoning_chars', '-')} | "
                 f"{row.get('max_tokens_requested', '-')} | {str(note)[:80]} |")
        rt = row.get("budget_escalation_retry")
        if rt:
            L.append(f"| `{label}`（加大预算复测） | {rt.get('http')} | - | "
                     f"{rt.get('parses_as_json', '-')} | {rt.get('schema_valid', '-')} | "
                     f"{rt.get('finish_reason', '-')} | {rt.get('truncated', '-')} | "
                     f"{rt.get('content_chars', '-')}/{rt.get('reasoning_chars', '-')} | "
                     f"{rt.get('max_tokens_requested', '-')} | "
                     f"加大后支持={row.get('supported_with_larger_budget')} |")
    ra = c.get("reasoning_accounting") or {}
    L += ["", "## 推理用量与 `reasoning_effort`（LIVE · 推理模型专项）", "",
          "step-3.5-flash 是推理模型，隐藏 CoT 既占 `max_tokens` 又计费，直接决定 ADR-0029 的"
          "结算口径与 ADR-0027 的时延手段。", "",
          f"- 采样方法：{ra.get('note')}", "",
          "| reasoning_effort | HTTP | 推理字符 min/中位/max | completion_tokens | "
          "usage 里的 reasoning_tokens | finish_reason |",
          "|---|---|---|---|---|---|"]
    for k, v in (ra.get("efforts") or {}).items():
        toks = [x.get("completion_tokens") for x in v.get("runs", []) if x.get("http") == 200]
        L.append(f"| `{k}` | {v.get('http_codes')} | {v.get('reasoning_chars_min')}/"
                 f"{v.get('reasoning_chars_median')}/{v.get('reasoning_chars_max')} | "
                 f"{toks} | {v.get('reasoning_tokens_reported')} | {v.get('finish_reasons')} |")
    L += ["",
          f"- 返回推理正文：**{ra.get('reasoning_text_returned')}**；"
          f"usage 中单列 reasoning_tokens：**{ra.get('reasoning_tokens_broken_out')}**",
          f"- `reasoning_effort` 被接受：{ra.get('reasoning_effort_accepted')}；"
          f"**区间可分离（判定为有效）：{ra.get('reasoning_effort_effective')}**"
          f"（各档 CoT 字数 min-max {ra.get('reasoning_char_range')}）", ""]
    lp = c.get("latency_profile") or {}
    fg = lp.get("full_generation_seconds") or {}
    vt = lp.get("visible_ttft_seconds") or {}
    L += ["## 时延分布（LIVE · 多次采样，ADR-0027 判定依据）", "",
          "ADR-0027 以 P95 表述，单次流式生成无法裁决——同一 payload 在历史运行中测到 7.698s / "
          "9.695s，本轮又能落到 2.5s。故按 n 次采样报区间与越界次数，并明确 n 很小。", "",
          f"- 样本 {lp.get('ok_count')}/{lp.get('sample_count')} 成功；"
          f"完整生成 **{fg.get('min')}–{fg.get('max')}s**（中位 {fg.get('median')}s）；"
          f"可读答案首字 {vt.get('min')}–{vt.get('max')}s（中位 {vt.get('median')}s）",
          f"- 越界次数：>3.5s（高风险预算）**{lp.get('over_high_risk_budget_3_5s')}** 次；"
          f">2.0s（常规预算）**{lp.get('over_regular_budget_2_0s')}** 次",
          f"- 口径：{lp.get('note')}", "",
          "| # | HTTP | 完整生成(s) | 首事件(s) | 可读答案(s) | 正文字符 | 推理字符 | completion_tokens |",
          "|---|---|---|---|---|---|---|---|"]
    for i, row in enumerate(lp.get("samples") or [], 1):
        L.append(f"| {i} | {row.get('http')} | {row.get('total_seconds')} | "
                 f"{row.get('ttft_any_seconds')} | {row.get('ttft_seconds')} | "
                 f"{row.get('text_chars')} | {row.get('reasoning_chars')} | "
                 f"{row.get('completion_tokens')} |")
    L += ["", "## 错误映射（LIVE）", "",
          f"- 错误密钥 → HTTP {em.get('bad_key_status')}（401：{em.get('bad_key_is_401')}）",
          f"- 未知模型 → HTTP {em.get('unknown_model_status')}（4xx 拒绝：{em.get('unknown_model_rejected')}）",
          f"- 客户端超时（0.7s）→ 可归一：{em.get('timeout_mapped')}（{em.get('timeout_error')}）",
          "", "## 成本（LIVE 用量）", "",
          f"- **单次问答**（一次 grounded chat，含隐藏 CoT）：prompt "
          f"{m['cost'].get('one_answer_prompt_tokens')} + completion "
          f"{m['cost'].get('one_answer_completion_tokens')} tokens → "
          f"{m['cost'].get('one_answer_estimated_cny')} 元",
          f"- 本次探针合计（下界）：prompt tokens {m['cost']['measured_prompt_tokens_partial']}；"
          f"completion tokens {m['cost']['measured_completion_tokens_partial']}",
          f"- 单价（元/百万 in/out）：{m['cost']['price_cny_per_1m_in']} / "
          f"{m['cost']['price_cny_per_1m_out']}；估算：{m['cost']['estimated_cny_partial']} 元",
          f"- 单价来源：{m['cost'].get('price_source')}",
          f"- 口径说明：{m['cost']['note']}", ""]
    pv = c.get("provenance") or {}
    av = m.get("availability") or {}
    L += ["## 可用性与限流（LIVE）", "",
          f"- 非流式调用 {av.get('non_stream_calls')} 次，其中 **{av.get('hangs_over_90s')} 次"
          f">90s 读超时**（挂起率 {av.get('hang_rate')}），每次最多重试 3 次",
          f"- 限速：按 RPM={av.get('rpm_ceiling_paced_to')} 发起；吸收 429 "
          f"**{av.get('rate_limit_429_absorbed')}** 次（退避等待 "
          f"{av.get('rate_limit_wait_seconds')}s）",
          f"- `reasoning_effort` 本次固定为：**{m.get('reasoning_effort_pinned')}**",
          f"- 口径：{av.get('note')}", ""]
    L += ["## 模型来源（LIVE · 可信性）", ""]
    if pv.get("http") == 200:
        L += [f"- 请求模型：`{pv.get('requested_model')}`；响应回显：`{pv.get('model_echo')}`；"
              f"模型自称：**{pv.get('self_reported_identity') or '(空)'}**"
              f"（一致：{pv.get('identity_consistent')}）",
              f"- 问询用 max_tokens={pv.get('max_tokens_requested')}，"
              f"finish_reason=`{pv.get('finish_reason')}`，CoT {pv.get('reasoning_chars')} 字符；"
              f"因截断而取不到身份：{pv.get('identity_unobtainable_truncated')}",
              "- 注：身份问询必须给足 max_tokens。曾用 64 令 CoT 吃光预算、正文为空，被误记成"
              "「模型身份不可核验」——空正文是探针预算不足，不是供应商事实。",
              "- Chat Completions 无 `instructions` 回显，端点若注入 system prompt 不可从响应体"
              "直接观测；Adapter 始终显式传入自己的 system 消息（ADR-0032 注入面）。", ""]
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
    ap.add_argument("--provider", default=os.environ.get("CHAT_PROVIDER") or "stepfun")
    ap.add_argument("--user-agent", default=DEFAULT_UA)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report-slug", default=None,
                    help="report basename; default derives from --provider so one "
                         "provider's record never overwrites another's")
    ap.add_argument("--price-in-per-1m", type=float,
                    default=_fenv("CHAT_PRICE_CNY_PER_1M_IN"))
    ap.add_argument("--price-out-per-1m", type=float,
                    default=_fenv("CHAT_PRICE_CNY_PER_1M_OUT"))
    ap.add_argument("--reasoning-effort", default=os.environ.get("CHAT_REASONING_EFFORT"),
                    help="pin reasoning_effort on every payload (low/medium/high); "
                         "empty = omit the field. The definitive contract run should be "
                         "pinned to whatever the product will actually send.")
    ap.add_argument("--rpm", type=int, default=int(os.environ.get("CHAT_RPM") or 0),
                    help="account RPM ceiling to pace under (0 = no pacing). StepFun's "
                         "tier here is 10; unpaced runs lose calls to 429 and 429s must "
                         "never be recorded as contract findings.")
    ap.add_argument("--price-source", default=os.environ.get("CHAT_PRICE_SOURCE"),
                    help="where the unit prices came from; recorded in the report so a "
                         "cost figure is never left unattributable")
    args = ap.parse_args()
    global PACER, EFFORT
    PACER = Pacer(args.rpm)
    EFFORT = (args.reasoning_effort or "").strip() or None
    if not args.model:
        print("ERROR: 未指定 chat model id（--model 或环境变量 CHAT_MODEL）。\n"
              f"  当前 base={args.base}，其可用模型 id 需由供应商 /v1/models 确认后再跑。\n"
              "未做任何网络调用，未产生费用。")
        return 3
    key = (os.environ.get("CHAT_API_KEY") or os.environ.get("STEPFUN_API_KEY")
           or os.environ.get("OPENROUTER_API_KEY"))
    if not key:
        print("ERROR: 未找到 CHAT_API_KEY（或 STEPFUN_API_KEY / OPENROUTER_API_KEY）。\n"
              "  请在会话外的终端写入未跟踪的 env 文件，或 export 后再运行。\n"
              "未做任何网络调用，未产生费用。")
        return 3
    slug = args.report_slug or (
        "probe-005-model-adapter-chat-"
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
            args.price_in_per_1m, args.price_out_per_1m, args.price_source)
    doc = write_reports(r, args.out, slug)
    print(f"PROBE-005 Stage B (chat · Chat Completions API) status: {doc['status']}")
    print(f"  报告：{os.path.join(args.out, slug)}.md/.json")
    for x in doc["failures"]:
        print(f"  FAIL: {x}")
    for x in doc["decisions_required"]:
        print(f"  DECIDE: {x}")
    return 0 if doc["status"] != "BLOCKED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
