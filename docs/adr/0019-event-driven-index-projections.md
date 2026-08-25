---
status: accepted
---

# 通过事件驱动候选索引投影与发布

文档创建、内容更新、重建、发布、废止和权限变更不直接在 HTTP 请求内同步完成所有解析与索引写入，而是通过事务内 Outbox 事件驱动异步处理。一个文档版本可以并行产生关键词投影、向量投影和未来的图谱投影；每个投影拥有独立任务状态、幂等键、重试次数和错误信息。

MVP 使用 RabbitMQ 作为唯一异步任务总线，Redis 只承担缓存、限流、短期状态和分布式协调。队列消息必须携带 `eventId`、`documentVersionId`、`indexReleaseId`、`projectionType`、`contentHash`、`schemaVersion` 和 `traceId`，不携带正文或文件二进制。消费者按 `documentVersionId + projectionType + contentHash + version` 幂等处理。

PostgreSQL Outbox 是待投递事实源；Outbox Relay 使用 durable topic exchange、persistent message、mandatory routing 和 Publisher Confirm，确认后才把事件标记为已发布。消费者使用 manual ACK，临时失败通过原生 TTL + DLX 队列分级重试，永久失败或超过次数后进入死信交换机和 PostgreSQL `dead_letter`。RabbitMQ 提供至少一次投递，不承诺 exactly-once；索引、对象存储和任务状态等副作用必须能够按幂等键对账和重放。

发布状态与处理状态分离，但不采用“发布后才第一次建索引”的空窗模型。新版本在 Draft/PendingReview 阶段构建候选投影并完成质量校验；审核通过时只允许激活 `READY` 的 `index_release`，再原子切换检索 Alias。新版本激活前旧版本继续服务，激活后 smoke check 失败则回滚上一 Release。可选图谱投影失败不得阻断普通 BM25/向量检索，但必须在 Trace 和运营台中可见。
