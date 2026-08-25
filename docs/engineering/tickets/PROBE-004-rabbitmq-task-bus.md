# PROBE-004：RabbitMQ 任务、重试、取消与 DLQ 探针

## 目的

验证 RabbitMQ 作为唯一异步任务总线时，Outbox/Attempt/Generation、Publisher Confirm、manual ACK、TTL + DLX 重试、取消、迟到消息、未知 Schema、DLQ 和人工重放协议成立。

## 当前依据

- [ADR-0024](../../adr/0024-rabbitmq-asynchronous-task-bus.md)
- 工程评审闭合记录第 6 节和 F-01 至 F-04、F-17、F-20

## 输入与边界

- RabbitMQ 单节点 durable classic queue。
- `rag.tasks.topic`、30s/5m/30m retry queue、DLX 和 PostgreSQL 模拟 Outbox/Attempt/DeadLetter 表。
- 消息只传 ID、版本、哈希和 deadline，不传正文或文件。

## 必须验证

1. Publisher Confirm 丢失时，Outbox Relay 可重发且消费者幂等。
2. 临时错误只创建新 Attempt 并进入对应 retry queue，不由 Broker 和应用重复调度。
3. 旧 Generation、取消状态和过期 deadline 在执行前被识别并 ACK，不产生副作用。
4. 永久错误进入 PostgreSQL dead_letter 和 Broker DLQ，二者可关联。
5. 未知 schemaVersion 进入隔离路径，不无限 requeue。
6. 人工重放创建新 Generation，原 Dead Letter 保留完整链路。
7. 记录 confirm、ACK、延迟、prefetch、队列积压、重复率和重放结果。

## 产出

- `probe-004-rabbitmq-task-bus.md`
- `probe-004-rabbitmq-task-bus.json`
- Exchange/Queue/DLX 声明脚本和故障注入脚本。
- 重试、取消、迟到和重放的消息轨迹。

## 通过标准

- `PASS`：不丢任务、不无限 requeue，人工重放可追踪。
- `PASS_WITH_ADJUSTMENT`：需要调整 TTL、prefetch、队列类型或 Attempt 上限，并同步 ADR/配置。
- `BLOCKED`：无法建立单一重试所有者、幂等或 DLQ 重放边界。

## 测试与回滚

- 使用 RabbitMQ Testcontainers/Compose 和 PostgreSQL 集成脚本。
- 探针失败删除 exchange、queue、测试表和容器卷即可回滚。

