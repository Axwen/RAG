# PROBE-005 ModelAdapter 探针结果（Stage B · Chat · Chat Completions API）

> **⚠️ 事后勘误（2026-08-26）**：本次运行**未限速**，账号 RPM 上限为 10，导致 `provenance`（模型身份）整项与 `reasoning_accounting` 的 `high` 档 2/3 采样被 HTTP 429 吃掉。**这两项在本报告中的结论不成立**（429 是我方发起速率问题，不是供应商契约事实），已在 `-step-3.5-flash-2603` 的限速复跑中重测。本报告保留的有效证据是：旧版 `step-3.5-flash` 上 `reasoning_effort` **确实有效**（low CoT 45-49 字符 vs high 299）——该参数在新版 `-2603` 上实测已失效。


- 状态：**PASS_WITH_ADJUSTMENT**
- 执行时间：2026-08-26T06:52:13Z
- Provider：stepfun（`https://api.stepfun.com/v1` · OpenAI **Chat Completions** `/chat/completions`）
- 模型：`step-3.5-flash`
- 使用的 User-Agent：`(default)`

> LIVE = 供应商真实返回；SIMULATED = 数据分级门禁、预算账本、分层引用验证（设计期无业务代码，随 ModelAdapter 实现复验）。仅发送合成客服文本，密钥不入库/日志/报告。

## 契约映射（LIVE，非流式）

- HTTP 200，耗时 1.497s，内容 62 字符
- 响应 id：True；request-id 头：None
- model 回显：`step-3.5-flash`（与请求一致：True）
- finish_reason：`stop`；请求 max_tokens=1200，被截断：False
- **隐藏推理正文**：`reasoning_content` 字段存在=True，292 字符（与可见正文共用同一 max_tokens 预算）
- usage 回传：**True** → {'prompt_tokens': 160, 'completion_tokens': 241, 'total_tokens': 401, 'reasoning_tokens': 0, 'cached_tokens': 64}
- 回答含资料编号引用：True

## 流式 / TTFT / 取消（LIVE）

两个 TTFT 必须分开看：`首事件` 是任意增量（含 reasoning_content）到达时刻——进度条能动的时刻；`可读答案` 是第一个可见正文 token——用户真正有字可读的时刻。推理模型下两者可能差好几秒。

| 场景 | HTTP | 首事件TTFT(s) | 可读答案TTFT(s) | 总耗时(s) | 正文增量/字符 | 推理增量/字符 | finish_reason | 流内 usage |
|---|---|---|---|---|---|---|---|---|
| 完整生成 | 200 | 0.275 | 1.452 | 1.602 | 13/62 | 75/292 | stop | 有 |
| 中途取消(5 增量) | 200 | 0.24 | 1.305 | 1.363 | 5/21 | 75/292 | None | 有 |

- 取消生效：**True**；流式回传 usage：**True**

## 结构化输出（LIVE · response_format）

**截断不等于不支持**：HTTP 200 + `finish_reason=length` + 正文 0 字，是 max_tokens 被 CoT 吃光，属 Adapter 的 token 预算问题；曾据此误判「该供应商不支持 json_object」，与 Stage C 被 429 污染同属一类假结论。故 finish_reason 单列并单独判定。

| 模式 | HTTP | 各次尝试 | 解析为 JSON | 满足 schema | finish_reason | 截断 | 正文/推理字符 | max_tokens | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| `json_schema` | 200 | [200] | True | True | stop | False | 149/292 | 1200 |  |
| `json_object` | 200 | [200] | True | True | stop | False | 130/749 | 1200 |  |

## 推理用量与 `reasoning_effort`（LIVE · 推理模型专项）

step-3.5-flash 是推理模型，隐藏 CoT 既占 `max_tokens` 又计费，直接决定 ADR-0029 的结算口径与 ADR-0027 的时延手段。

- 采样方法：每档 3 次采样；判定「生效」要求 low 的上界与 high 的下界分离（>1.5x），单样本对比会凭噪声造出结论。

| reasoning_effort | HTTP | 推理字符 min/中位/max | completion_tokens | usage 里的 reasoning_tokens | finish_reason |
|---|---|---|---|---|---|
| `(unset)` | [200, 200, 200] | 365/389/395 | [210, 190, 211] | [0, 0, 0] | ['stop', 'stop', 'stop'] |
| `low` | [200, 200, 200] | 45/45/49 | [29, 31, 29] | [0, 0, 0] | ['stop', 'stop', 'stop'] |
| `high` | [200, 429, 429] | 299/299/299 | [160] | [0] | ['stop'] |

- 返回推理正文：**True**；usage 中单列 reasoning_tokens：**False**
- `reasoning_effort` 被接受：True；**区间可分离（判定为有效）：True**（各档 CoT 字数 min-max {'(unset)': [365, 395], 'low': [45, 49], 'high': [299, 299]}）

## 时延分布（LIVE · 多次采样，ADR-0027 判定依据）

ADR-0027 以 P95 表述，单次流式生成无法裁决——同一 payload 在历史运行中测到 7.698s / 9.695s，本轮又能落到 2.5s。故按 n 次采样报区间与越界次数，并明确 n 很小。

- 样本 5/5 成功；完整生成 **1.495–2.168s**（中位 1.728s）；可读答案首字 1.346–1.964s（中位 1.547s）
- 越界次数：>3.5s（高风险预算）**0** 次；>2.0s（常规预算）**2** 次
- 口径：同一 payload 的流式完整生成，n=5；ADR-0027 以 P95 表述，n 太小只能给区间与越界次数，不能自称 P95。

| # | HTTP | 完整生成(s) | 首事件(s) | 可读答案(s) | 正文字符 | 推理字符 | completion_tokens |
|---|---|---|---|---|---|---|---|
| 1 | 200 | 2.099 | 0.294 | 1.942 | 62 | 286 | 231 |
| 2 | 200 | 1.564 | 0.247 | 1.349 | 62 | 292 | 241 |
| 3 | 200 | 1.495 | 0.267 | 1.346 | 62 | 292 | 241 |
| 4 | 200 | 1.728 | 0.279 | 1.547 | 62 | 292 | 241 |
| 5 | 200 | 2.168 | 0.267 | 1.964 | 62 | 292 | 241 |

## 错误映射（LIVE）

- 错误密钥 → HTTP 401（401：True）
- 未知模型 → HTTP 404（4xx 拒绝：True）
- 客户端超时（0.7s）→ 可归一：True（TimeoutError: The read operation timed out）

## 成本（LIVE 用量）

- **单次问答**（一次 grounded chat，含隐藏 CoT）：prompt 160 + completion 241 tokens → 0.000636 元
- 本次探针合计（下界）：prompt tokens 1280；completion tokens 2750
- 单价（元/百万 in/out）：0.72 / 2.16；估算：0.006862 元
- 单价来源：StepFun 官方英文站价目 $0.10/$0.30 per 1M in/out（cache hit $0.02），按汇率 7.2 折算为 ¥0.72/¥2.16；国内站 CNY 官方价目待以控制台为准
- 口径说明：仅统计供应商回报了 usage 的调用（结构化输出两次未逐行留存 usage，故合计为下界）；单价来自 CHAT_PRICE_CNY_PER_1M_IN/OUT，未设则为 0。**单次问答成本口径**需在 one_answer_* 之上叠加 Stage A 的查询/逐句 Embedding、Stage C 的 rerank 与高风险蕴含调用。注意 CoT 计入 completion_tokens 却不单列，无法拆分思考成本。

## 可用性（LIVE · 间歇性挂起）

- 非流式调用 13 次，其中 **0 次>90s 读超时**（挂起率 0.0），每次最多重试 3 次
- 口径：每个非流式调用最多重试 3 次；hang = 超过 90s 读超时（远超正常响应时间）。

## 模型来源（LIVE · 可信性）

- 未取得（HTTP 429）：{'error': {'message': 'request limited RPM reached, current: 11, limit: 10. Please top up at https://platform.stepfun.co

## 待决策
- 高风险 3.5s 预算本轮全部满足，但常规 2.0s 预算有 2/5 次越界（完整生成 n=5：1.495–2.168s（中位 1.728s）；可读答案首字 1.346–1.964s）：常规问答腿需按上界而非中位数设超时，且逐句 Embedding 与蕴含调用必须并发发起（ADR-0027 硬约束）。历史运行曾达 7.7-9.7s，抖动须计入选型。
- **推理内容先流完才出正文**：首个任意事件 0.275s、可读答案首字 1.452s（差 1.18s，其间只有 75 个 reasoning_content 增量）。UI 只能先显示「思考中」进度，不能把 reasoning_content 当答案渲染（未经引用校验的内容不得呈现，ADR-0027/0032）。
- **推理用量不可分摊**：`message.reasoning_content` 实测数百字，但 `usage.completion_tokens_details.reasoning_tokens` 恒为 0 —— CoT 计费折进 `completion_tokens` 却不单列。ADR-0029 账本因此无法把成本拆成「思考 vs 答案」，只能按 completion_tokens 总量结算；且 Adapter 必须把 CoT 计入 max_tokens 预留，否则正文被静默截断（实测 CoT 字数 {'(unset)': [365, 395], 'low': [45, 49], 'high': [299, 299]}）。
- `reasoning_effort` **实测有效**（各档 CoT 字数 min-max：{'(unset)': [365, 395], 'low': [45, 49], 'high': [299, 299]}，每档 3 次采样，low 上界与 high 下界分离）：可作为高风险腿压时延的候选手段，但需与「低 effort 是否降低蕴含判断质量」一并在 PROBE-006 评测，**未评测前不得为了达标 ADR-0027 而默认调低**。

## SIMULATED（服务层，随 ModelAdapter 实现复验）

- **data_class_gating**：ADR-0025：UNKNOWN/敏感等级必须在 ModelAdapter 准入层（而非调用点）阻断 Chat/Embedding/Reranker/引用验证四条路径。设计期仓库无业务代码，本探针只发送合成文本，门禁为 SIMULATED，随 ModelAdapter 实现的集成测试复验。
- **budget_ledger**：ADR-0029：调用前在同一 PostgreSQL 事务写入 RESERVED 并取 lease，结算写回实际用量并释放差额，流式取消按已产生 token 结算，进程被杀后 lease 过期回收。无 DB/业务代码，SIMULATED；本探针 LIVE 记录真实 usage 与取消时已产生的增量，供预扣/结算口径校准。
- **citation_verification**：ADR-0027 分层引用验证（2026-08-26 修订后：常规 P95<=2.0s / 高风险含蕴含调用 P95<=3.5s，且逐句 Embedding 与蕴含调用必须并发发起）依赖逐句 Embedding 批量 + 高风险蕴含调用，属独立测量，需与 Stage A 的批量延迟曲线合并计算，本 stage 未单独压测。
- **provider_governance**：StepFun（阶跃星辰）是第一方模型厂商而非中转站，但仍是数据路径上的外部处理方，可能记录/留存 prompt。探针仅合成文本可接受；生产承载真实客服数据前必须评估留存与合规，否则冲突 ADR-0017/0025「敏感数据不出域」。