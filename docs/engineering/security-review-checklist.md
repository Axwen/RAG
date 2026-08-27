# 安全评审专用清单（可信 RAG 阶段 1）

> 用途：每次评审授权、不可信内容/注入、冲突消解、删除与预算相关代码时，用固定口径检查，避免通用 review 漏掉本项目的 P0 门禁。
>
> 适用阶段：**实现阶段（T1a–T16）专用**。当前处于探针收口与实现准备阶段，尚无业务代码；开始出现实现 diff 后启用本清单，并按 [Probe Decision Gate](probe-decision-gate.md) 的集成门槛验收。
>
> 事实源：[ADR-0026](../adr/0026-acl-scope-key-and-authoritative-recheck.md)、[ADR-0032](../adr/0032-untrusted-content-and-prompt-injection.md)、[ADR-0033](../adr/0033-deterministic-evidence-conflict-resolution.md)，Failure Modes Registry 见[工程评审闭合记录](plan-eng-review-closure.md) F-01~F-30。冲突时以 ADR 和 [PROJECT_STATE.md](../../PROJECT_STATE.md) 为准。
>
> 字段口径已由 [ADR-0037](../adr/0037-stage1-index-field-alignment.md) 对齐：阶段 1 索引不单独保存 `data_class`/`visibility_class`，`data_class` 由 `index_partition_id` 承载，作用域语义统一进入 `acl_scope_key`。
>
> 最近更新：2026-08-27

## 使用方式

- 触发这些主题的 PR/diff 时运行 `/security-review`，并把本文件作为口径附带。
- 每条检查项后标注对应 Failure Mode 编号与优先级；**P0 项为硬门禁，任一不满足即阻断合并**。
- 判定只有两种结果：`满足`（给出证据：代码位置/测试）或 `阻断`（给出违反的 F 编号与红旗现象）。不允许“看起来没问题”。

## P0 硬门禁总表（必须为 0 违反）

| F | 一句话 | 反例（红旗） |
|---|---|---|
| F-08 | 召回期间撤权，仍展示过期证据 | 复核只在预过滤做，合并后不再查 PG |
| F-11 | 高风险验证未过但正文已流出 | 验证前就 flush 事实正文到 SSE |
| F-12 | 删除只清 PG，OS/MinIO 留副本 | 删除标 PG 完成即返回，未逐 Target 证明 |
| F-13 | 旧 DLQ 重放复活已删数据 | 重放不校验删除墓碑/Generation |
| F-15 | 敏感/UNKNOWN 数据外发云模型 | 数据等级门禁在调用点而非 ModelAdapter |
| F-18 | Keycloak 不可用/撤权延迟仍放行 | OIDC 失败时 fail open |
| F-20 | 删除中的 Release 被激活/回滚/重放 | 激活路径不前置校验墓碑/Legal Hold |
| F-21 | 未验证正文被提交为最终快照 | Finalizer 接受非 VERIFIED 结果为 ANSWERED |
| F-25 | 权限收紧后旧 Release 仍按快照 ACL 返回 | 索引里存了 ACL 主体/版本号 |
| F-27 | 文档内注入指令改变系统行为/诱导外发 | 文档内容拼进系统指令、跟随文档内 URL |

## 1. 授权与 fail-closed（ADR-0026 · F-08/F-18/F-20/F-25）

两段授权：PostgreSQL 编译 `acl_scope_key` 集合做预过滤 → 候选合并后再做一次批量 PG 权威复核。

- [ ] **索引不含主体信息**（F-25/P0）：OpenSearch mapping 按 [ADR-0037](../adr/0037-stage1-index-field-alignment.md) 保留 `tenant_id`/`knowledge_space_id`/`index_partition_id`/`release_id`/`acl_scope_key` 等稳定字段；**没有** `acl_subject_ids`、`acl_revision` 或任何主体列表。红旗：把成员/角色去规范化进索引文档。
- [ ] **预过滤是主体解析出的作用域集合**：BM25 与向量查询都带 `acl_scope_key IN allowedScopeKeys` filter，两条路径口径一致。红旗：只在其中一条路径加过滤。
- [ ] **合并后必做批量权威复核**（F-08/P0）：候选合并、融合/Rerank 之前，用**一次批量** PG 查询复核 `document_version_id` 集合的文档级拒绝例外、删除墓碑、Legal Hold、有效期。红旗：逐候选查 PG，或复核只在预过滤阶段。
- [ ] **复核失败 fail closed**（F-18/P0）：PG 不可用或复核超时（P95 预算 60 ms，不计入 250 ms 检索段）→ 整个查询返回 evidence unavailable，**不得**以“跳过复核”放行任何候选。红旗：`catch` 里降级为返回候选。
- [ ] **正向授权只进预过滤**：逐文档正向授权是加法，只能作为预过滤的 `OR document_version_id IN (...)` 子句；阶段 1 不实现，但编译形状要保留可追加。红旗：把正向授权当作复核层事后补丁（复核只能剔除，加不回来）。
- [ ] **Redis 只缓存“主体→作用域集合”**：缓存键含 `aclRevision`，撤权时递增使其立即失效，不靠 TTL。**不缓存**最终授权结论或候选复核结果。
- [ ] **历史快照不授权**：引用展开、预览、下载按**当前** ACL 重新鉴权；`RetrievalSnapshot` 只记录 `aclRevision`/作用域摘要哈希/复核前后候选数，用于审计。
- [ ] **删除/激活优先级**（F-20/P0）：Release 激活、回滚、DLQ 重放前，墓碑/Legal Hold/作用域校验前置于操作本身；命中则返回阻断原因，旧正文不可复活。

## 2. 不可信内容与注入（ADR-0032 · F-27/F-15）

原则：文档内容永远是数据，不是指令。

- [ ] **结构化注入 + 定界符**（F-27/P0）：检索内容以带来源标识的块、固定定界符包裹注入；系统指令/工具定义/权限上下文永远排在资料**之前**。红旗：把文档文本直接字符串拼进 system prompt。
- [ ] **三处检测都在**：①解析入库静态扫描 `ParseArtifact`；②候选进入生成上下文**之前**的运行时检查（覆盖 quick_parse 临时内容）；③回答产出后的输出检查。红旗：只在入库扫一次。
- [ ] **命中处置确定**：`suspected` 候选不进生成上下文、只作证据展示、回答走 `EVIDENCE_ONLY`；Top5 全命中 → `REFUSED`；`blocked` 既不进上下文也不进证据展示；高密度命中整篇 `QUARANTINED` 阻断发布。
- [ ] **绝不因文档内容扩权**（F-27/P0）：任何情况下不跟随文档内 URL、不执行文档内代码、不因文档内容扩大工具白名单或权限。红旗：出现基于检索内容的动态工具启用/外链请求。
- [ ] **数据等级门禁在 ModelAdapter 层**（F-15/P0）：`UNKNOWN`/敏感等级默认阻断外发，门禁强制在 `ModelAdapter` 而非各调用点。红旗：某个调用点自行判断能不能发。
- [ ] **每次命中写领域审计**：含文档版本、Chunk、命中模式、处置结果。

## 3. 冲突消解与 Finalizer 门禁（ADR-0033 · F-09/F-21/F-28/F-11）

- [ ] **确定性全序键**（F-28/P1）：跨空间证据合并后按全序键排序——权威级别(`OFFICIAL`>`STANDARD_SCRIPT`>`TICKET_DERIVED`) → 范围精确匹配数 → `valid_from` 新鲜度 → 文档版本创建时间 → `documentVersionId` 字典序兜底。红旗：排序依赖空间遍历顺序，或用内容推断权威级别。
- [ ] **CONFLICT 触发与展示**：同一句证据中前两项（权威级别+范围匹配度）完全相同却结论不相容 → 状态 `CONFLICT`，界面同时展示两条来源，不给单一结论。红旗：按后续键静默择一。
- [ ] **模型不裁决冲突**：裁决只发生在显式字段上，不让模型自由选择。
- [ ] **过期证据不进上下文**：`valid_to` 过期 → 只作 `EXPIRED` 提示条目展示，不进生成上下文。
- [ ] **Finalizer 硬门禁**（F-21/P0）：含未解决 `CONFLICT` 句的运行**不得**提交为 `ANSWERED`，只能 `PARTIAL`/`EVIDENCE_ONLY`/`REFUSED`；只接受 VERIFIED 或允许的 PARTIAL 结果。红旗：Finalizer 直接把候选答案落为最终快照。
- [ ] **高风险验证前不流出正文**（F-11/P0）：高风险路径验证通过前只缓冲（≤2048 output tokens），不 flush 事实正文；验证失败只显示证据/拒答。
- [ ] **可复现审计**：Finalizer 选择、冲突来源、最终状态写入 `RetrievalSnapshot`、AnswerRun 事件、领域审计；同一输入在固定 `RetrievalSnapshot` 上重复运行得到相同候选顺序与引用状态。

## 4. 删除、墓碑与孤儿（F-12/F-13/F-19/F-20 · 横切）

- [ ] **逐 Target 删除证明**（F-12/P0）：删除必须对 PG/OpenSearch/MinIO 每个 Target 逐项证明完成，未完成保持阻断，删除中不可检索。红旗：清完 PG 就返回成功。
- [ ] **重放校验墓碑**（F-13/P0）：DLQ 重放、Generation 迟到执行前校验删除墓碑/CAS，不复活已删正文。
- [ ] **孤儿补偿**（F-19/P1）：临时对象 `object_claim` + TTL 清扫；promote 成功但 PG 失败要能追踪清理，不产生可检索孤儿资产。

## 5. 预算与用户级配额（F-24/F-26/F-29/F-30 · 横切）

- [ ] **预算硬门禁在 PG 账本**（F-24/P1）：`model_budget_ledger` 调用前预扣带 lease，超单次/日/月上限即停止或降级，不静默继续扣费。预扣估值必须按 `RetrievalManifest.rerankInputSize` 计算——rerank 是单次问答最大单项（1024 候选实测 ¥0.1587，仅此一项即把每日 16 元压到约 100 次问答）。红旗：把 rerank 当成零成本步骤，或让候选数从环境变量而非 Manifest 取值。
- [ ] **Lease 回收**（F-26/P1）：预扣成功但进程崩溃时 lease 过期可回收，额度不永久占用。客户端超时/挂起时**不得直接释放预扣**（上游可能已计费），须留给对账或 lease 过期路径处置。
- [ ] **用户级限流**（F-29/P1）：Redis 并发/QPS/日限 + PG 硬预算闸门；超限返回 `429`，不影响其他用户。
- [ ] **供应商限流不是契约裁决**（F-30/P1）：云模型 429（实测不带 `retry-after`、不返回 `usage`）必须在 Adapter 侧退避重试并可截断候选降级，不得被记为供应商能力缺陷或当作排序结果。红旗：把一次 429 后的空/错序响应写进指标或结论。

## 复核记录模板

```
主题: <ACL | 注入 | 冲突/Finalizer | 删除 | 预算>
范围: <PR/commit/文件>
结论: 满足 / 阻断
证据: <代码位置 + 测试>
命中: <F 编号，若阻断>
```
