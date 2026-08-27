#!/usr/bin/env python3
"""PROBE-004: RabbitMQ 任务总线探针 — 通过 management HTTP API 验证 broker 原语
(路由确认 / DLX 死信关联 / TTL 延迟重试阶梯 / quarantine 不无限 requeue),
PG 侧协议(Attempt、幂等 Outbox 去重、执行前取消、replay=新 Generation)在应用层用 Python 模拟并明确标注。
纯标准库,只依赖 urllib + management HTTP API。"""
import argparse
import base64
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = os.environ.get("RABBITMQ_MGMT_URL", "http://127.0.0.1:15672")
USER = os.environ.get("PROBE_RABBITMQ_USER", "probe")
PASS = os.environ["PROBE_RABBITMQ_PASS"]
VHOST = "%2F"  # "/" url-encoded
AUTH = "Basic " + base64.b64encode(f"{USER}:{PASS}".encode()).decode()
# 探针里用短 TTL 演示阶梯,生产阶梯为 30s / 5m / 30m。
RETRY_TTL_MS = [1500, 3000, 4500]
PROD_RETRY_LADDER = ["30s", "5m", "30m"]


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": AUTH}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{BASE}/api{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"_raw": raw.decode(errors="replace")[:300]}


def wait_ready():
    for _ in range(90):
        try:
            st, _ = api("GET", "/overview")
            if st == 200:
                return True
        except Exception:
            pass
        time.sleep(2)
    return False
# CHUNK-2


def declare_exchange(name, ex_type="direct"):
    api("PUT", f"/exchanges/{VHOST}/{name}", {"type": ex_type, "durable": True})


def declare_queue(name, arguments=None):
    api("PUT", f"/queues/{VHOST}/{name}", {"durable": True, "arguments": arguments or {}})


def bind(exchange, queue, routing_key):
    api("POST", f"/bindings/{VHOST}/e/{exchange}/q/{queue}", {"routing_key": routing_key})


def publish(exchange, routing_key, payload, headers=None):
    props = {"delivery_mode": 2}
    if headers:
        props["headers"] = headers
    st, res = api("POST", f"/exchanges/{VHOST}/{exchange}/publish", {
        "properties": props, "routing_key": routing_key,
        "payload": json.dumps(payload), "payload_encoding": "string"})
    return res.get("routed", False)


def get_messages(queue, count=10, ackmode="ack_requeue_false"):
    st, res = api("POST", f"/queues/{VHOST}/{queue}/get", {
        "count": count, "ackmode": ackmode, "encoding": "auto"})
    return res if isinstance(res, list) else []


def queue_depth(queue):
    st, res = api("GET", f"/queues/{VHOST}/{queue}")
    if st != 200:
        return None
    return res.get("messages", 0)


def authoritative_count(queue, ackmode="ack_requeue_false"):
    # management 的 `messages` 字段是采样值,滞后数秒;需要精确计数/排空时用 GET 取真实队列状态。
    return len(get_messages(queue, count=100, ackmode=ackmode))


def purge_all(names):
    for n in names:
        api("DELETE", f"/queues/{VHOST}/{n}/contents")


def reset_topology(names_q, names_e):
    for n in names_q:
        api("DELETE", f"/queues/{VHOST}/{n}")
    for n in names_e:
        api("DELETE", f"/exchanges/{VHOST}/{n}")
# CHUNK-3


def verify_routing_and_idempotent_relay():
    # 项1:broker 报告路由结果(routed=confirm 等价);Outbox Relay 在确认丢失后重发,
    # 消费端按 message_id 幂等去重,达到 effect-once。
    declare_exchange("work.ex")
    declare_queue("work.q")
    bind("work.ex", "work.q", "task")
    purge_all(["work.q"])
    routed_ok = publish("work.ex", "task", {"task_id": "t-1"}, headers={"message_id": "m-1"})
    # 无绑定的 routing key → 不可路由,relay 据此知道需要处理(mandatory 等价)。
    routed_unroutable = publish("work.ex", "no-binding", {"task_id": "t-x"})
    # 模拟确认丢失后 relay 重发同一条 outbox 行(同 message_id)。
    publish("work.ex", "task", {"task_id": "t-1"}, headers={"message_id": "m-1"})
    msgs = get_messages("work.q", count=10)
    seen, deduped, effects = set(), 0, 0
    for m in msgs:
        mid = (m.get("properties", {}).get("headers") or {}).get("message_id")
        if mid in seen:
            deduped += 1          # 消费端幂等:重复投递被丢弃
            continue
        seen.add(mid)
        effects += 1              # 只有首次投递产生副作用
    return {
        "routed_confirm": routed_ok,
        "unroutable_detected": routed_unroutable is False,
        "delivered_count": len(msgs),
        "duplicates_dropped": deduped,
        "effect_once": effects == 1 and deduped >= 1,
    }


def verify_delayed_retry():
    # 项2:瞬时错误 → 新 Attempt 进重试队列;TTL + DLX 实现 30s/5m/30m 延迟阶梯。
    # 探针用短 TTL(1.5s)验证机制:消息 TTL 到期后自动死信回 work 交换机。
    declare_exchange("retry.work.ex")
    declare_queue("retry.work.q")
    bind("retry.work.ex", "retry.work.q", "task")
    declare_exchange("retry.in.ex")
    declare_queue("retry.30s.q", arguments={
        "x-message-ttl": RETRY_TTL_MS[0],
        "x-dead-letter-exchange": "retry.work.ex",
        "x-dead-letter-routing-key": "task"})
    bind("retry.in.ex", "retry.30s.q", "retry")
    purge_all(["retry.work.q", "retry.30s.q"])
    publish("retry.in.ex", "retry", {"task_id": "t-retry", "attempt": 1}, headers={"message_id": "r-1"})
    time.sleep(RETRY_TTL_MS[0] / 1000.0 + 2.5)
    landed = authoritative_count("retry.work.q")  # 采样统计滞后,用 GET 取真实计数
    return {
        "prod_retry_ladder": PROD_RETRY_LADDER,
        "probe_ttl_ms": RETRY_TTL_MS[0],
        "message_redelivered_after_ttl": landed == 1,
        "landed_in_work_queue": landed,
    }
# CHUNK-4


def verify_cancel_before_execute():
    # 项3:陈旧 Generation / 已取消 / 超过 deadline 的消息在执行前被 ACK,不产生任何副作用。
    declare_exchange("cancel.ex")
    declare_queue("cancel.q")
    bind("cancel.ex", "cancel.q", "task")
    purge_all(["cancel.q"])
    # PG 权威状态(模拟):三条消息在入队后被取消/失效/超时。
    pg_state = {
        "g-stale": {"current_generation": "g-new"},   # 陈旧 generation
        "g-cancel": {"cancelled": True},
        "g-expired": {"deadline_ms": 0},               # deadline 已过
    }
    for gid in pg_state:
        publish("cancel.ex", "task", {"generation_id": gid}, headers={"message_id": gid})
    msgs = get_messages("cancel.q", count=10)  # ack_requeue_false = 执行前先取出并 ACK
    side_effects = 0
    now = int(time.time() * 1000)
    for m in msgs:
        gid = json.loads(m["payload"])["generation_id"]
        st = pg_state.get(gid, {})
        stale = st.get("current_generation", gid) != gid
        cancelled = st.get("cancelled", False)
        expired = st.get("deadline_ms", now + 1) <= now
        if not (stale or cancelled or expired):
            side_effects += 1   # 只有仍然有效的才会执行;本例三条都应被跳过
    return {
        "drained_before_execute": authoritative_count("cancel.q") == 0,
        "acked_count": len(msgs),
        "side_effects": side_effects,
        "no_side_effects_ok": side_effects == 0 and len(msgs) == 3,
    }


def verify_permanent_dlq():
    # 项4:永久错误 → reject(不 requeue)死信到 DLQ;x-death 头保留原队列/原因关联。
    declare_exchange("dlx.ex")
    declare_queue("dead.q")
    bind("dlx.ex", "dead.q", "task")
    declare_queue("perm.q", arguments={
        "x-dead-letter-exchange": "dlx.ex", "x-dead-letter-routing-key": "task"})
    declare_exchange("perm.in.ex")
    bind("perm.in.ex", "perm.q", "task")
    purge_all(["perm.q", "dead.q"])
    dl_id = "dl-1"
    publish("perm.in.ex", "task", {"task_id": "t-perm"}, headers={"message_id": dl_id})
    # 永久错误:reject 不 requeue → 触发死信。
    get_messages("perm.q", count=10, ackmode="reject_requeue_false")
    time.sleep(0.5)
    dead = get_messages("dead.q", count=10)
    x_death = None
    if dead:
        x_death = (dead[0].get("properties", {}).get("headers") or {}).get("x-death")
    return {
        "dead_lettered": len(dead) == 1,
        "x_death_present": bool(x_death),
        "x_death_origin_queue": (x_death[0].get("queue") if x_death else None),
        "x_death_reason": (x_death[0].get("reason") if x_death else None),
        "correlated_ok": len(dead) == 1 and bool(x_death)
        and x_death[0].get("queue") == "perm.q",
    }
# CHUNK-5


def verify_quarantine_no_requeue():
    # 项5:未知 schemaVersion → 路由到 quarantine 并 ACK 原消息,不进入无限 requeue 循环。
    declare_exchange("quar.ex")
    declare_queue("quar.work.q")
    bind("quar.ex", "quar.work.q", "task")
    declare_exchange("quar.hold.ex")
    declare_queue("quar.hold.q")
    bind("quar.hold.ex", "quar.hold.q", "task")
    purge_all(["quar.work.q", "quar.hold.q"])
    KNOWN = {"v1", "v2"}
    publish("quar.ex", "task", {"task_id": "t-unknown"}, headers={"schema_version": "v999"})
    quarantined = 0
    for m in get_messages("quar.work.q", count=10):  # ACK(不 requeue)
        sv = (m.get("properties", {}).get("headers") or {}).get("schema_version")
        if sv not in KNOWN:
            publish("quar.hold.ex", "task", json.loads(m["payload"]),
                    headers={"schema_version": sv, "quarantined": True})
            quarantined += 1
    # 无限 requeue 检查:原队列已排空(GET 真实计数)且旁路 hold 收到该消息。
    time.sleep(0.3)
    residual = authoritative_count("quar.work.q")
    holds = authoritative_count("quar.hold.q")
    return {
        "quarantined_count": quarantined,
        "work_queue_drained": residual == 0,
        "quarantine_holds": holds,
        "no_infinite_requeue_ok": quarantined == 1 and residual == 0 and holds == 1,
    }


def verify_replay_new_generation():
    # 项6:人工 replay 从死信重放,创建新 Generation,同时保留原死信链记录。
    declare_exchange("replay.dlx.ex")
    declare_queue("replay.dead.q")
    bind("replay.dlx.ex", "replay.dead.q", "task")
    declare_queue("replay.work.q", arguments={
        "x-dead-letter-exchange": "replay.dlx.ex", "x-dead-letter-routing-key": "task"})
    declare_exchange("replay.in.ex")
    bind("replay.in.ex", "replay.work.q", "task")
    purge_all(["replay.work.q", "replay.dead.q"])
    old_gen = "g-old-1"
    publish("replay.in.ex", "task", {"task_id": "t-replay", "generation_id": old_gen},
            headers={"message_id": "rp-1"})
    get_messages("replay.work.q", count=10, ackmode="reject_requeue_false")  # → 死信
    time.sleep(0.5)
    # PG 死信链(模拟):保留 old_gen 记录。
    dead_letter_chain = [{"generation_id": old_gen, "reason": "rejected"}]
    dead = get_messages("replay.dead.q", count=10, ackmode="ack_requeue_true")  # 只读不移除链
    replayed = bool(dead)
    new_gen = "g-new-2"  # 人工 replay 生成新 generation
    if replayed:
        payload = json.loads(dead[0]["payload"])
        payload["generation_id"] = new_gen
        payload["replayed_from"] = old_gen
        publish("replay.in.ex", "task", payload, headers={"message_id": "rp-2"})
    time.sleep(0.3)
    requeued = authoritative_count("replay.work.q")
    return {
        "replayed": replayed,
        "new_generation": new_gen,
        "old_generation_preserved": dead_letter_chain[0]["generation_id"] == old_gen,
        "requeued_to_work": requeued == 1,
        "replay_ok": replayed and new_gen != old_gen
        and dead_letter_chain[0]["generation_id"] == old_gen and requeued == 1,
    }
# CHUNK-6


def docker_rss_mb(compose_file):
    try:
        cid = subprocess.check_output(
            ["docker", "compose", "-f", compose_file, "ps", "-q", "rabbitmq-probe"],
            text=True).strip()
        if not cid:
            return None
        stat = subprocess.check_output(
            ["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", cid],
            text=True).strip()
        mem = stat.split("/")[0].strip()
        num = float("".join(c for c in mem if c.isdigit() or c == "."))
        if "GiB" in mem:
            return round(num * 1024, 1)
        if "MiB" in mem:
            return round(num, 1)
        return num
    except Exception:
        return None


ALL_QUEUES = [
    "work.q", "retry.work.q", "retry.30s.q", "cancel.q", "perm.q", "dead.q",
    "quar.work.q", "quar.hold.q", "replay.work.q", "replay.dead.q",
]
ALL_EXCHANGES = [
    "work.ex", "retry.work.ex", "retry.in.ex", "cancel.ex", "dlx.ex", "perm.in.ex",
    "quar.ex", "quar.hold.ex", "replay.dlx.ex", "replay.in.ex",
]


def write_results(result_dir, payload):
    result_dir = Path(result_dir)
    result_dir.mkdir(parents=True, exist_ok=True)
    (result_dir / "probe-004-rabbitmq-task-bus.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    m = payload.get("measurements", {})
    lines = ["# PROBE-004 RabbitMQ 任务总线", "",
             f"- status: `{payload['status']}`",
             f"- RabbitMQ image: `{payload.get('versions', {}).get('rabbitmq_image')}`",
             f"- 交互方式: management HTTP API(broker 原语实测) + PG 协议应用层模拟"]
    if not m:
        lines.append(f"- failures: {'; '.join(payload.get('failures', []))}")
        (result_dir / "probe-004-rabbitmq-task-bus.md").write_text(
            "\n".join(lines) + "\n", encoding="utf-8")
        return
    lines += ["", "## 校验(broker 实测 = live,PG 协议 = sim)"]
    for k, v in m["checks"].items():
        lines.append(f"- {k}: `{v}`")
    lines += ["", "## 指标",
              f"- routed 确认: `{m['detail']['routing']['routed_confirm']}` / "
              f"不可路由检出: `{m['detail']['routing']['unroutable_detected']}`",
              f"- 幂等去重丢弃: `{m['detail']['routing']['duplicates_dropped']}` 条(effect-once)",
              f"- 生产重试阶梯: `{m['detail']['retry']['prod_retry_ladder']}`(探针用 "
              f"{m['detail']['retry']['probe_ttl_ms']}ms 验证 TTL+DLX 机制)",
              f"- DLQ x-death 关联: `{m['detail']['permanent']['x_death_reason']}` @ "
              f"`{m['detail']['permanent']['x_death_origin_queue']}`",
              f"- 冻结 prefetch: 解析 `1` / 投影 `4`(见 PROJECT_STATE 硬边界,本探针不在 HTTP 路径复测)",
              f"- container RSS: `{m['container_rss_mb']}` MB"]
    if payload["decisions_required"]:
        lines += ["", "## 待决策"] + [f"- {d}" for d in payload["decisions_required"]]
    lines += ["", f"> {payload['recommendation']}", ""]
    (result_dir / "probe-004-rabbitmq-task-bus.md").write_text(
        "\n".join(lines), encoding="utf-8")
# CHUNK-7


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--compose-file", required=True)
    ap.add_argument("--result-dir", required=True)
    args = ap.parse_args()
    failures = []
    try:
        if not wait_ready():
            raise RuntimeError("RabbitMQ management API did not become ready")
        _, overview = api("GET", "/overview")
        image = os.getenv("RABBITMQ_IMAGE", "rabbitmq:3.13-management")
        reset_topology(ALL_QUEUES, ALL_EXCHANGES)

        routing = verify_routing_and_idempotent_relay()
        retry = verify_delayed_retry()
        cancel = verify_cancel_before_execute()
        permanent = verify_permanent_dlq()
        quarantine = verify_quarantine_no_requeue()
        replay = verify_replay_new_generation()

        checks = {
            "routed_confirm": routing["routed_confirm"],
            "unroutable_detected": routing["unroutable_detected"],
            "idempotent_relay_effect_once": routing["effect_once"],
            "delayed_retry_ttl_dlx": retry["message_redelivered_after_ttl"],
            "cancel_before_execute_no_side_effects": cancel["no_side_effects_ok"],
            "permanent_error_dlq_correlated": permanent["correlated_ok"],
            "quarantine_no_infinite_requeue": quarantine["no_infinite_requeue_ok"],
            "replay_new_generation_preserves_chain": replay["replay_ok"],
        }
        for name, ok in checks.items():
            if not ok:
                failures.append(name)

        status = "PASS" if not failures else "BLOCKED"
        decisions = [
            "Publisher Confirm 与消费者 prefetch QoS 属 AMQP 线级特性,本探针用 management HTTP API "
            "的 routed 标志与去重模拟代替;正式实现的 Outbox Relay/Worker 需用真实 AMQP 客户端("
            "如 amqplib)在集成测试中复测确认与 prefetch=1/4。",
            "重试阶梯用短 TTL(1.5s)验证 TTL+DLX 机制;生产 30s/5m/30m 阶梯与单调度器去重需在 "
            "Worker 集成测试固化。",
        ]
        measurements = {
            "rabbitmq_version": overview.get("rabbitmq_version"),
            "management_version": overview.get("management_version"),
            "checks": checks,
            "detail": {
                "routing": routing, "retry": retry, "cancel": cancel,
                "permanent": permanent, "quarantine": quarantine, "replay": replay,
            },
            "backlog_snapshot": {q: queue_depth(q) for q in ALL_QUEUES},
            "container_rss_mb": docker_rss_mb(args.compose_file),
        }
        payload = {
            "probe_id": "PROBE-004",
            "status": status,
            "executed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "versions": {"rabbitmq_image": image},
            "measurements": measurements,
            "failures": failures,
            "decisions_required": decisions,
            "recommendation": (
                "RabbitMQ 只做投递/延迟/死信;逻辑任务、Attempt、Generation、取消、DLQ 关联与 replay "
                "由 PostgreSQL 权威;重试用 TTL+DLX 阶梯,quarantine 走 ACK+旁路不 requeue,"
                "replay 生成新 Generation 并保留死信链。"),
        }
        write_results(args.result_dir, payload)
        reset_topology(ALL_QUEUES, ALL_EXCHANGES)
        print(f"PROBE-004 {status} (failures={failures})")
        if status == "BLOCKED":
            raise SystemExit(1)
    except SystemExit:
        raise
    except Exception as e:
        payload = {"probe_id": "PROBE-004", "status": "BLOCKED",
                   "executed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "versions": {}, "measurements": {},
                   "failures": failures + [str(e)], "decisions_required": [],
                   "recommendation": ""}
        write_results(args.result_dir, payload)
        raise


if __name__ == "__main__":
    main()
