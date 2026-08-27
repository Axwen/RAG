# PROBE-004 RabbitMQ 任务总线

- status: `PASS`
- RabbitMQ image: `rabbitmq:3.13-management`
- 交互方式: management HTTP API(broker 原语实测) + PG 协议应用层模拟

## 校验(broker 实测 = live,PG 协议 = sim)
- routed_confirm: `True`
- unroutable_detected: `True`
- idempotent_relay_effect_once: `True`
- delayed_retry_ttl_dlx: `True`
- cancel_before_execute_no_side_effects: `True`
- permanent_error_dlq_correlated: `True`
- quarantine_no_infinite_requeue: `True`
- replay_new_generation_preserves_chain: `True`

## 指标
- routed 确认: `True` / 不可路由检出: `True`
- 幂等去重丢弃: `1` 条(effect-once)
- 生产重试阶梯: `['30s', '5m', '30m']`(探针用 1500ms 验证 TTL+DLX 机制)
- DLQ x-death 关联: `rejected` @ `perm.q`
- 冻结 prefetch: 解析 `1` / 投影 `4`(见 PROJECT_STATE 硬边界,本探针不在 HTTP 路径复测)
- container RSS: `163.0` MB

## 待决策
- Publisher Confirm 与消费者 prefetch QoS 属 AMQP 线级特性,本探针用 management HTTP API 的 routed 标志与去重模拟代替;正式实现的 Outbox Relay/Worker 需用真实 AMQP 客户端(如 amqplib)在集成测试中复测确认与 prefetch=1/4。
- 重试阶梯用短 TTL(1.5s)验证 TTL+DLX 机制;生产 30s/5m/30m 阶梯与单调度器去重需在 Worker 集成测试固化。

> RabbitMQ 只做投递/延迟/死信;逻辑任务、Attempt、Generation、取消、DLQ 关联与 replay 由 PostgreSQL 权威;重试用 TTL+DLX 阶梯,quarantine 走 ACK+旁路不 requeue,replay 生成新 Generation 并保留死信链。
