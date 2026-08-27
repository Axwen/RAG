# PROBE-005：云模型 ModelAdapter 最终契约与通过标准

## 当前结论

PROBE-005 探针层结论为 `PASS_WITH_ADJUSTMENT`。当前 MVP 基线已经确定：

| 能力 | 供应商 / 模型 | 协议 | 主结果 |
|---|---|---|---|
| Embedding | OpenRouter `qwen/qwen3-embedding-8b`，`dimensions=1024` | `POST /embeddings` | [Stage A](../probe-results/probe-005-model-adapter.md) |
| Chat / 高风险蕴含 | fluxionai `gpt-5.6-terra` | OpenAI Responses API | [Stage B](../probe-results/probe-005-model-adapter-responses-fluxionai.md) |
| Reranker | OpenRouter `qwen/qwen3-reranker-8b` | Cohere 形状 `POST /rerank` | [Stage C](../probe-results/probe-005-model-adapter-rerank-openrouter.md) |

供应商横向实验、重复运行和事后勘误不属于当前基线，统一保存在 [供应商决策日志](PROBE-005-model-adapter-decision-log.md) 和 [历史结果归档](../probe-results/archive/probe-005-supplier-evaluations/README.md)。

## 必须实现的契约

1. 业务模块不得直接导入供应商 SDK；模型、base、超时和路由由服务端配置提供。
2. Chat、Embedding、Reranker、引用验证均经过同一个 ModelAdapter 准入层；`UNKNOWN` 或敏感数据进入云执行区必须阻断。
3. Chat 必须显式传入 `instructions`；fluxionai 只使用 strict `json_schema`，不得把 `json_object` 作为回退。
4. Responses 的具名 SSE 事件必须白名单解析；忽略未知/无关事件，不得把 `reasoning_content` 当作可见答案。
5. Embedding 批量大小由 Adapter 自限（供应商不会可靠拒绝超大批量），输出按 `index` 对齐，维度固定为 1024。
6. Rerank 的 `candidateBudget` 与 `rerankInputSize` 必须分离；候选数量由 `RetrievalManifest.rerankInputSize` 决定，不能来自前端或环境变量。
7. Rerank 必须处理 429（退避重试、必要时截断候选降级），禁止记录供应商回显正文；`return_documents=false` 不得被视为安全保证。
8. 每次调用前在同一 PostgreSQL 事务中预扣预算并取得 lease；成功、取消、超时、崩溃分别结算或回收，并写入审计。

## 当前未闭合项

- 产品尚未拍板 `rerankInputSize` 的最终 N；临时实现上限为 64。
- 数据分级门禁和 PostgreSQL budget ledger 仍是探针期 `SIMULATED`，必须在 ModelAdapter 集成测试中验证。
- fluxionai 尚未提供承载模型身份映射和留存/合规说明；承载真实客服数据前必须关闭该治理门槛。
- 常规引用验证 P95 目标为 2.0 s，高风险为 3.5 s；逐句 Embedding 与蕴含调用必须并发发起。

## 通过标准

- 契约测试覆盖四类调用、错误映射、结构化输出、流式取消和未知事件。
- 集成测试证明敏感/UNKNOWN 数据不会发出云请求。
- 集成测试证明预算预扣、结算、取消和 lease 回收具备事务一致性。
- 在真实业务语料和目标并发下验证 Rerank N、延迟、成本和降级策略。
- 供应商身份、数据留存和审计材料归档后，才允许真实数据进入云执行区。

## 相关记录

- [ADR-0017](../../adr/0017-mvp-cloud-model-and-budget.md)
- [ADR-0025](../../adr/0025-data-class-routing-enforcement-point.md)
- [ADR-0027](../../adr/0027-tiered-citation-verification-budget.md)
- [ADR-0029](../../adr/0029-model-budget-ledger-and-limits.md)
- [Probe Decision Gate](../probe-decision-gate.md)
