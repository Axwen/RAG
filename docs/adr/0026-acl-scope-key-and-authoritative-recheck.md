---
status: accepted
revised: 2026-08-27
revision-basis: ADR-0037 对齐 PROBE-003 实测 mapping
---

# ACL 只在 PostgreSQL 判定，索引只携带稳定作用域键

原设计把授权主体去规范化进 OpenSearch 文档（`acl_subject_ids` 与 `acl_revision`），同时要求 Release 不可变、历史 Release 不原地改写，并要求实时撤权优先于历史可复现。三者不能同时成立：成员变更要么强迫原地改写不可变 Release，要么强迫为一次权限变更重建整条候选投影，要么让受影响知识在重投影完成前大面积不可检索。本 ADR 取消这个冲突的来源。

索引文档不再携带授权主体和 ACL 版本。阶段 1 的真实 mapping 只保存稳定过滤键和投影身份：`tenant_id`、`knowledge_space_id`、`index_partition_id`、`release_id`、`acl_scope_key`、`embedding_version`、有效期与删除墓碑；`data_class` 由 `IndexPartition` 身份承载，`visibility_class` 不单独落为索引字段。需要参与作用域判定的等级和可见性由 PostgreSQL 编译后统一编码进 `acl_scope_key`。字段明细与演进规则见 [ADR-0037](0037-stage1-index-field-alignment.md)。文档分级或所属知识空间变化仍产生新文档版本或新投影，属于正常的 Release 构建路径。

查询链路分两段执行授权。第一段是作用域前置过滤：API 在查询前用 PostgreSQL 把当前主体解析为允许的 `acl_scope_key` 集合与当前 `aclRevision`，编译进 BM25 与向量查询的 filter：`acl_scope_key IN allowedScopeKeys`。第二段是候选权威复核：召回结果合并后、融合与 Rerank 之前，用一次批量 PostgreSQL 查询对候选的 `document_version_id` 集合复核文档级拒绝例外、删除墓碑、Legal Hold 和有效期，未通过的候选直接丢弃且不进入证据、引用和 Trace 摘要。禁止逐候选查询 PostgreSQL。

注意授权的两个方向不对称：**文档级拒绝例外是减法，放在第二段复核里即可**（复核只能从候选集里剔除）；而**逐文档正向授权是加法，只能放在第一段预过滤里**——不匹配作用域键的文档根本不会成为候选，复核阶段永远看不到它，因此正向授权无法作为复核层的事后补丁。阶段 1 的授权模型是纯作用域型，不实现逐文档正向授权；其作为已识别的扩展点由 [ADR-0036](0036-stage1-protocol-clarifications.md) 记录，预过滤的编译必须保留"可追加一个 `OR document_version_id IN (...)` 加法子句"的形状，以便未来研发/员工工作台需要时扩充而不重构授权链路。

Redis 只允许缓存"主体 → 允许作用域集合"这一层，缓存键必须包含 `aclRevision`；撤权或成员变更时递增 `aclRevision` 使缓存立即失效，不依赖 TTL 过期。Redis 不缓存最终授权结论，也不缓存候选复核结果。PostgreSQL 不可用或复核超时时整个查询 fail closed，返回 evidence unavailable，不允许以"跳过复核"的方式放行候选。

`RetrievalSnapshot` 记录查询时的 `aclRevision`、作用域摘要哈希以及复核前后的候选数量，使"某次回答用的是哪一版授权事实、丢弃了多少候选"可审计。历史快照不授予任何权限：引用展开、预览和下载仍按当前 ACL 重新鉴权。

代价是检索链路多一次批量 PostgreSQL 往返，性能预算新增"ACL 候选复核 P95 ≤ 60 ms"一项，并计入 250 ms 的检索段预算之外。换来的性质是：权限变更只写 PostgreSQL，索引零重写，撤权在下一次查询即生效，而 Release 保持真正不可变。
