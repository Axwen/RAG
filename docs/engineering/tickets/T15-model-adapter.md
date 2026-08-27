# T15：ModelAdapter 与模型预算准入

## 目的

把 PROBE-005 的四条供应商路径落成一个服务端准入层，统一执行数据等级、预算、超时、取消、供应商方言和日志脱敏，不允许业务模块直接调用供应商。

## 范围

- `apps/api/src/modules/model/`：Chat、Embedding、Reranker、引用验证四类调用及 Provider 能力表。
- `packages/contracts/src/model/`：`ModelCallContext`、结构化结果、错误码、取消信号和用量事实。
- `packages/config/`：服务端模型/base/超时/批量上限和供应商能力配置；密钥只来自环境变量。
- `packages/database/`：调用前预算预扣、lease、结算、未知上游计费状态和回收协议；schema 由 T12 前置部分提供。
- OpenRouter Embedding/Reranker 与 fluxionai Responses 适配；不引入独立 Model Gateway。

## 不变量

- `UNKNOWN` 或不允许出域的数据在发出 HTTP 请求前阻断，四类调用共用同一准入点。
- Chat 始终显式传 `instructions`；fluxionai 只走 strict `json_schema`，不回退 `json_object`。
- Responses SSE 事件白名单解析，未知事件忽略，`reasoning_content` 不成为可见答案或快照。
- Embedding 固定 1024 维并按响应 `index` 对齐；Rerank 输入取自 `RetrievalManifest.rerankInputSize`，不从前端或环境变量覆盖。
- 429 是常规运行分支；Rerank 回显正文、原始 Prompt、Token 和密钥不得进入日志或快照。
- 调用前预扣；成功、已知取消、超时和未知上游计费状态分别按 ADR-0029 结算，进程崩溃由 lease 回收。

## 依赖

- T0、T1a、T12 的 Budget Ledger schema/事务入口。
- T5 的 Embedding、T6 的 Rerank、T7 的 Chat/Citation 必须依赖本 Ticket，不得各写供应商客户端。

## 验证

- Provider 契约：四类调用、错误归一、严格结构化输出、SSE、取消、未知事件和模型白名单。
- 数据门禁：敏感/UNKNOWN 输入断言没有任何网络请求。
- PostgreSQL 集成：并发预扣、结算差额、取消、客户端超时但上游可能计费、崩溃和 lease 回收。
- Rerank：上限截断、429 退避/降级、黄金文档置于末位和正文不落日志。
- 所有 LIVE 供应商测试使用合成数据、显式手工触发，不进入普通 CI。

## 回滚

- Provider 配置或实现回滚时不得绕过数据和预算门禁；不可用时只能降级到 ADR 允许路径、`EVIDENCE_ONLY` 或拒答。
- 预算处于未知上游计费状态时保持保留，不因应用回滚直接释放。

## DoD

- [PROBE-005 Ticket](PROBE-005-model-adapter.md)通过标准全部有实现证据。
- F-15、F-30 和预算相关安全检查全部满足。
- 供应商真实数据治理未关闭前，系统只允许合成/严格脱敏数据进入云路径。
