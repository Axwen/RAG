---
status: accepted
---

# 阶段 1 协议语义收敛：显式授权、临时引用、模型调用、兼容组合与结果门禁

本 ADR 收敛设计复审后仍存在的跨文档语义差异。它不更换阶段 1 的技术路线，只把容易在实现时产生不同解释的边界固定下来。

## 1. ACL 作用域过滤与显式文档授权（阶段 1 仅预留设计，不实现）

`acl_scope_key` 是阶段 1 唯一的授权来源：主体被授予知识空间、数据等级或可见性作用域，查询时编译为 `acl_scope_key` 集合作为 OpenSearch 预过滤，候选合并后再由一次批量 PostgreSQL 权威复核校验文档级拒绝例外、删除墓碑、Legal Hold 和文档有效期（见 [ADR-0026](0026-acl-scope-key-and-authoritative-recheck.md)）。

**逐文档正向授权（把某个 `document_version_id` 直接授予作用域之外的主体）在阶段 1 不实现。** 客服知识库以团队/空间共享为主，逐文档共享概率低；为一个当前用不上的能力建授权表、撤销、有效期、`aclRevision` 缓存失效和租户上限拒绝逻辑，只会凭空增加一条必须保证不越权的 P0 安全攻击面。

但它是已识别的扩展点，且有一条不可回避的架构约束必须现在就守住：

- **拒绝是减法，授权是加法。** 文档级拒绝例外可以留在第二段复核里；逐文档正向授权只能进第一段预过滤——不匹配作用域键的文档根本不会成为候选，复核阶段看不到它，因此正向授权无法作为复核层的事后补丁。
- 因此预过滤的查询编译必须保留"可追加一个加法子句"的形状，将来扩充为：

  ```text
  (acl_scope_key IN allowedScopeKeys)
  OR (document_version_id IN explicitGrantedDocumentVersionIds)
  ```

- 未来真正实现时须一并补：显式授权集合的租户级上限（超限返回可解释的 `authorization_scope_too_large`，不静默截断），显式授权有效期纳入权威复核，显式授权集合摘要纳入带 `aclRevision` 的 Redis 缓存，且不改变"候选最多 1024"的检索预算。

阶段 1 只需保证预过滤设计不把自己写死成"只能按作用域键过滤"，研发/员工工作台需要时可直接追加该加法子句而不重构授权链路。

## 2. quick_parse 的临时引用

quick_parse 可以产生引用，但引用必须带 `citationScope`：

```text
PERSISTENT  正式 Release 中的长期知识引用
TEMPORARY   quick_parse 会话内的临时资料引用
```

`TEMPORARY` 引用在 Quick Parse 为 `READY`、对象仍在保留期内且当前 ACL 通过时可以点击回原文；它不得进入正式 Release，也不得在 TTL 清理后继续展示正文。清理、主动删除或 Legal Hold 以外的到期动作发生后，引用状态转为 `EXPIRED` 或墓碑，只保留哈希、版本、位置和审计元数据。

因此，“quick_parse 不作为引用来源”改为“quick_parse 不作为长期正式知识来源”。它可以支撑会话级证据回答，但不能被当作正式知识库发布结果或长期可复现证据。

## 3. ModelAdapter 调用上下文

所有 Chat、Embedding、Reranker 和引用验证模型调用都必须携带服务端生成的调用上下文。业务模块不得从前端直接传入或覆盖数据等级、执行区、模型和预算字段。

```ts
type ModelCallContext = {
  tenantId: string;
  purpose: "chat" | "embedding" | "rerank" | "citation_verification";
  dataClass: "UNKNOWN" | "PUBLIC" | "INTERNAL" | "CONTROLLED" | "SENSITIVE";
  executionZone: "CLOUD" | "LOCAL";
  modelRef: string;
  budgetReservationId: string;
  traceparent: string;
  signal: AbortSignal;
};
```

准入顺序固定为：解析输入与证据等级继承 → 数据分级/执行区校验 → PostgreSQL 预算预扣 → 供应商调用 → 用量结算或 lease 回收 → 审计与异步遥测。`UNKNOWN` 或敏感数据进入云执行区一律阻断，不能通过切换 Chat、Embedding、Reranker 或引用验证供应商绕过。

敏感或未知数据阶段 1 不调用云 Embedding；允许保留受控 PostgreSQL/BM25 路径，但不得生成云向量。该行为与 Chat、Reranker、引用验证的阻断规则一致，并在 ModelAdapter 契约测试中分别验证四类调用。

## 4. PipelineManifest 与 Release 的关系

`ReleaseManifest` 只表达一个知识空间和索引分区的入库事实，字段只引用 `ingestionManifestId`，不反向持有 `pipelineManifestId`。`PipelineManifest` 是批准后的兼容组合，不是 Release 的父对象，也不是运行时必须整体激活的版本。

`RetrievalSnapshot` 在创建时记录：

- 一个或多个 `releaseRefs`；
- 本次共同使用的 `retrievalManifestId` 与 `answerManifestId`；
- 用于证明每个 Release 与本次检索/回答策略兼容的 `approvedPipelineManifestIds[]`；
- 兼容矩阵校验哈希和结果。

每个 Release 必须能通过自身 `ingestionManifestId` 找到已批准的兼容组合；跨空间查询不要求所有 Release 使用相同的 IngestionManifest，但必须共享并通过同一组 Retrieval/Answer 兼容校验。不存在兼容组合时，整个 Snapshot 拒绝创建，不部分回答。

## 5. EvidenceSnapshot 与 AnswerSnapshot 的对象归属

两类对象职责不同，均必须进入删除矩阵：

- `RetrievalSnapshot.evidenceSnapshotUri` 指向检索证据快照，保存候选 ID、排序、位置、引用绑定和必要的受控摘录；它不是最终回答正文。
- AnswerRun 最终快照保存最终回答正文、逐句引用状态和对证据快照的引用；它是回答正文的唯一长期副本。

二者使用不同的对象键和不同的 `deletion_target` 类型。删除请求必须同时清理证据快照和回答快照；任一目标未完成时，旧引用和回答都保持 `fail closed`。过期后两类对象都只能保留哈希、版本、指标和墓碑。

## 6. CONFLICT 是 AnswerFinalizer 的硬门禁

如果某个事实句绑定的证据存在未解决的 `CONFLICT`，`AnswerFinalizer` 不得提交 `ANSWERED`。允许的结果只有：

- `PARTIAL`：保留无冲突事实句，冲突事实句不作单一结论，并同时展示冲突来源；
- `EVIDENCE_ONLY`：只展示证据和冲突说明；
- `REFUSED`：无法安全形成回答时拒答。

模型不得在生成阶段替冲突证据做隐式裁决。`CONFLICT`、冲突来源和 Finalizer 选择的最终结果都写入 `RetrievalSnapshot`、AnswerRun 事件和审计记录。

## 7. 用户级配额的 Redis 故障降级

提问频次、每日次数和上传频次计数器仍由 Redis 承担，Redis 不可用时可以告警后放行，但必须受 PostgreSQL 租户预算硬闸门保护。

并发 `AnswerRun` 和 SSE 不得完全依赖 Redis：

- API 进程始终启用本地 semaphore，限制当前进程的并发和连接数；
- `AnswerRun` 创建事务获取 PostgreSQL 用户并发 lease，租约过期可回收；
- Redis 可用时用于跨进程快速拒绝和展示，Redis 故障不能关闭本地 semaphore 或 PostgreSQL lease。

超限仍只能排队或返回 `429`，不得跳过引用验证、缩小候选集或改变数据分级路由。

## 8. T1 与 PROBE-006 的依赖拆分

T1 拆为两个可独立验收的部分：

- `T1a Manifest/Prisma Core`：租户、知识空间、文档版本、基础 Manifest、Release、兼容矩阵和状态引用，不编码父子 Chunk 关系和最终 Chunk 字段。
- `T1b Chunk/Index Schema`：`chunk_manifest`、Chunk 定位和 OpenSearch mapping，依赖 PROBE-006 冻结 `ChunkingManifest`；PROBE-006 已冻结阶段 1 `parent_child=false`，因此不建立父子字段或父子展开路径。

PROBE-006 `BLOCKED` 时禁止 T1b、T5、T6 进入正式索引实现；T1a 的契约和迁移准备不再被错误地描述为完全阻塞。生产检索主链仍必须等待全部探针通过并完成 Probe Decision Gate。
