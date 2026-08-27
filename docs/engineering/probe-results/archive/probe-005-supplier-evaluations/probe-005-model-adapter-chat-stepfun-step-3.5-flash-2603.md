# PROBE-005 ModelAdapter 探针结果（Stage B · Chat · Chat Completions API）

- 状态：**PASS_WITH_ADJUSTMENT**
- 执行时间：2026-08-26T07:35:21Z
- Provider：stepfun（`https://api.stepfun.com/v1` · OpenAI **Chat Completions** `/chat/completions`）
- 模型：`step-3.5-flash-2603`
- 使用的 User-Agent：`(default)`

> LIVE = 供应商真实返回；SIMULATED = 数据分级门禁、预算账本、分层引用验证（设计期无业务代码，随 ModelAdapter 实现复验）。仅发送合成客服文本，密钥不入库/日志/报告。

## 契约映射（LIVE，非流式）

- HTTP 200，耗时 2.111s，内容 53 字符
- 响应 id：True；request-id 头：None
- model 回显：`step-3.5-flash-2603`（与请求一致：True）
- finish_reason：`stop`；请求 max_tokens=1200，被截断：False
- **隐藏推理正文**：`reasoning_content` 字段存在=True，292 字符（与可见正文共用同一 max_tokens 预算）
- usage 回传：**True** → {'prompt_tokens': 165, 'completion_tokens': 238, 'total_tokens': 403, 'reasoning_tokens': 0, 'cached_tokens': 0}
- 回答含资料编号引用：True

## 流式 / TTFT / 取消（LIVE）

两个 TTFT 必须分开看：`首事件` 是任意增量（含 reasoning_content）到达时刻——进度条能动的时刻；`可读答案` 是第一个可见正文 token——用户真正有字可读的时刻。推理模型下两者可能差好几秒。

| 场景 | HTTP | 首事件TTFT(s) | 可读答案TTFT(s) | 总耗时(s) | 正文增量/字符 | 推理增量/字符 | finish_reason | 流内 usage |
|---|---|---|---|---|---|---|---|---|
| 完整生成 | 200 | 0.394 | 1.855 | 1.981 | 11/58 | 79/288 | stop | 有 |
| 中途取消(5 增量) | 200 | 0.301 | 1.727 | 1.766 | 5/21 | 79/297 | None | 有 |

- 取消生效：**True**；流式回传 usage：**True**

## 结构化输出（LIVE · response_format）

**截断不等于不支持**：HTTP 200 + `finish_reason=length` + 正文 0 字，是 max_tokens 被 CoT 吃光，属 Adapter 的 token 预算问题；曾据此误判「该供应商不支持 json_object」，与 Stage C 被 429 污染同属一类假结论。故 finish_reason 单列并单独判定。

| 模式 | HTTP | 各次尝试 | 解析为 JSON | 满足 schema | finish_reason | 截断 | 正文/推理字符 | max_tokens | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| `json_schema` | 200 | [200] | True | True | stop | False | 143/288 | 1200 |  |
| `json_object` | 200 | [200] | True | True | stop | False | 130/712 | 1200 |  |

## 推理用量与 `reasoning_effort`（LIVE · 推理模型专项）

step-3.5-flash 是推理模型，隐藏 CoT 既占 `max_tokens` 又计费，直接决定 ADR-0029 的结算口径与 ADR-0027 的时延手段。

- 采样方法：每档 3 次采样；判定「生效」要求 low 的上界与 high 的下界分离（>1.5x），单样本对比会凭噪声造出结论。

| reasoning_effort | HTTP | 推理字符 min/中位/max | completion_tokens | usage 里的 reasoning_tokens | finish_reason |
|---|---|---|---|---|---|
| `(unset)` | [200, 200, 200] | 291/359/359 | [194, 194, 158] | [0, 0, 0] | ['stop', 'stop', 'stop'] |
| `low` | [200, 200, 200] | 45/45/48 | [29, 29, 32] | [0, 0, 0] | ['stop', 'stop', 'stop'] |
| `high` | [200, 200, 200] | 295/355/588 | [160, 195, 302] | [0, 0, 0] | ['stop', 'stop', 'stop'] |

- 返回推理正文：**True**；usage 中单列 reasoning_tokens：**False**
- `reasoning_effort` 被接受：True；**区间可分离（判定为有效）：True**（各档 CoT 字数 min-max {'(unset)': [291, 359], 'low': [45, 48], 'high': [295, 588]}）

## 时延分布（LIVE · 多次采样，ADR-0027 判定依据）

ADR-0027 以 P95 表述，单次流式生成无法裁决——同一 payload 在历史运行中测到 7.698s / 9.695s，本轮又能落到 2.5s。故按 n 次采样报区间与越界次数，并明确 n 很小。

- 样本 5/5 成功；完整生成 **1.952–3.061s**（中位 2.665s）；可读答案首字 1.719–2.938s（中位 2.404s）
- 越界次数：>3.5s（高风险预算）**0** 次；>2.0s（常规预算）**4** 次
- 口径：同一 payload 的流式完整生成，n=5；ADR-0027 以 P95 表述，n 太小只能给区间与越界次数，不能自称 P95。

| # | HTTP | 完整生成(s) | 首事件(s) | 可读答案(s) | 正文字符 | 推理字符 | completion_tokens |
|---|---|---|---|---|---|---|---|
| 1 | 200 | 3.061 | 0.695 | 2.938 | 53 | 354 | 280 |
| 2 | 200 | 1.952 | 0.291 | 1.719 | 62 | 297 | 244 |
| 3 | 200 | 2.554 | 0.6 | 2.404 | 58 | 288 | 237 |
| 4 | 200 | 2.703 | 0.323 | 2.101 | 58 | 288 | 237 |
| 5 | 200 | 2.665 | 0.31 | 2.447 | 53 | 360 | 283 |

## 错误映射（LIVE）

- 错误密钥 → HTTP 401（401：True）
- 未知模型 → HTTP 404（4xx 拒绝：True）
- 客户端超时（0.7s）→ 可归一：True（TimeoutError: The read operation timed out）

## 成本（LIVE 用量）

- **单次问答**（一次 grounded chat，含隐藏 CoT）：prompt 165 + completion 238 tokens → 0.000633 元
- 本次探针合计（下界）：prompt tokens 1320；completion tokens 3265
- 单价（元/百万 in/out）：0.72 / 2.16；估算：0.008003 元
- 单价来源：StepFun 官方定价页 $0.10/1M in（cache miss）、$0.02 cache hit、$0.30/1M out，按汇率 7.2 折算 ¥0.72/¥2.16
- 口径说明：仅统计供应商回报了 usage 的调用（结构化输出两次未逐行留存 usage，故合计为下界）；单价来自 CHAT_PRICE_CNY_PER_1M_IN/OUT，未设则为 0。**单次问答成本口径**需在 one_answer_* 之上叠加 Stage A 的查询/逐句 Embedding、Stage C 的 rerank 与高风险蕴含调用。注意 CoT 计入 completion_tokens 却不单列，无法拆分思考成本。

## 可用性与限流（LIVE）

- 非流式调用 13 次，其中 **0 次>90s 读超时**（挂起率 0.0），每次最多重试 3 次
- 限速：按 RPM=8 发起；吸收 429 **0** 次（退避等待 0.0s）
- `reasoning_effort` 本次固定为：**low**
- 口径：每个非流式调用最多重试 3 次；hang = 超过 90s 读超时（远超正常响应时间）。429 按 RPM 上限限速 + 退避重试吸收，**不作为供应商契约结论**（未限速的运行曾把 provenance 与 high 档采样吃掉）。

## 模型来源（LIVE · 可信性）

- 请求模型：`step-3.5-flash-2603`；响应回显：`step-3.5-flash-2603`；模型自称：**Step**（一致：True）
- 问询用 max_tokens=512，finish_reason=`stop`，CoT 488 字符；因截断而取不到身份：False
- 注：身份问询必须给足 max_tokens。曾用 64 令 CoT 吃光预算、正文为空，被误记成「模型身份不可核验」——空正文是探针预算不足，不是供应商事实。
- Chat Completions 无 `instructions` 回显，端点若注入 system prompt 不可从响应体直接观测；Adapter 始终显式传入自己的 system 消息（ADR-0032 注入面）。

## 待决策
- 高风险 3.5s 预算本轮全部满足，但常规 2.0s 预算有 4/5 次越界（完整生成 n=5：1.952–3.061s（中位 2.665s）；可读答案首字 1.719–2.938s）：常规问答腿需按上界而非中位数设超时，且逐句 Embedding 与蕴含调用必须并发发起（ADR-0027 硬约束）。历史运行曾达 7.7-9.7s，抖动须计入选型。
- **推理内容先流完才出正文**：首个任意事件 0.394s、可读答案首字 1.855s（差 1.46s，其间只有 79 个 reasoning_content 增量）。UI 只能先显示「思考中」进度，不能把 reasoning_content 当答案渲染（未经引用校验的内容不得呈现，ADR-0027/0032）。
- **推理用量不可分摊**：`message.reasoning_content` 实测数百字，但 `usage.completion_tokens_details.reasoning_tokens` 恒为 0 —— CoT 计费折进 `completion_tokens` 却不单列。ADR-0029 账本因此无法把成本拆成「思考 vs 答案」，只能按 completion_tokens 总量结算；且 Adapter 必须把 CoT 计入 max_tokens 预留，否则正文被静默截断（实测 CoT 字数 {'(unset)': [291, 359], 'low': [45, 48], 'high': [295, 588]}）。
- `reasoning_effort` **实测有效**（各档 CoT 字数 min-max：{'(unset)': [291, 359], 'low': [45, 48], 'high': [295, 588]}，每档 3 次采样，low 上界与 high 下界分离）：可作为高风险腿压时延的候选手段，但需与「低 effort 是否降低蕴含判断质量」一并在 PROBE-006 评测，**未评测前不得为了达标 ADR-0027 而默认调低**。

## SIMULATED（服务层，随 ModelAdapter 实现复验）

- **data_class_gating**：ADR-0025：UNKNOWN/敏感等级必须在 ModelAdapter 准入层（而非调用点）阻断 Chat/Embedding/Reranker/引用验证四条路径。设计期仓库无业务代码，本探针只发送合成文本，门禁为 SIMULATED，随 ModelAdapter 实现的集成测试复验。
- **budget_ledger**：ADR-0029：调用前在同一 PostgreSQL 事务写入 RESERVED 并取 lease，结算写回实际用量并释放差额，流式取消按已产生 token 结算，进程被杀后 lease 过期回收。无 DB/业务代码，SIMULATED；本探针 LIVE 记录真实 usage 与取消时已产生的增量，供预扣/结算口径校准。
- **citation_verification**：ADR-0027 分层引用验证（2026-08-26 修订后：常规 P95<=2.0s / 高风险含蕴含调用 P95<=3.5s，且逐句 Embedding 与蕴含调用必须并发发起）依赖逐句 Embedding 批量 + 高风险蕴含调用，属独立测量，需与 Stage A 的批量延迟曲线合并计算，本 stage 未单独压测。
- **provider_governance**：StepFun（阶跃星辰）是第一方模型厂商而非中转站，但仍是数据路径上的外部处理方，可能记录/留存 prompt。探针仅合成文本可接受；生产承载真实客服数据前必须评估留存与合规，否则冲突 ADR-0017/0025「敏感数据不出域」。
---

## 补注（2026-08-26，与 A/B 探针对照后加）

本报告 `reasoning_accounting` 检查里「`reasoning_effort` 实测有效」的**作用域只到本检查所用的琐碎短问题**（「只回答模型名称本身」，正文 4 字符）。同一模型在 grounded 引用问答负载上的结论相反：A/B 探针每档 40 样本、`max_tokens=1200`，`low` 与 `high` 的 CoT 字数分布完全重叠（189–424 vs 288–465，中位均 295）、completion tokens 仅差 3.2%、完整生成 p95 也不更快。

两者不矛盾：**任务自身的推理需求给 CoT 设地板，`low` 是上限而非目标**——短问题地板低（45–49 字符），旋钮有余量；引用问答地板约 300 字符，已高于 `low` 的上限，旋钮拧不动。**因此不得把 `reasoning_effort=low` 当作 RAG 答案腿的压时延手段**；`evaluate()` 的判定文案已同步收窄（见 `scripts/probes/probe_005_chat.py`），本报告生成于收窄之前，故以本补注为准。对照报告：`probe-005-model-adapter-chat-stepfun-effort-ab-step-3.5-flash-2603-pooled.md`。
