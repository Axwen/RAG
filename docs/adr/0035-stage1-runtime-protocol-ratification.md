---
status: accepted
revised: 2026-08-26
revision-basis: PROBE-005 实测触发 ADR-0027 修订，本文第 17 行的引用验证预算随之同步
---

# 阶段 1 运行期硬协议从工程评审记录提升为 ADR 级事实

若干条不可回退的运行期协议此前只存在于 `docs/engineering/plan-eng-review-closure.md` 这一级记录里。该文档在事实来源层级中低于 ADR，却承载了跨模块的强约束；一旦下游文档与它冲突，无法判定谁是事实。本 ADR 不改变这些协议的内容，只把它们提升到 ADR 级，使其变更必须走 ADR 流程。

Worker 双 profile 隔离：`apps/worker` 只以 `ingestion` 与 `evaluation` 两种 profile 运行，二者不共享进程、不共享并发度、不同时占用 24 GiB 内存 profile。批量评测与 DeepDOC 解析互斥排队，不允许通过临时提高并发绕过。

审计同步、埋点异步：领域审计写入与业务事务同事务提交，写失败则业务失败；可观测埋点与指标异步投递，丢失不影响业务结果。二者不得互换载体。

两阶段上传与对象归属：预签名只允许写入 `tmp/{tenantId}/{uploadSessionId}`；`complete` 校验通过后由服务端提升为内容寻址键；`object_claim`、`document_version` 与 `outbox_event` 在同一个 PostgreSQL 事务内写入。清理 Worker 按 TTL 回收未提升的临时对象并留下删除证明。客户端不得直接写入正式键空间。

回答三段边界：`AnswerModule` 产出正文、`CitationModule` 产出逐句引用与验证状态、`AnswerFinalizer` 决定最终状态与快照。任何模块不得跨段直接调用 `ModelAdapter` 完成他段职责；高风险回答在最终状态确定前缓冲，输出上限 2048 token。

资源与超时预算：OpenSearch 单请求候选 ≤ 1024、fan-out ≤ 2 个知识空间、检索请求总超时 250 ms；ACL 候选复核 P95 ≤ 60 ms 且不计入该 250 ms；**进 Reranker 的候选数是与上述 1024 分离的独立配置（`RetrievalManifest.rerankInputSize`，不得由环境变量决定，否则 `RetrievalSnapshot` 无法复现一次问答的真实 rerank 输入规模），云 rerank 时延与费用独立计量、同样不计入 250 ms**（PROBE-005 Stage C 实测 64 候选 0.95 s / ¥0.0099、1024 候选 3.4-6.6 s / ¥0.1587，规模待拍板，见 [ADR-0017](0017-mvp-cloud-model-and-budget.md) 第 5 节）；引用验证常规路径 **P95 ≤ 2.0 s**、高风险路径 **P95 ≤ 3.5 s**（且逐句 Embedding 与蕴含校验必须并发发起，见 [ADR-0027](0027-tiered-citation-verification-budget.md)）。这些数字是设计约束，超出即视为回归。

> 引用验证两项数值于 2026-08-26 随 [ADR-0027](0027-tiered-citation-verification-budget.md) 的 PROBE-005 实测修订同步更新（原 600 ms / 1.5 s）。该段的其余数值未变。本文只复述 ADR-0027 的当前结论，引用验证预算的权威定义在 ADR-0027。

quick_parse 临时产物：只用于上传后的即时预览和会话级证据回答，不进入正式 Release；临时引用必须标记为 `TEMPORARY`，在 TTL 或主动删除后转为 `EXPIRED`/墓碑，按 TTL 清理，且必须经过与正式内容相同的注入检查（见 ADR-0032、ADR-0036）。

提升本身不引入新约束。后续对上述任一条的修改都必须新建 ADR 并显式 supersede 本文对应段落，工程评审记录只能引用而不能重新定义它们。
