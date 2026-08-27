# Probe Decision Gate

> 最近核对：2026-08-27。探针 `PASS` 表明所测外部事实成立；不等同于业务实现、真实语料回归或生产数据治理已经完成。

## 探针层结论

六个架构探针均已达到 `PASS` 或 `PASS_WITH_ADJUSTMENT`。PROBE-006 的真实 Recall@5 已完成，冻结 `wide-1024`，不再阻断 T1b、T5、T6。

| 探针 | 结论 | 主结果 |
|---|---|---|
| PROBE-001 | PASS | [结果](probe-results/probe-001-keycloak-oidc.md) |
| PROBE-002 | PASS | [结果](probe-results/probe-002-deepdoc-parser.md) |
| PROBE-003 | PASS | [结果](probe-results/probe-003-opensearch-release.md) |
| PROBE-004 | PASS | [结果](probe-results/probe-004-rabbitmq-task-bus.md) |
| PROBE-005 | PASS_WITH_ADJUSTMENT | [索引](probe-results/README.md) |
| PROBE-006 | PASS_WITH_ADJUSTMENT | [结果](probe-results/probe-006-chunking-citation-locating.md) |

## 受影响模块合并前必须落实的决策

| 项目 | 当前结论 | 关闭条件 |
|---|---|---|
| Rerank 输入规模 | `candidateBudget=1024` 不等于 `rerankInputSize`；T1a 先建立必填字段，开发种子显式写 64 | T6 使用真实业务语料完成 N 对质量、延迟与成本的比较后，由产品拍板并写入正式 Manifest、预算估值和回归用例；运行时不得从环境变量覆盖快照值 |
| 索引字段口径 | 已由 [ADR-0037](../adr/0037-stage1-index-field-alignment.md) 对齐 | T1b mapping 与 ADR-0037 一致，并有 mapping 契约测试 |
| 结果可复现性 | 早期结果缺少统一输入/环境指纹 | 后续重跑统一补齐指纹；历史结果明确标为历史格式 |

## 实现集成测试门槛

| 来源 | 必须验证 |
|---|---|
| PROBE-002 | Parser Service 生命周期、取消、崩溃恢复、PostgreSQL 幂等注册 |
| PROBE-003 | 真实 Embedding 与接近 1024 候选规模下的 kNN 参数；带 `acl_scope_key` 过滤的近似路径和召回衰减 |
| PROBE-004 | 真实 AMQP 客户端的 Publisher Confirm、`prefetch=1/4`、生产重试阶梯和调度去重 |
| PROBE-005 | 四条模型路径的数据分级门禁；预算预扣、结算、流式取消和 lease 回收 |
| PROBE-006 | 真实业务语料、完整混合检索、生产过滤链与 rerank 后质量回归 |

## 生产承载真实数据前的治理门槛

- 获取 fluxionai 的承载模型映射与可审计说明。
- 完成 OpenRouter、fluxionai 的数据留存、第三方处理和合规评估。
- 使用真实数据等级策略验证云调用阻断与审计链路。

Probe Decision Gate 在“探针事实已完成”维度成立；在“实现集成”和“生产真实数据”维度仍需按本表逐项关闭。T0 后先进行一次实现准备增量工程复审，确认真实工具链、依赖图和任务批次；本表集成项关闭后再进行完整增量工程复审与 24 至 36 周窗口重估。

本表只记录探针衍生的增量条件，不替代 [阶段 1 实施 Tickets](stage1-implementation-tickets.md)、[工程评审测试计划](plan-eng-review-test-plan.md)或[安全评审清单](security-review-checklist.md)。
