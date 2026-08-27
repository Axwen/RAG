# 阶段 1 实施 Tickets 与依赖顺序

> 状态：探针收尾后的实施事实源。旧的 `tasks-eng-review-20260824.jsonl` 是首次工程评审快照，不再作为当前任务范围依据。

## 验收口径

每张 Ticket 合并前必须同时满足四类证据，不能只勾选 Probe Decision Gate：

1. 本文件与工程评审闭合记录第 16 节中的 Ticket DoD。
2. [工程评审测试计划](plan-eng-review-test-plan.md)中的对应测试层级和关键路径。
3. [安全评审清单](security-review-checklist.md)中被改动触发的 P0/P1 条目。
4. [Probe Decision Gate](probe-decision-gate.md)中对应的探针衍生集成条件。

## Ticket 地图

| Ticket | 目标 | 关键依赖与时点 |
|---|---|---|
| [T0](tickets/T0-monorepo-foundation.md) | pnpm/uv monorepo、Compose、CI 和一键启动基线 | 探针收尾提交后第一项；完成后执行 DX Review 与实现准备增量工程复审 |
| T1a Manifest/Prisma Core | 租户、知识空间、不可变文档版本、基础 Manifest、Release、兼容矩阵 | T0；`RetrievalManifest.rerankInputSize` 为必填，开发种子显式写 64，不从环境变量读取 |
| T1b Chunk/Index Schema | `wide-1024` Chunk 定位和 ADR-0037 mapping | T1a；阶段 1 `parent_child=false`，不实现父子字段或父子展开 |
| T2 Domain State | 正交状态命令、CAS、`searchable` 派生 | T1a；同步领域审计与状态事务一起落地 |
| T3 MessageBus | Outbox、Attempt/Generation、Retry/DLQ/Replay | T1a、T2、T10 的 Worker 基础 Profile |
| T4 Parser/ObjectStorage | 上传、对象认领、异步 Parser、取消和孤儿清扫 | T3；同时落地 T13 的解析入口扫描 |
| T5 Release/OpenSearch | Candidate Release、Alias Intent/Reconciler、重建与回滚 | T1b、T3、T4、T15 Embedding/预算门禁 |
| T6 Retrieval | Snapshot、ACL 两段授权、混合检索、融合与 Rerank | T5、T9 的评测 Harness；在本 Ticket 内用真实业务语料比较 N，并在质量/成本基线前拍板 `rerankInputSize` |
| T7 Answer/Citation | Answer/Citation/Finalizer、SSE、分层引用验证 | T6、T15；同时落地 T13 的输出检查和 T16 `/chat` |
| T8 Deletion/Replay | 删除目标、墓碑、Legal Hold、证明、恢复与 Replay | T3、T5、T7；包含 `/admin/deletions` 所需 API |
| T9 Feedback/Evaluation | 固定语料、评测 Harness、反馈与发布报告 | Harness/语料在 T6 前交付；反馈、报告和完整 50 题门禁可在 T7 后完成 |
| T10 Worker Runtime | ingestion/evaluation Profile、并发、in-flight、prefetch 和资源隔离 | 启动 Profile 与配置在 T3/T4 前；并行压测在 T9 完整链路后关闭 |
| T11 Audit/Telemetry | 同步领域审计与异步运行遥测 | 同步审计在 T2/T3 前半段落地；遥测消费者和故障恢复可后置 |
| T12 Performance/Budget | 配置硬上限、Budget Ledger、限流、缓存和性能报告 | Ledger schema/预扣在 T15 前；检索性能随 T6，完整报告随 T9 后关闭 |
| T13 Untrusted Content | 解析、进入上下文前、输出后三处注入检测 | 分别随 T4、T6、T7 交付，不作为最后一次集中补丁 |
| [T14](tickets/T14-identity-authorization.md) Identity/Authorization | Keycloak OIDC、用户映射、Workspace 成员、作用域编译和 fail-closed | T0、T1a；在 T6 和所有 Web 路由前完成 |
| [T15](tickets/T15-model-adapter.md) ModelAdapter | Chat、Embedding、Reranker、引用验证统一准入层及供应商方言 | T1a、T12 Ledger；在 T5 Embedding、T6 Rerank、T7 Chat/Citation 前完成 |
| [T16](tickets/T16-web-admin-surfaces.md) Web/Admin Surfaces | 登录、知识上传/审核、入库状态、Chat 和三个管理控制台 | 页面开工前执行 Design Review；按后端 Ticket 纵向交付，不单独等待最后集成 |

## 执行顺序

```text
探针收尾提交
  -> T0
  -> DX Review + 实现准备增量工程复审
  -> T1a + T14 + T11(同步审计) + T12(Ledger/配置骨架)
  -> T2 + T10(Worker 基础) -> T3 -> T1b
  -> T15 -> T4 + T13(parse) -> T5
  -> T9(Harness/语料) -> T6 + T13(context) -> 拍板 rerankInputSize
  -> Design Review -> T7 + T13(output) + T16 用户主链
  -> T8 + T9(反馈/报告) + T10/T11/T12 收口 + T16 管理控制台
  -> Probe Gate 集成项全闭合 -> 完整增量工程复审与周期重估
```

实现准备增量工程复审用于确认 T0 后的真实工具链、依赖图和工作量；Probe Gate 全闭合后的复审用于确认集成结果、容量和 24–36 周窗口。两者不是同一次评审。
