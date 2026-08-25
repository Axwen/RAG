---
status: accepted
supersedes-queue-choice-in: 0019-event-driven-index-projections.md
---

# 使用 RabbitMQ 作为异步任务总线

MVP 使用 RabbitMQ 作为文档解析、分块、Embedding、关键词/向量投影、索引发布校验、资源清理和评测任务的唯一异步消息总线。Redis 继续负责缓存、限流、短期会话、quick_parse TTL 和分布式协调，不承载应用异步任务队列。

该选择与本地 PDF 中的异步流水线方向一致，也适合 Node.js 与 Python Worker 的跨语言消费。ragent 固定快照使用 RocketMQ，RAGFlow 固定快照采用可替换消息队列且当前默认 NATS；本项目吸收它们的异步化、幂等和解耦原则，不复制其具体 Broker 或内部实现。

PostgreSQL Outbox 是待投递事实源，RabbitMQ 不是业务状态数据库。Outbox Relay 使用 durable topic exchange、persistent message、mandatory routing 和 Publisher Confirm；消费者使用 manual ACK。临时错误通过 RabbitMQ 原生 TTL + DLX 重试队列分级重试，永久错误或超过重试上限后进入死信交换机，并同步记录 PostgreSQL `dead_letter`。所有有副作用的消费者按业务幂等键执行，支持对账和人工重放，不宣称 exactly-once。

消息只传标识和版本，不传正文或文件二进制。消息契约至少包含 `eventId`、`eventType`、`schemaVersion`、`occurredAt`、`tenantId`、`traceId`，以及任务所需的 `documentVersionId`、`indexReleaseId`、`projectionType` 和 `contentHash`。业务模块依赖 `MessageBus` 契约，不直接依赖 RabbitMQ SDK DTO。

本地开发使用单节点 durable classic queue 以控制资源；真实试点使用三节点 RabbitMQ 和 quorum queue。未来只有在超长事件保留、大规模事件回放、跨团队流式订阅或 RabbitMQ 吞吐/路由模型成为瓶颈时，才评估 NATS JetStream 或 Kafka。
