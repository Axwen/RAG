# PROBE-005：阿里云百炼 ModelAdapter 探针

## 目的

验证 OpenAI-compatible ModelAdapter 对 Chat、Embedding、Reranker、引用验证、结构化输出、流式取消、错误映射、数据分级门禁和预算账本预扣的真实行为，并实测引用验证分层预算与单次成本口径。

## 当前依据

- [ADR-0017](../../adr/0017-mvp-cloud-model-and-budget.md)
- [ADR-0025](../../adr/0025-data-class-routing-enforcement-point.md)
- [ADR-0027](../../adr/0027-tiered-citation-verification-budget.md)
- [ADR-0029](../../adr/0029-model-budget-ledger-and-limits.md)
- 技术设计方案第 4、11、12、13 节
- 工程评审闭合记录第 14、15 节和 F-15、F-24

## 输入与边界

- 仅使用合成或严格脱敏短文本。
- Chat、Embedding、Reranker 和引用验证的实际百炼模型与地域通过环境变量提供。
- 单次 <= 5 元、每日 <= 16 元、月度 <= 500 元；交互池 350、评测池 100、应急 50 元。
- 不把供应商 SDK 类型泄漏到业务模块。
- 逐句验证 Embedding 必须合并为一次批量调用；单次预算口径包含 Chat、查询 Embedding、逐句验证 Embedding 和高风险蕴含调用之和。

## 必须验证

1. Chat、Embedding、Reranker 的请求/响应能映射到内部契约，模型名称和错误码可审计。
2. Embedding 维度、批量大小、超时和限流行为可测量；逐句批量 Embedding 的真实延迟随句数的变化曲线。
3. Chat 流式输出能取消，断流、超时、限流和供应商错误能归一化。
4. 结构化输出失败时返回受控错误，不把未校验响应交给 Answer/Citation。
5. `UNKNOWN`/敏感等级在 Chat、Embedding、Reranker 和引用验证四条路径都被阻断，且阻断发生在 ModelAdapter 准入层而非调用点。
6. 预算账本在调用前于同一 PostgreSQL 事务内写入 `RESERVED` 并取得 lease；超过单次/每日/月度/池上限时不再发起供应商请求；结算写回实际用量并释放差额；流式取消按已产生 token 结算；进程被杀后 lease 过期能回收额度。
7. 引用验证常规路径 P95 <= 600 ms、高风险路径（含一次蕴含调用）P95 <= 1.5 s 的真实可达性；不可达时给出建议数值。
8. 一次典型高风险问答的真实总费用，用于校验单次 <= 5 元与每日 16 元是否留有余量。
9. 记录 TTFT、完整生成、Embedding 批量、Reranker 延迟、错误率和真实费用。

## 产出

- `probe-005-model-adapter.md`
- `probe-005-model-adapter.json`
- ModelAdapter 契约样例、错误映射表和费用报告，覆盖四类调用的 `ModelCallContext`。
- 引用验证分层预算的实测数值与建议冻结值。
- 脱敏策略和供应商留存策略快照。

## 通过标准

- `PASS`：内部契约、错误映射、取消、数据门禁和预算账本预扣/结算/回收均成立，且分层验证预算实测可达。
- `PASS_WITH_ADJUSTMENT`：需要更换模型、调整超时/预算/验证时延目标或限制能力，但保留内部 ModelAdapter 边界与预算账本机制。
- `BLOCKED`：无法保证敏感数据阻断、预算硬阻断，或基本 Chat/Embedding/Reranker 契约。

## 测试与回滚

- 使用真实云端小模型，但不保存敏感请求/响应；费用由预算池硬阻断。
- 探针失败撤销本地环境变量和测试数据，不修改业务代码和正式 Manifest。
