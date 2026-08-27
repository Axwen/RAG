# PROBE-005 ModelAdapter 探针结果（Stage B · Chat · Responses API）

- 状态：**PASS_WITH_ADJUSTMENT**
- 执行时间：2026-08-26T02:57:05Z
- Provider：fluxionai（`https://fluxionai.space/v1` · OpenAI **Responses** API `/responses`）
- 模型：`gpt-5.6-terra`
- 使用的 User-Agent：`(default)`

> LIVE = 供应商真实返回；SIMULATED = 数据分级门禁、预算账本、分层引用验证（设计期无业务代码，随 ModelAdapter 实现复验）。仅发送合成客服文本，密钥不入库/日志/报告。

## 契约映射（LIVE，非流式）

- HTTP 200，耗时 3.322s，内容 50 字符
- 响应 id：True；request-id 头：22b2fd3a-a4eb-411a-b6fa-7e4cc4edae94
- model 回显：`gpt-5.6-terra`（与请求一致：True）
- status：`completed`
- usage 回传：**True** → {'prompt_tokens': 178, 'completion_tokens': 47, 'total_tokens': 205, 'reasoning_tokens': 0, 'cached_tokens': 0}
- 回答含资料编号引用：True
- 回显 instructions（前 80 字）：`你是企业客服助手。只依据【资料】回答，不得编造；若资料不足请明确说明，并在每条结论后用 [D1]/[D2]/[D3] 标注来源。`

## 流式 / TTFT / 取消（LIVE）

| 场景 | HTTP | TTFT(s) | 总耗时(s) | 增量数 | 字符 | status | 流内 usage |
|---|---|---|---|---|---|---|---|
| 完整生成 | 200 | 2.216 | 2.965 | 40 | 53 | completed | 有 |
| 中途取消(5 增量) | 200 | 2.42 | 2.433 | 5 | 6 | in_progress | 无 |

- 取消生效：**True**；流式回传 usage：**True**
- 完整生成 SSE 事件类型：{'response.created': 1, 'response.audio.transcript.delta': 1, 'response.in_progress': 1, 'response.output_item.added': 1, 'response.content_part.added': 1, 'response.output_text.delta': 40, 'response.output_text.done': 1, 'response.content_part.done': 1, 'response.output_item.done': 1, 'response.completed': 1}

## 结构化输出（LIVE · text.format）

| 模式 | HTTP | 各次尝试 | 解析为 JSON | 满足 schema | 备注 |
|---|---|---|---|---|---|
| `json_schema` | 200 | [200] | True | True |  |
| `json_object` | 500 | [500, 500, 500] | - | - | {'message': 'Upstream gateway error', 'type': 'upstream_error'} |

## 错误映射（LIVE）

- 错误密钥 → HTTP 401（401：True）
- 未知模型 → HTTP 404（4xx 拒绝：True）
- 客户端超时（0.7s）→ 可归一：True（TimeoutError: The read operation timed out）

## 成本（LIVE 用量）

- prompt(input) tokens：356；completion(output) tokens：95
- 单价（元/百万 in/out）：0.0 / 0.0；估算：None 元
- 口径说明：仅统计供应商回报了 usage 的调用（Responses 的 input/output_tokens）；单价来自环境变量/参数。单次问答成本口径需叠加 Stage A 的查询/逐句 Embedding 与高风险蕴含调用。

## 可用性（LIVE · 间歇性挂起）

- 非流式调用 6 次，其中 **0 次>90s 读超时**（挂起率 0.0），每次最多重试 3 次
- 口径：每个非流式调用最多重试 3 次；hang = 超过 90s 读超时（远超本端点实测正常响应时间）。
- 挂起（若有）为间歇性，会使单次运行的结论在 PASS/BLOCKED 之间摆动，本探针因此对每个非流式调用重试并单列挂起率；本次非流式契约调用实测耗时见上「契约映射」。

## 模型来源与提示词注入（LIVE · 可信性）

- 请求模型：`gpt-5.6-terra`；响应回显：`gpt-5.6-terra`；模型自称：**GPT-5**（一致：False）
- 不传 instructions 时端点注入自有 system prompt：**True**（21488 字符）
- 注入正文已脱敏；历史结果未保留正文哈希
- 显式传入 `instructions` 可完全覆盖注入内容（见上「契约映射」的回显）。

## 待决策
- 流式 TTFT≈2.216s 偏高（疑似推理模型缓冲 reasoning tokens）：高风险引用验证 P95<=1.5s 目标需据此复核或改配非推理模型。
  - **后续处置（2026-08-26，用户拍板「先放宽」）**：ADR-0027 已原地修订为常规 P95<=2.0s / 高风险 P95<=3.5s，并新增「逐句 Embedding 与蕴含调用必须并发发起」硬约束；不改配非推理模型。本行的 1.5s 是探针运行当时的 ADR 值，保留为原始测量记录。
- `text.format` 的 `json_object` 模式在此供应商不可用（各次尝试 HTTP [500, 500, 500]），而 strict `json_schema` 正常：**Adapter 必须按供应商登记结构化输出方言能力**，此供应商只走 json_schema，且不得把 json_object 当降级回退（会在生产偶发 5xx）。
- 未传 instructions 时端点会**注入自己的 system prompt**（21488 字符，正文已脱敏，历史结果未保留正文哈希）：会污染 grounded-answer 提示词。ModelAdapter 必须**始终显式传入自己的 instructions**（本探针已实测显式传入可完全覆盖），并禁止依赖端点默认值。
- 模型身份不可核验：请求 `gpt-5.6-terra`、回显 `gpt-5.6-terra`，但模型自称“GPT-5”。「可信 RAG」要求承载模型与提供方可审计，需供应商出具模型映射说明，否则不能进入生产。

## SIMULATED（服务层，随 ModelAdapter 实现复验）

- **data_class_gating**：ADR-0025：UNKNOWN/敏感等级必须在 ModelAdapter 准入层（而非调用点）阻断 Chat/Embedding/Reranker/引用验证四条路径。设计期仓库无业务代码，本探针只发送合成文本，门禁为 SIMULATED，随 ModelAdapter 实现的集成测试复验。
- **budget_ledger**：ADR-0029：调用前在同一 PostgreSQL 事务写入 RESERVED 并取 lease，结算写回实际用量并释放差额，流式取消按已产生 token 结算，进程被杀后 lease 过期回收。无 DB/业务代码，SIMULATED；本探针 LIVE 记录真实 usage 与取消时已产生的增量，供预扣/结算口径校准。
- **citation_verification**：ADR-0027 分层引用验证（常规 P95<=600ms / 高风险含蕴含调用P95<=1.5s）依赖逐句 Embedding 批量 + 高风险蕴含调用，属独立测量，需与 Stage A 的批量延迟曲线合并计算，本 stage 未单独压测。
- **relay_governance**：中转站是数据路径上的额外第三方处理方，可能记录/留存 prompt。探针仅合成文本可接受；生产承载真实客服数据前必须评估留存与合规，否则冲突 ADR-0017/0025「敏感数据不出域」。
