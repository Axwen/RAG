# Architecture Decision Records

本目录记录已编号的架构决策。`accepted` ADR 是当前可执行的架构事实；`superseded` ADR 保留历史理由，不应作为新实现依据。数值或事实勘误可在 ADR 内用 `revised` 与修订依据记录，语义反转必须新增 ADR 并在旧 ADR 中链接替代项。

| ADR | 状态 | 标题 | 替代关系 |
|---|---|---|---|
| [0001](0001-typescript-control-plane-python-model-runtime.md) | accepted | TypeScript 控制面与 Python 解析/模型运行时 | - |
| [0002](0002-shared-core-role-workspaces.md) | accepted | 共享基座与角色工作台 | - |
| [0003](0003-authoritative-knowledge-precedence.md) | accepted | 正式产品知识优先于话术和工单经验 | - |
| [0004](0004-reviewed-ticket-knowledge.md) | accepted | 原始工单与工单知识分离 | - |
| [0005](0005-model-routing-by-data-classification.md) | superseded | 按数据等级路由模型执行区 | 被 [0025](0025-data-class-routing-enforcement-point.md) 替代 |
| [0006](0006-keycloak-oidc-identity.md) | accepted | 使用 Keycloak 作为首期身份提供方 | - |
| [0007](0007-webhook-plus-incremental-ticket-sync.md) | accepted | Webhook 通知与增量拉取共同同步工单 | - |
| [0008](0008-private-kubernetes-pilot.md) | accepted | 开发使用 Compose，试点使用私有 Kubernetes | - |
| [0009](0009-flow-first-synthetic-data-mvp.md) | accepted | 先用合成数据和云端小模型跑通流程 | - |
| [0010](0010-nextjs-nestjs-typescript-apps.md) | accepted | 使用 Next.js 前端与 NestJS 控制面 | - |
| [0011](0011-shared-knowledge-assets.md) | accepted | 文档版本作为跨工作台共享知识资产 | - |
| [0012](0012-full-compose-middleware-for-mvp.md) | superseded | MVP 使用完整目标中间件链路 | 被 [0015](0015-aliyun-oss-and-resource-aware-compose.md) 替代 |
| [0013](0013-prisma-for-postgresql.md) | accepted | 使用 Prisma 管理 PostgreSQL | - |
| [0014](0014-parser-service-around-ragflow-deepdoc.md) | accepted | 用独立 Parser Service 包装 RAGFlow DeepDOC | - |
| [0015](0015-aliyun-oss-and-resource-aware-compose.md) | superseded | 使用阿里云 OSS 和资源分级 Compose | 被 [0016](0016-local-minio-for-development.md) 替代 |
| [0016](0016-local-minio-for-development.md) | accepted | MVP 默认使用本地 MinIO，阿里云 OSS 延后 | - |
| [0017](0017-mvp-cloud-model-and-budget.md) | accepted | MVP 云模型供应商基线与受控模型预算 | 2026-08-26 按 PROBE-005 原地修订 |
| [0018](0018-mvp-seed-and-release-gates.md) | accepted | MVP 使用虚拟客服工单 SaaS 和分层验收门禁 | - |
| [0019](0019-event-driven-index-projections.md) | accepted | 通过事件驱动候选索引投影与发布 | - |
| [0020](0020-document-review-state-machine.md) | accepted | 文档采用四态审核状态机 | - |
| [0021](0021-multi-format-parser-artifact.md) | accepted | 多格式解析统一产出可定位解析产物 | - |
| [0022](0022-optional-graph-evidence-channel.md) | accepted | Neo4j 作为可选图谱证据通道 | - |
| [0023](0023-orthogonal-runtime-state-machines.md) | accepted | 使用正交状态机而不是单一文档状态 | - |
| [0024](0024-rabbitmq-asynchronous-task-bus.md) | accepted | 使用 RabbitMQ 作为异步任务总线 | - |
| [0025](0025-data-class-routing-enforcement-point.md) | accepted | 数据分级路由的强制执行点在 ModelAdapter，而不是独立模型网关 | 替代 0005 |
| [0026](0026-acl-scope-key-and-authoritative-recheck.md) | accepted | ACL 只在 PostgreSQL 判定，索引只携带稳定作用域键 | 由 [0037](0037-stage1-index-field-alignment.md) 细化字段口径 |
| [0027](0027-tiered-citation-verification-budget.md) | accepted | 引用验证分层预算：常规走 token 与向量，蕴含校验只用于高风险 | 2026-08-26 按 PROBE-005 原地修订 |
| [0028](0028-embedding-version-partition-and-rebuild.md) | accepted | IndexPartition 唯一键加入 embeddingVersion，并交付显式索引重建协议 | - |
| [0029](0029-model-budget-ledger-and-limits.md) | accepted | 模型预算使用 PostgreSQL Ledger 预扣、结算与 Lease 回收 | - |
| [0030](0030-answer-body-storage-tiers.md) | accepted | 回答正文与证据摘录不落 PostgreSQL：元数据在 PG、续读窗在 Redis、快照在对象存储 | - |
| [0031](0031-chunking-frozen-after-probe.md) | accepted | 分块策略经 PROBE-006 实测后冻结，不在探针前写死参数 | 2026-08-26 按 PROBE-006 原地修订 |
| [0032](0032-untrusted-content-and-prompt-injection.md) | accepted | 不可信文档内容与 Prompt Injection 的处理协议 | - |
| [0033](0033-deterministic-evidence-conflict-resolution.md) | accepted | 跨知识空间证据冲突按全序键确定性消解，不交由模型自由裁决 | - |
| [0034](0034-per-user-rate-limit-and-concurrency-quota.md) | accepted | 用户级限流与并发配额是阶段 1 必交付项，默认值待实测校准 | - |
| [0035](0035-stage1-runtime-protocol-ratification.md) | accepted | 阶段 1 运行期硬协议从工程评审记录提升为 ADR 级事实 | 2026-08-26 按 PROBE-005 原地修订 |
| [0036](0036-stage1-protocol-clarifications.md) | accepted | 阶段 1 协议语义收敛：显式授权、临时引用、模型调用、兼容组合与结果门禁 | - |
| [0037](0037-stage1-index-field-alignment.md) | accepted | 阶段 1 OpenSearch 索引字段与 ACL 作用域口径对齐 | 细化 0026、0028 |
| [0038](0038-vlm-parser-backend-and-multimodal-scope.md) | accepted | 阶段 1 多模态解析范围重定：DeepDOC OCR 与 Office 库提取，VLM 后置 | - |
| [0039](0039-business-identity-and-unified-authorization.md) | accepted | 业务身份体系与统一授权入口：外部身份与业务用户分离，能力权限与资源策略分层 | 细化 0002、0026；不改 0036、0037 |
