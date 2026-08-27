#!/usr/bin/env python3
"""PROBE-005 Stage B addendum — `reasoning_effort` A/B on StepFun Chat Completions.

WHY A SEPARATE SCRIPT. probe_005_chat.py answers "does the contract hold"; a
latency budget is a DISTRIBUTION question and needs a different instrument. The
same payload against step-3.5-flash measured 9.695 s in one session and 1.495 s in
another, so no single-digit sample count can adjudicate ADR-0027's P95 ≤ 3.5 s and
no vendor changelog can either.

METHOD (the parts that matter):
  * ARMS ARE INTERLEAVED, not run in blocks. Provider load drifts by minutes; 20
    low-effort calls followed by 20 high-effort calls would attribute that drift to
    the parameter. Alternating makes both arms share the same weather.
  * FOUR CLOCKS per call, because they answer different questions: first stream
    event of any kind (when a progress indicator can move), first VISIBLE answer
    token (when the user can read something), full generation (the ADR-0027
    budget), and completion_tokens (the ADR-0029 cost).
  * QUALITY IS MEASURED ALONGSIDE LATENCY. Turning reasoning down to hit a latency
    target is only a win if the answer is still right and still cited, so every
    sample is graded on the two facts in the fixture and on whether it cites the
    two snippets that carry them. A faster arm that answers worse is not a win.
  * P95 AT n=20 IS THE 19TH OF 20 (nearest-rank). That is a weak estimator and the
    report says so; it is reported next to max, not in place of it.

Secrets: key ONLY from env (CHAT_API_KEY / STEPFUN_API_KEY). Synthetic text only.
REAL COST: 2 * --runs billed streaming calls (~¥0.03 at 20+20 for step-3.5-flash).
"""
import argparse
import json
import math
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

SYSTEM_PROMPT = ("你是企业客服助手。只依据【资料】回答，不得编造；"
                 "若资料不足请明确说明，并在每条结论后用 [D1]/[D2]/[D3] 标注来源。")
CONTEXT_SNIPPETS = [
    "[D1] 退款政策：订单签收后 7 天内可申请无理由退款。",
    "[D2] 运费说明：满 99 元包邮，偏远地区加收 10 元；退货运费由商家承担（非人为损坏）。",
    "[D3] 售后换货：非人为损坏 15 天内可换货。",
]
QUESTION = "订单签收后还能退款吗？退货运费谁承担？请引用资料编号。"


def _payload(model, effort, max_tokens):
    p = {"model": model, "temperature": 0, "max_tokens": max_tokens, "stream": True,
         "stream_options": {"include_usage": True},
         "messages": [{"role": "system", "content": SYSTEM_PROMPT},
                      {"role": "user", "content": "【资料】\n" + "\n".join(CONTEXT_SNIPPETS)
                                                  + f"\n\n【问题】{QUESTION}"}]}
    if effort:
        p["reasoning_effort"] = effort
    return p


def _one_call(base, key, payload, timeout=90):
    """One streaming call, four clocks. Never raises; a failure is a recorded row."""
    url = f"{base.rstrip('/')}/chat/completions"
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 method="POST")
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    out = {"http": None, "t_first_event": None, "t_first_visible": None,
           "total_seconds": None, "text": "", "reasoning_chars": 0,
           "visible_deltas": 0, "reasoning_deltas": 0, "finish_reason": None,
           "completion_tokens": None, "prompt_tokens": None, "cached_tokens": None,
           "error": None}
    t0 = time.perf_counter()
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        out["http"] = resp.status
        try:
            for rawline in resp:
                line = rawline.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                # First stream event of ANY kind: this is when a progress
                # indicator can move, even if the frame carries only a role or an
                # empty delta. Kept distinct from t_first_visible on purpose.
                if out["t_first_event"] is None:
                    out["t_first_event"] = round(time.perf_counter() - t0, 3)
                chunk = line[5:].strip()
                if chunk == "[DONE]":
                    break
                try:
                    ev = json.loads(chunk)
                except Exception:
                    continue
                if ev.get("usage"):
                    u = ev["usage"]
                    out["completion_tokens"] = u.get("completion_tokens")
                    out["prompt_tokens"] = u.get("prompt_tokens")
                    out["cached_tokens"] = (u.get("prompt_tokens_details") or {}
                                            ).get("cached_tokens")
                for ch in ev.get("choices") or []:
                    if ch.get("finish_reason"):
                        out["finish_reason"] = ch["finish_reason"]
                    d = ch.get("delta") or {}
                    rp = d.get("reasoning_content") or d.get("reasoning") or ""
                    cp = d.get("content") or ""
                    if rp:
                        out["reasoning_deltas"] += 1
                        out["reasoning_chars"] += len(rp)
                    if cp:
                        if out["t_first_visible"] is None:
                            out["t_first_visible"] = round(time.perf_counter() - t0, 3)
                        out["visible_deltas"] += 1
                        out["text"] += cp
        finally:
            resp.close()
    except urllib.error.HTTPError as e:
        out["http"] = e.code
        try:
            out["error"] = e.read().decode("utf-8", errors="replace")[:200]
        except Exception:
            out["error"] = f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 — timeouts are data, not crashes
        out["error"] = type(e).__name__ + ": " + str(e)
    out["total_seconds"] = round(time.perf_counter() - t0, 3)
    return out


class Pacer:
    """Keep starts under the account's RPM ceiling.

    StepFun returned `request limited RPM reached, current: 11, limit: 10` on this
    account tier, and the first (unpaced) run lost 31 of 40 samples to 429 — which
    would have produced a latency verdict from 5 survivors. Rate limiting is an
    operational condition on OUR side of the call, never a provider contract
    verdict; the same rule was already forced on us by the Stage C reranker leg.
    So requests are paced to the ceiling and 429s are retried, not sampled."""

    def __init__(self, rpm):
        self.rpm = max(1, int(rpm))
        self.starts = []

    def wait(self):
        while True:
            now = time.monotonic()
            self.starts = [t for t in self.starts if now - t < 60.0]
            if len(self.starts) < self.rpm:
                self.starts.append(now)
                return
            time.sleep(max(0.5, 60.0 - (now - self.starts[0]) + 0.5))


def _sample(base, key, payload, timeout=90, pacer=None, max_429_retries=4):
    """A paced sample: 429 is retried with backoff and never returned as a row.

    Only the final non-429 attempt's clocks are kept; the number of 429s absorbed
    is recorded so throughput cost stays visible without polluting the latency
    distribution."""
    absorbed, waited = 0, 0.0
    for attempt in range(max_429_retries + 1):
        if pacer:
            pacer.wait()
        row = _one_call(base, key, payload, timeout=timeout)
        if row["http"] != 429 or attempt == max_429_retries:
            row["rate_limit_429_absorbed"] = absorbed
            row["rate_limit_wait_seconds"] = round(waited, 2)
            return row
        absorbed += 1
        # No retry-after header was observed, so back off on the RPM window itself.
        nap = min(60.0, 8.0 * (attempt + 1))
        waited += nap
        time.sleep(nap)


def _grade(text):
    """Grade the visible answer against the fixture's two facts and its citations.

    Deliberately mechanical and stated in full so the numbers are auditable:
      fact_refund   — 签收后 7 天内可退款 ([D1])
      fact_shipping — 退货运费由商家承担 ([D2])
      cites         — which snippet ids appear at all
    `answer_correct` requires BOTH facts AND both carrying citations, because a
    right answer with no citation is not acceptable output for this product. A
    hedge ("资料不足") on a question the fixture fully answers is a wrong answer,
    so it is flagged separately rather than silently passing."""
    t = text or ""
    cites = sorted(set(re.findall(r"D[123]", t)))
    fact_refund = bool(re.search(r"7\s*天", t)) and ("退款" in t or "退货" in t)
    # Merchant bears return shipping — reject the inverted claim (买家/客户承担).
    fact_shipping = "商家" in t and not re.search(r"(买家|客户|消费者|用户)承担", t)
    hedged = bool(re.search(r"资料不足|无法确定|未提及", t))
    return {"text_chars": len(t), "cites": cites,
            "fact_refund": fact_refund, "fact_shipping": fact_shipping,
            "cites_d1": "D1" in cites, "cites_d2": "D2" in cites,
            "hedged_despite_evidence": hedged,
            "answer_correct": bool(fact_refund and fact_shipping
                                   and "D1" in cites and "D2" in cites and not hedged)}


def _pct(sorted_xs, q):
    """Nearest-rank percentile: at n=20, p95 is the 19th of 20. Weak by
    construction — reported beside max, never instead of it."""
    if not sorted_xs:
        return None
    k = max(1, math.ceil(q * len(sorted_xs)))
    return sorted_xs[k - 1]


def _stats(rows, price_in, price_out):
    ok = [r for r in rows if r["http"] == 200 and r["total_seconds"] is not None
          and r["visible_deltas"] > 0]
    tot = sorted(r["total_seconds"] for r in ok)
    vis = sorted(r["t_first_visible"] for r in ok if r["t_first_visible"] is not None)
    evt = sorted(r["t_first_event"] for r in ok if r["t_first_event"] is not None)
    ct = [r["completion_tokens"] for r in ok if r["completion_tokens"] is not None]
    pt = [r["prompt_tokens"] for r in ok if r["prompt_tokens"] is not None]
    rc = sorted(r["reasoning_chars"] for r in ok)
    graded = [r["grade"] for r in ok]

    def _d(xs):
        if not xs:
            return None
        return {"n": len(xs), "min": xs[0], "p50": _pct(xs, 0.50), "p90": _pct(xs, 0.90),
                "p95": _pct(xs, 0.95), "max": xs[-1],
                "mean": round(sum(xs) / len(xs), 3)}

    mean_ct = round(sum(ct) / len(ct), 1) if ct else None
    mean_pt = round(sum(pt) / len(pt), 1) if pt else None
    cost = None
    if mean_ct is not None and (price_in or price_out):
        cost = round((mean_pt or 0) / 1e6 * (price_in or 0)
                     + mean_ct / 1e6 * (price_out or 0), 8)
    return {
        "attempted": len(rows), "usable": len(ok),
        "http_codes": sorted({r["http"] for r in rows}, key=lambda x: (x is None, x)),
        "full_generation_seconds": _d(tot),
        "first_visible_seconds": _d(vis),
        "first_event_seconds": _d(evt),
        "reasoning_chars": _d(rc),
        "mean_completion_tokens": mean_ct, "mean_prompt_tokens": mean_pt,
        "mean_cost_cny_per_answer": cost,
        "over_3_5s": sum(1 for x in tot if x > 3.5),
        "over_2_0s": sum(1 for x in tot if x > 2.0),
        "answer_correct_rate": (round(sum(1 for g in graded if g["answer_correct"])
                                      / len(graded), 3) if graded else None),
        "fact_refund_rate": (round(sum(1 for g in graded if g["fact_refund"])
                                   / len(graded), 3) if graded else None),
        "fact_shipping_rate": (round(sum(1 for g in graded if g["fact_shipping"])
                                     / len(graded), 3) if graded else None),
        "cite_d1_d2_rate": (round(sum(1 for g in graded
                                      if g["cites_d1"] and g["cites_d2"]) / len(graded), 3)
                            if graded else None),
        "hedged_count": sum(1 for g in graded if g["hedged_despite_evidence"]),
        "truncated_count": sum(1 for r in ok if r["finish_reason"] == "length"),
        "rate_limit_429_absorbed": sum(r.get("rate_limit_429_absorbed") or 0
                                       for r in rows),
        "rate_limit_wait_seconds": round(sum(r.get("rate_limit_wait_seconds") or 0.0
                                             for r in rows), 1),
    }


def run_ab(base, key, model, arms, runs, max_tokens, rpm=8, sleep_s=0.0,
           progress=True):
    """Interleave the arms so provider-load drift hits both equally, paced to RPM."""
    rows = {a: [] for a in arms}
    pacer = Pacer(rpm)
    for i in range(runs):
        for a in arms:
            eff = None if a == "(unset)" else a
            r = _sample(base, key, _payload(model, eff, max_tokens), pacer=pacer)
            r["grade"] = _grade(r["text"])
            r["arm"] = a
            r["iteration"] = i + 1
            r.pop("text", None)  # keep reports free of generated prose bulk
            rows[a].append(r)
            if progress:
                print(f"  [{i + 1}/{runs}] {a}: http={r['http']} "
                      f"total={r['total_seconds']}s visible={r['t_first_visible']}s "
                      f"429x{r.get('rate_limit_429_absorbed')}", flush=True)
            if sleep_s:
                time.sleep(sleep_s)
    return rows


def evaluate(model, arms, stats, max_tokens, target_s=3.5, regular_s=2.0,
             baseline_arm="low", rpm=None):
    fails, decides = [], []
    b = stats.get(baseline_arm)
    if not b or not b["usable"]:
        fails.append(f"`{baseline_arm}` 档无可用样本（HTTP {b['http_codes'] if b else '?'}）："
                     "无法裁决时延目标。")
        return fails, decides, "BLOCKED"
    # 样本完整性先行：限流/超时把样本吃掉时，任何 p95 都是幸存者偏差，不得当结论。
    if b["usable"] < max(10, int(0.8 * b["attempted"])):
        fails.append(
            f"`{baseline_arm}` 档仅 {b['usable']}/{b['attempted']} 条可用"
            f"（HTTP {b['http_codes']}）：样本被限流/失败吃掉，p95 是幸存者偏差，"
            "**本次时延判定作废**，须降速复跑。")
    if b.get("rate_limit_429_absorbed"):
        decides.append(
            f"账号 RPM 上限是真实容量约束：本次 `{baseline_arm}` 档吸收了 "
            f"{b['rate_limit_429_absorbed']} 次 429（退避等待 "
            f"{b.get('rate_limit_wait_seconds')}s）。实测该账号档位 RPM=10 —— "
            "生产侧需按并发问答量核算配额并在 Adapter 做排队/退避，"
            "但 429 属我方运行条件，不计入供应商时延契约。")
    fg = b["full_generation_seconds"]
    if fg["p95"] <= target_s:
        decides.append(
            f"**验收达标**：`{model}` + `reasoning_effort={baseline_arm}` 完整生成 "
            f"p95={fg['p95']}s ≤ ADR-0027 高风险预算 {target_s}s"
            f"（n={fg['n']}，min {fg['min']}s / p50 {fg['p50']}s / max {fg['max']}s，"
            f">{target_s}s 共 {b['over_3_5s']} 次）→ **无需继续放宽时延预算**。"
            f"但 n={fg['n']} 的 p95 是最近秩估计（第 {math.ceil(0.95 * fg['n'])} 名），"
            "证据强度有限；且该端点历史上同 payload 曾测到 7.7-9.7s，正式定档应跨时段复测。")
    else:
        fails.append(
            f"`{baseline_arm}` 档完整生成 p95={fg['p95']}s > {target_s}s"
            f"（n={fg['n']}，max {fg['max']}s，>{target_s}s 共 {b['over_3_5s']} 次）："
            f"不满足验收目标，`{model}` 不能仅凭「更快」替换旧版。")
    if fg["p95"] > regular_s:
        decides.append(
            f"常规问答预算 {regular_s}s 仍有 {b['over_2_0s']}/{fg['n']} 次越界"
            f"（p90={fg['p90']}s、p95={fg['p95']}s）：常规腿超时按上界设，"
            "逐句 Embedding 与蕴含调用必须并发（ADR-0027 硬约束）。")
    # 质量闸门：为压时延而调低推理，只有在答案与引用不退化时才成立。
    if (b["answer_correct_rate"] or 0) < 1.0:
        decides.append(
            f"`{baseline_arm}` 档答案正确率 {b['answer_correct_rate']}"
            f"（退款事实 {b['fact_refund_rate']}、运费承担 {b['fact_shipping_rate']}、"
            f"D1+D2 引用 {b['cite_d1_d2_rate']}、无据保守回答 {b['hedged_count']} 次）："
            "低于 1.0 说明降低推理确有质量代价，需与高档对比后决定是否只在低置信度重试时升档。")
    for a in arms:
        if a == baseline_arm or not stats.get(a) or not stats[a]["usable"]:
            continue
        o = stats[a]
        decides.append(
            f"档位对比 `{baseline_arm}` vs `{a}`：完整生成 p95 {fg['p95']}s vs "
            f"{o['full_generation_seconds']['p95']}s、可读答案首字 p95 "
            f"{b['first_visible_seconds']['p95']}s vs {o['first_visible_seconds']['p95']}s、"
            f"completion tokens 均值 {b['mean_completion_tokens']} vs "
            f"{o['mean_completion_tokens']}、CoT 字数中位 "
            f"{b['reasoning_chars']['p50']} vs {o['reasoning_chars']['p50']}、"
            f"答案正确率 {b['answer_correct_rate']} vs {o['answer_correct_rate']}。"
            "据此决定默认档与升档条件（复杂问题/低置信度重试）。")
        # 供应商宣称 low 能压隐藏推理与 TTFT。若两档分布重叠、token 均值差 <15%，
        # 该旋钮在**本 fixture 上**不起作用。注意作用域：本探针只喂一种 payload，
        # 因此只能判「在这个任务上不binding」，**不能**推广成「该模型不支持此参数」
        # ——参数是否被接受、在低难度问题上是否有效，由契约探针的
        # reasoning_accounting 检查回答（同一模型上曾测到 low 45-48 字符 vs
        # high 295-588，即琐碎问题上该旋钮很有效）。两者不矛盾：任务自身的推理
        # 需求给 CoT 设了地板，low 只有在地板低于其上限时才看得出效果。
        brc, orc = b["reasoning_chars"], o["reasoning_chars"]
        overlap = brc["max"] >= orc["min"] and orc["max"] >= brc["min"]
        bct, oct_ = b["mean_completion_tokens"] or 0, o["mean_completion_tokens"] or 0
        token_gap = abs(oct_ - bct) / max(1.0, float(bct))
        if overlap and token_gap < 0.15:
            decides.append(
                f"**`reasoning_effort` 在本 fixture 上不 binding**（作用域限于这一种 "
                f"payload，非「该模型不支持此参数」）：`{baseline_arm}` 与 `{a}` 的 "
                f"CoT 字数分布完全重叠（{brc['min']}-{brc['max']} vs "
                f"{orc['min']}-{orc['max']}，中位 {brc['p50']} vs {orc['p50']}），"
                f"completion tokens 均值仅差 {round(token_gap * 100, 1)}%"
                f"（{bct} vs {oct_}），完整生成 p95 也未见 `{baseline_arm}` 更快。"
                "对照：同一模型的契约探针 reasoning_accounting 检查在**琐碎短问题**上"
                "测到 low CoT 45-48 字符 / 29-32 completion tokens vs high 295-588 / "
                "160-302，该旋钮在那里非常有效。两个结果不矛盾——任务自身的推理需求给 "
                "CoT 设地板，本 grounded 引用任务的地板（约 300 字符）已高于 low 的"
                "上限，旋钮拧不动。**结论：不得把 `reasoning_effort=low` 当作 RAG "
                "答案腿的压时延手段**（在真实负载形态上它无可测收益）；默认仍可传 low"
                "（无害、成本略低，且在简单问答上确有收益），但时延必须靠超时+重试/"
                "对冲与模型选择解决。")
    if b["truncated_count"]:
        decides.append(
            f"`{baseline_arm}` 档有 {b['truncated_count']} 次 finish_reason=length："
            f"max_tokens={max_tokens} 对「CoT+正文」仍不足，Adapter 需两段预留并把截断"
            "当受控错误上抛。")
    status = "BLOCKED" if fails else ("PASS_WITH_ADJUSTMENT" if decides else "PASS")
    return fails, decides, status


def _md(doc, path):
    m, arms = doc["measurements"], doc["arms"]
    stats = m["stats"]
    L = [f"# PROBE-005 Stage B 补充 · `reasoning_effort` A/B（{doc['provider']} · "
         f"`{doc['model']}`）", "",
         f"- 状态：**{doc['status']}**",
         f"- 执行时间：{doc['executed_at']}",
         f"- base：`{doc['base']}`；协议：`POST {{base}}/chat/completions`（流式）",
         f"- 每档样本数：**{m['runs']}**（两档交错发起，按 RPM="
         f"{m.get('rpm_ceiling_paced_to')} 限速，429 退避重试不计入样本）；"
         f"max_tokens={m['max_tokens']}；"
         f"temperature=0；固定同一 grounded 客服 fixture",
         f"- 验收目标：`{m['baseline_arm']}` 档完整生成 **p95 ≤ {m['target_s']}s**"
         f"（ADR-0027 高风险预算）", "",
         "## 方法（为什么这样测）", "",
         "- **两档交错**：供应商负载按分钟级漂移，先 20 次 low 再 20 次 high 会把漂移算成参数"
         "效果。交错让两档共享同一「天气」。",
         "- **四个时钟**：首个任意流事件（进度条可动）/ 首个可见正文（用户有字可读）/ 完整生成"
         "（ADR-0027 预算）/ completion tokens（ADR-0029 成本），四者回答不同问题。",
         "- **质量与时延同表**：为压时延调低推理，只有在答案与引用不退化时才算赢，故每条样本都"
         "按 fixture 的两个事实与引用编号机械判分。",
         f"- **p95 是最近秩估计**：n={m['runs']} 时 p95 取排序第 "
         f"{math.ceil(0.95 * m['runs'])} 名，估计量偏弱，故与 max 并列给出，不单独宣称。", "",
         "## 时延与成本（LIVE）", "",
         "| 档位 | 可用/尝试 | 完整生成 min/p50/p90/**p95**/max (s) | 可读答案首字 p50/p95 (s) | "
         "首事件 p50/p95 (s) | >3.5s | >2.0s | completion tokens 均值 | CoT 字数 p50 | "
         "单次成本(元) |",
         "|---|---|---|---|---|---|---|---|---|---|"]
    for a in arms:
        s = stats.get(a) or {}
        fg = s.get("full_generation_seconds") or {}
        fv = s.get("first_visible_seconds") or {}
        fe = s.get("first_event_seconds") or {}
        rc = s.get("reasoning_chars") or {}
        L.append(f"| `{a}` | {s.get('usable')}/{s.get('attempted')} | "
                 f"{fg.get('min')}/{fg.get('p50')}/{fg.get('p90')}/**{fg.get('p95')}**/"
                 f"{fg.get('max')} | {fv.get('p50')}/{fv.get('p95')} | "
                 f"{fe.get('p50')}/{fe.get('p95')} | {s.get('over_3_5s')} | "
                 f"{s.get('over_2_0s')} | {s.get('mean_completion_tokens')} | "
                 f"{rc.get('p50')} | {s.get('mean_cost_cny_per_answer')} |")
    L += ["", "## 回答质量（LIVE · 同一 fixture 机械判分）", "",
          "| 档位 | 答案正确率 | 退款事实 | 运费承担 | D1+D2 引用 | 无据保守 | 截断次数 | "
          "吸收 429 |",
          "|---|---|---|---|---|---|---|---|"]
    for a in arms:
        s = stats.get(a) or {}
        L.append(f"| `{a}` | **{s.get('answer_correct_rate')}** | {s.get('fact_refund_rate')} | "
                 f"{s.get('fact_shipping_rate')} | {s.get('cite_d1_d2_rate')} | "
                 f"{s.get('hedged_count')} | {s.get('truncated_count')} | "
                 f"{s.get('rate_limit_429_absorbed')} |")
    L += ["", f"- 判分口径：答案正确 = 命中「签收后 7 天内可退款」+「退货运费由商家承担」两个"
          "事实，且同时引用 D1 与 D2，且未在证据充分时给出「资料不足」类保守回答。", ""]
    L += [f"- 单价（元/百万 in/out）：{m['price_cny_per_1m_in']} / {m['price_cny_per_1m_out']}；"
          f"来源：{m.get('price_source')}", ""]
    if doc["failures"]:
        L += ["## 失败项", *[f"- {x}" for x in doc["failures"]], ""]
    if doc["decisions_required"]:
        L += ["## 结论与待决策", *[f"- {x}" for x in doc["decisions_required"]], ""]
    L += ["## 逐次样本", "",
          "| # | 档位 | HTTP | 完整生成(s) | 首事件(s) | 可读答案(s) | 正文字符 | CoT字符 | "
          "completion tokens | finish | 答案正确 | 引用 |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for a in arms:
        for r in m["samples"].get(a) or []:
            g = r.get("grade") or {}
            it = str(r.get("iteration"))
            if r.get("source_report"):
                it += " (" + ("run2" if "run2" in r["source_report"] else "run1") + ")"
            L.append(f"| {it} | `{a}` | {r.get('http')} | "
                     f"{r.get('total_seconds')} | {r.get('t_first_event')} | "
                     f"{r.get('t_first_visible')} | {g.get('text_chars')} | "
                     f"{r.get('reasoning_chars')} | {r.get('completion_tokens')} | "
                     f"{r.get('finish_reason')} | {g.get('answer_correct')} | "
                     f"{','.join(g.get('cites') or []) or '-'} |")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")


def pool_reports(paths):
    """Pool sample rows from several A/B report JSONs into one distribution.

    Two 20-per-arm runs six minutes apart disagreed on the verdict (low-arm p95
    2.308 s then 5.668 s), which is the whole reason a P95 claim cannot rest on one
    run: the endpoint's TAIL drifts even when its median does not. Pooling states
    the distribution actually observed instead of picking the flattering run."""
    arms, rows, meta = [], {}, None
    for p in paths:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
        meta = meta or d
        for a in d["arms"]:
            if a not in arms:
                arms.append(a)
                rows[a] = []
            for r in d["measurements"]["samples"][a]:
                r = dict(r)
                r["source_report"] = os.path.basename(p)
                rows[a].append(r)
    return meta, arms, rows


def _fenv(name):
    v = os.environ.get(name)
    return float(v) if v else 0.0


def _pool_main(args):
    """Offline: recompute the verdict over pooled samples. No network, no cost."""
    meta, arms, rows = pool_reports(args.pool_from)
    if args.baseline_arm not in arms:
        print(f"ERROR: --baseline-arm={args.baseline_arm} 不在被合并报告的档位 {arms} 内。")
        return 2
    pin = args.price_in_per_1m or meta["measurements"].get("price_cny_per_1m_in") or 0.0
    pout = args.price_out_per_1m or meta["measurements"].get("price_cny_per_1m_out") or 0.0
    stats = {a: _stats(rows[a], pin, pout) for a in arms}
    fails, decides, status = evaluate(meta["model"], arms, stats, args.max_tokens,
                                      args.target_seconds, args.regular_seconds,
                                      args.baseline_arm)
    decides.insert(0, "**本报告是多次运行的合并分布**（来源：" +
                   "、".join(os.path.basename(p) for p in args.pool_from) +
                   "）。单次运行之间 p95 曾在 2.3s 与 5.7s 间跳动，故定档以合并分布为准，"
                   "不取任何单次运行的有利结果。")
    doc = {"probe_id": "PROBE-005", "stage": "B-chat-effort-ab-pooled",
           "api": "chat.completions", "status": status,
           "executed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "provider": meta["provider"], "model": meta["model"], "base": meta["base"],
           "arms": arms, "pooled_from": [os.path.basename(p) for p in args.pool_from],
           "measurements": {"runs": len(rows[args.baseline_arm]),
                            "max_tokens": args.max_tokens,
                            "rpm_ceiling_paced_to":
                                meta["measurements"].get("rpm_ceiling_paced_to"),
                            "baseline_arm": args.baseline_arm,
                            "target_s": args.target_seconds,
                            "regular_s": args.regular_seconds,
                            "price_cny_per_1m_in": pin, "price_cny_per_1m_out": pout,
                            "price_source": meta["measurements"].get("price_source"),
                            "stats": stats, "samples": rows},
           "failures": fails, "decisions_required": decides, "recommendation": status}
    slug = args.report_slug or (
        "probe-005-model-adapter-chat-"
        + re.sub(r"[^a-z0-9._-]+", "-", (meta["provider"] or "unknown").lower()).strip("-")
        + "-effort-ab-"
        + re.sub(r"[^a-z0-9._-]+", "-", meta["model"].lower()).strip("-") + "-pooled")
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, slug + ".json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    _md(doc, os.path.join(args.out, slug + ".md"))
    print(f"PROBE-005 Stage B `reasoning_effort` A/B (合并 {len(args.pool_from)} 次运行) "
          f"status: {status}")
    print(f"  报告：{os.path.join(args.out, slug)}.md/.json")
    for x in fails:
        print(f"  FAIL: {x}")
    for x in decides:
        print(f"  DECIDE: {x}")
    return 0 if status != "BLOCKED" else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("CHAT_BASE", "https://api.stepfun.com/v1"))
    ap.add_argument("--model", default=os.environ.get("CHAT_MODEL"))
    ap.add_argument("--provider", default=os.environ.get("CHAT_PROVIDER") or "stepfun")
    ap.add_argument("--arms", default="low,high",
                    help="comma-separated reasoning_effort values; '(unset)' omits the field")
    ap.add_argument("--baseline-arm", default="low",
                    help="the arm the acceptance target is judged on")
    ap.add_argument("--runs", type=int, default=20, help="samples PER ARM")
    ap.add_argument("--max-tokens", type=int, default=1200)
    ap.add_argument("--target-seconds", type=float, default=3.5)
    ap.add_argument("--regular-seconds", type=float, default=2.0)
    ap.add_argument("--sleep-seconds", type=float, default=0.0)
    ap.add_argument("--rpm", type=int, default=int(os.environ.get("CHAT_RPM") or 8),
                    help="safe request rate below the observed 10 RPM account ceiling; "
                         "requests are paced because a 429 storm would decide the latency "
                         "question for us")
    ap.add_argument("--out", required=True)
    ap.add_argument("--report-slug", default=None)
    ap.add_argument("--price-in-per-1m", type=float, default=_fenv("CHAT_PRICE_CNY_PER_1M_IN"))
    ap.add_argument("--price-out-per-1m", type=float, default=_fenv("CHAT_PRICE_CNY_PER_1M_OUT"))
    ap.add_argument("--price-source", default=os.environ.get("CHAT_PRICE_SOURCE"))
    ap.add_argument("--pool-from", nargs="+", default=None,
                    help="pool existing A/B report JSONs into one verdict instead of "
                         "making any calls (a P95 must not rest on a single run)")
    args = ap.parse_args()
    if args.pool_from:
        return _pool_main(args)
    if not args.model:
        print("ERROR: 未指定 --model / CHAT_MODEL。未做任何网络调用，未产生费用。")
        return 3
    key = os.environ.get("CHAT_API_KEY") or os.environ.get("STEPFUN_API_KEY")
    if not key:
        print("ERROR: 未找到 CHAT_API_KEY / STEPFUN_API_KEY。未做任何网络调用，未产生费用。")
        return 3
    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    if args.baseline_arm not in arms:
        print(f"ERROR: --baseline-arm={args.baseline_arm} 不在 --arms={arms} 内。")
        return 2
    # 凭据/模型预检：一次最小调用。401/403/404 不是「档位结论」，不写报告。
    pre = _sample(args.base, key, _payload(args.model, None, 32))
    if pre["http"] in (401, 403, 404) or pre["http"] is None:
        print(f"ERROR: 预检失败 HTTP {pre['http']}：{str(pre['error'])[:200]}\n"
              f"  base={args.base} model={args.model}\n"
              "  **未写任何报告**：凭据/模型不可用不是供应商档位结论。")
        return 3
    rows = run_ab(args.base, key, args.model, arms, args.runs, args.max_tokens,
                  rpm=args.rpm, sleep_s=args.sleep_seconds)
    stats = {a: _stats(rows[a], args.price_in_per_1m, args.price_out_per_1m) for a in arms}
    fails, decides, status = evaluate(args.model, arms, stats, args.max_tokens,
                                      args.target_seconds, args.regular_seconds,
                                      args.baseline_arm, rpm=args.rpm)
    doc = {"probe_id": "PROBE-005", "stage": "B-chat-effort-ab", "api": "chat.completions",
           "status": status,
           "executed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "provider": args.provider, "model": args.model, "base": args.base,
           "arms": arms,
           "measurements": {"runs": args.runs, "max_tokens": args.max_tokens,
                            "rpm_ceiling_paced_to": args.rpm,
                            "baseline_arm": args.baseline_arm,
                            "target_s": args.target_seconds,
                            "regular_s": args.regular_seconds,
                            "price_cny_per_1m_in": args.price_in_per_1m,
                            "price_cny_per_1m_out": args.price_out_per_1m,
                            "price_source": args.price_source or "(未提供单价来源)",
                            "stats": stats, "samples": rows},
           "failures": fails, "decisions_required": decides, "recommendation": status}
    slug = args.report_slug or (
        "probe-005-model-adapter-chat-"
        + re.sub(r"[^a-z0-9._-]+", "-", args.provider.lower()).strip("-")
        + "-effort-ab-" + re.sub(r"[^a-z0-9._-]+", "-", args.model.lower()).strip("-"))
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, slug + ".json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    _md(doc, os.path.join(args.out, slug + ".md"))
    print(f"PROBE-005 Stage B `reasoning_effort` A/B status: {status}")
    print(f"  报告：{os.path.join(args.out, slug)}.md/.json")
    for x in fails:
        print(f"  FAIL: {x}")
    for x in decides:
        print(f"  DECIDE: {x}")
    return 0 if status != "BLOCKED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
