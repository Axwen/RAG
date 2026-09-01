# 阶段 1 实施 Tickets 与依赖顺序

> 状态：探针收尾后的实施事实源。旧的 `tasks-eng-review-20260824.jsonl` 是首次工程评审快照，不再作为当前任务范围依据。

## 验收口径

每张 Ticket 合并前必须同时满足四类证据，不能只勾选 Probe Decision Gate：

1. 本文件与工程评审闭合记录第 16 节中的 Ticket DoD。
2. [工程评审测试计划](plan-eng-review-test-plan.md)中的对应测试层级和关键路径。
3. [安全评审清单](security-review-checklist.md)中被改动触发的 P0/P1 条目。
4. [Probe Decision Gate](probe-decision-gate.md)中对应的探针衍生集成条件。
5. [阶段人工核验门禁](manual-acceptance-gate.md)：自动化证据齐全后进入 `READY_FOR_HUMAN`，只有用户明确验收并允许继续，才能启动下一实施批次。

其中前四项是“可以提交人工验收”的前置条件，不等于用户已经验收通过。

## 人工核验规则

- 当前已经运行的并行 Agent 可完成原始任务，但不得扩展到下一批次。
- 每个固定门禁点由主 Agent 汇总 UI/API、代码导览、验证证据和已知缺口；不得以 Agent 自评或测试全绿代替用户结论。
- 用户未明确给出 `ACCEPTED` 或允许继续的 `ACCEPTED_WITH_ACTIONS` 前，下一批次保持暂停。
- 固定门禁点、状态流转和验收记录模板见[阶段人工核验门禁](manual-acceptance-gate.md)。

## Ticket 地图

| Ticket | 目标 | 关键依赖与时点 |
|---|---|---|
| [T0](tickets/T0-monorepo-foundation.md) | pnpm/uv monorepo、Compose、CI 和一键启动基线 | 探针收尾提交后第一项；完成后执行 DX Review 与实现准备增量工程复审 |
| T1a Manifest/Prisma Core | 租户、知识空间、不可变文档版本、基础 Manifest、Release、兼容矩阵 | T0；`RetrievalManifest.rerankInputSize` 为必填，开发种子显式写 64，不从环境变量读取；已并入 devex P1 三项——DX-T1（README 黄金路径 + dev 入口预载 `.env`）、DX-T2（环境预检脚本）、DX-T3（统一 API 错误信封 + 全局异常过滤器，先于首个业务端点）；CI 首次真实运行以建远程为前置，T1a 提交前关注；合并后 /plan-devex-review boomerang 复测黄金路径 <2 min |
| T1b Chunk/Index Schema | `wide-1024` Chunk 定位和 ADR-0037 mapping | T1a；阶段 1 `parent_child=false`，不实现父子字段或父子展开 |
| T2 Domain State | 正交状态命令、CAS、`searchable` 派生 | T1a；同步领域审计与状态事务一起落地；承接 HG-01 T1a 切片有条件通过的遗留——Manifest/Release 幂等重放的响应码由 201 改为 200（见 [HG-01 验收记录 §6](acceptance/hg-01-t1a-manifest-core.md#6-用户验收结论)）|
| T3 MessageBus | Outbox、Attempt/Generation、Retry/DLQ/Replay | T1a、T2、T10 的 Worker 基础 Profile |
| T4a Parser/ObjectStorage | 上传、对象认领、异步 Parser（DeepDOC 后端）、取消和孤儿清扫 | T3；同时落地 T13 的解析入口扫描 |
| T4b Office/图片解析后端 | JPG/PNG 走本地 DeepDOC OCR、Office 走库提取+内嵌图 OCR、格式路由（零云调用） | PROBE-007（本地探针）冻结 `OfficeImageManifest`；T13 注入检测链随本票接入 OCR 输出；不阻塞 T4a/T5 |
| T5 Release/OpenSearch | Candidate Release、Alias Intent/Reconciler、重建与回滚 | T1b、T3、T4a、T15 Embedding/预算门禁 |
| T6 Retrieval | Snapshot、ACL 两段授权、混合检索、融合与 Rerank | T5、T9 的评测 Harness；在本 Ticket 内用真实业务语料比较 N，并在质量/成本基线前拍板 `rerankInputSize` |
| T7 Answer/Citation | Answer/Citation/Finalizer、SSE、分层引用验证 | T6、T15；同时落地 T13 的输出检查和 T16 `/chat` |
| T8 Deletion/Replay | 删除目标、墓碑、Legal Hold、证明、恢复与 Replay | T3、T5、T7；包含 `/admin/deletions` 所需 API |
| T9 Feedback/Evaluation | 固定语料、评测 Harness、反馈与发布报告 | Harness/语料在 T6 前交付；反馈、报告和完整 50 题门禁可在 T7 后完成 |
| T10 Worker Runtime | ingestion/evaluation Profile、并发、in-flight、prefetch 和资源隔离 | 启动 Profile 与配置在 T3/T4 前；并行压测在 T9 完整链路后关闭 |
| T11 Audit/Telemetry | 同步领域审计与异步运行遥测 | 同步审计在 T2/T3 前半段落地；遥测消费者和故障恢复可后置 |
| T12 Performance/Budget | 配置硬上限、Budget Ledger、限流、缓存和性能报告 | Ledger schema/预扣在 T15 前；检索性能随 T6，完整报告随 T9 后关闭 |
| T13 Untrusted Content | 解析、进入上下文前、输出后三处注入检测 | 分别随 T4、T6、T7 交付，不作为最后一次集中补丁 |
| [T14](tickets/T14-identity-authorization.md) Identity/Business User/Authorization | Keycloak OIDC 只负责身份；自有 BusinessUser、租户/Workspace 成员、角色/能力权限、资源授权、作用域编译和 fail-closed | T0、T1a；在 T6 和所有 Web 路由前完成；为客服、研发、普通员工等后续域提供统一身份上下文，不复制用户系统（ADR-0039）|
| [T15](tickets/T15-model-adapter.md) ModelAdapter | Chat、Embedding、Reranker、引用验证统一准入层及供应商方言 | T1a、T12 Ledger；在 T5 Embedding、T6 Rerank、T7 Chat/Citation 前完成 |
| [T16](tickets/T16-web-admin-surfaces.md) Web/Admin Surfaces | 登录、知识上传/审核、入库状态、Chat 和三个管理控制台 | 页面开工前执行 Design Review；按后端 Ticket 纵向交付，不单独等待最后集成；拆为 T16a 用户主链与 T16b 管理控制台两批 |

## 工作量估算

十八张票据的 `human`/`CC` 估算、重叠转移明细和周期换算集中在[工程评审闭合记录第 16 节与 16.1 节](plan-eng-review-closure.md#16-实施任务)，本文件不复制数字。当前口径：

- 十九张票据合计 human ~91d / CC ~21.85d（含 ADR-0038 的 T4b 拆分新增与 T1a 并入的 devex P1 三项，[devex 报告](plan-devex-review-20260828.md)）；T0/T14/T15/T16 四张新票据的净新增为 human ~19.5d / CC ~4.9d，其余 ~5.5d 是从 T5–T12 转移而来的归属调整。PROBE-007 为本地探针，零云成本。
- 估算只覆盖实现本身。门禁、集成验证、真实语料构建、性能回归和恢复演练不在票据估算内，周期换算按经验系数给出区间而不是承诺。
- T0/T14/T15/T16 的拆分依据、校准理由和风险项写在各自 Ticket 的“工作量估算”一节。

## 执行顺序

```text
探针收尾提交
  -> T0
  -> DX Review + 实现准备增量工程复审
  -> T1a + T14 + T11(同步审计) + T12(Ledger/配置骨架)
  -> HG-01 人工核验（当前并行 Agent 到此停止，用户通过后继续）
  -> T2 + T10(Worker 基础) -> T3 -> T1b
  -> HG-02 人工核验
  -> T15 -> T4a + T13(parse) -> T5
  -> PROBE-007（本地，零云成本，可与 T5/T9 并行） -> T4b（PROBE-007 BLOCKED 的格式缩回或后置）
  -> HG-03 人工核验
  -> T9(Harness/语料) -> T6 + T13(context) -> 拍板 rerankInputSize
  -> HG-04 人工核验
  -> Design Review -> T7 + T13(output) + T16a 用户主链
  -> HG-05 人工核验
  -> T8 + T9(反馈/报告) + T10/T11/T12 收口 + T16b 管理控制台
  -> HG-06 人工核验
  -> Probe Gate 集成项全闭合 -> 完整增量工程复审与周期重估
  -> HG-07 人工核验
```

实现准备增量工程复审用于确认 T0 后的真实工具链、依赖图和工作量；Probe Gate 全闭合后的复审用于确认集成结果、容量和 24–36 周窗口。两者不是同一次评审。
