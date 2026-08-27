# PROBE-005 ModelAdapter 探针结果（Stage B · Chat · Chat Completions API）

> **⚠️ 事后勘误（2026-08-26）**：本次运行（06:17Z）来自**更早版本的探针**，尚无 `latency_profile` / `reasoning_accounting` 两项检查，且身份问询用 `max_tokens=64`，被 CoT 吃光预算导致正文为空 → 报告里的 `identity_consistent=False` 是**探针预算不足的假结论**，不是「模型身份不可核验」。以 `-step-3.5-flash-2603` 的限速复跑为准。


- 状态：**PASS_WITH_ADJUSTMENT**
- 执行时间：2026-08-26T06:17:24Z
- Provider：stepfun（`https://api.stepfun.com/v1` · OpenAI **Chat Completions** `/chat/completions`）
- 模型：`step-3.5-flash`
- 使用的 User-Agent：`(default)`

> LIVE = 供应商真实返回；SIMULATED = 数据分级门禁、预算账本、分层引用验证（设计期无业务代码，随 ModelAdapter 实现复验）。仅发送合成客服文本，密钥不入库/日志/报告。

## 契约映射（LIVE，非流式）

- HTTP 200，耗时 1.833s，内容 62 字符
- 响应 id：True；request-id 头：None
- model 回显：`step-3.5-flash`（与请求一致：True）
- finish_reason：`stop`
- usage 回传：**True** → {'prompt_tokens': 160, 'completion_tokens': 244, 'total_tokens': 404, 'reasoning_tokens': 0, 'cached_tokens': 64}
- 回答含资料编号引用：True

## 流式 / TTFT / 取消（LIVE）

| 场景 | HTTP | TTFT(s) | 总耗时(s) | 增量数 | 字符 | finish_reason | 流内 usage |
|---|---|---|---|---|---|---|---|
| 完整生成 | 200 | 9.502 | 9.695 | 13 | 62 | stop | 有 |
| 中途取消(5 增量) | 200 | 2.11 | 2.188 | 5 | 24 | None | 有 |

- 取消生效：**True**；流式回传 usage：**True**

## 结构化输出（LIVE · response_format）

| 模式 | HTTP | 各次尝试 | 解析为 JSON | 满足 schema | 备注 |
|---|---|---|---|---|---|
| `json_schema` | 200 | [200] | True | True |  |
| `json_object` | 200 | [200] | False | False | {
    "answer": "1. 订单签收后7天内可申请无理由退款；2. 非人为损坏的情况下退货运 |

## 错误映射（LIVE）

- 错误密钥 → HTTP 401（401：True）
- 未知模型 → HTTP 404（4xx 拒绝：True）
- 客户端超时（0.7s）→ 可归一：True（TimeoutError: The read operation timed out）

## 成本（LIVE 用量）

- prompt tokens：320；completion tokens：488
- 单价（元/百万 in/out）：0.0 / 0.0；估算：None 元
- 口径说明：仅统计供应商回报了 usage 的调用；单价来自环境变量/参数。单次问答成本口径需叠加 Stage A 的查询/逐句 Embedding 与高风险蕴含调用。

## 可用性（LIVE · 间歇性挂起）

- 非流式调用 4 次，其中 **0 次>90s 读超时**（挂起率 0.0），每次最多重试 3 次
- 口径：每个非流式调用最多重试 3 次；hang = 超过 90s 读超时（远超正常响应时间）。

## 模型来源（LIVE · 可信性）

- 请求模型：`step-3.5-flash`；响应回显：`step-3.5-flash`；模型自称：****（一致：False）
- Chat Completions 无 `instructions` 回显，端点若注入 system prompt 不可从响应体直接观测；Adapter 始终显式传入自己的 system 消息（ADR-0032 注入面）。

## 待决策
- 一次完整生成 9.695s 已超 ADR-0027 高风险路径 P95<=3.5s 预算：高风险腿需改配非推理模型或再次上调预算，并复核 ADR-0027。
- `response_format` 的 `json_object` 模式在此供应商不可用（各次尝试 HTTP [200]），而 strict `json_schema` 正常：**Adapter 必须按供应商登记结构化输出方言能力**，此供应商只走 json_schema，且不得把 json_object 当降级回退。
- 模型身份存疑：请求 `step-3.5-flash`、回显 `step-3.5-flash`，但模型自称“”。第一方厂商应可核验，如不一致需供应商出具模型映射说明后再进生产。

## SIMULATED（服务层，随 ModelAdapter 实现复验）

- **data_class_gating**：ADR-0025：UNKNOWN/敏感等级必须在 ModelAdapter 准入层（而非调用点）阻断 Chat/Embedding/Reranker/引用验证四条路径。设计期仓库无业务代码，本探针只发送合成文本，门禁为 SIMULATED，随 ModelAdapter 实现的集成测试复验。
- **budget_ledger**：ADR-0029：调用前在同一 PostgreSQL 事务写入 RESERVED 并取 lease，结算写回实际用量并释放差额，流式取消按已产生 token 结算，进程被杀后 lease 过期回收。无 DB/业务代码，SIMULATED；本探针 LIVE 记录真实 usage 与取消时已产生的增量，供预扣/结算口径校准。
- **citation_verification**：ADR-0027 分层引用验证（2026-08-26 修订后：常规 P95<=2.0s / 高风险含蕴含调用 P95<=3.5s，且逐句 Embedding 与蕴含调用必须并发发起）依赖逐句 Embedding 批量 + 高风险蕴含调用，属独立测量，需与 Stage A 的批量延迟曲线合并计算，本 stage 未单独压测。
- **provider_governance**：StepFun（阶跃星辰）是第一方模型厂商而非中转站，但仍是数据路径上的外部处理方，可能记录/留存 prompt。探针仅合成文本可接受；生产承载真实客服数据前必须评估留存与合规，否则冲突 ADR-0017/0025「敏感数据不出域」。