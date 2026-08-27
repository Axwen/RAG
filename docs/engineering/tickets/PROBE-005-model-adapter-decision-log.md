# PROBE-005：云模型供应商决策日志

> 本文件只保留供应商切换、重复运行和方法勘误。当前可执行契约与通过标准见 [PROBE-005-model-adapter.md](PROBE-005-model-adapter.md)；当前供应商事实以 ADR-0017 和探针结果索引为准。

## 目的

验证 OpenAI-compatible ModelAdapter 对 Chat、Embedding、Reranker、引用验证、结构化输出、流式取消、错误映射、数据分级门禁和预算账本预扣的真实行为，并实测引用验证分层预算与单次成本口径。

## 供应商拓扑与维度决策（2026-08-25，用户拍板）

MVP 不以百炼为云模型；`ModelAdapter` 的 OpenAI 兼容边界吸收多供应商（模型名/地域/base/超时/路由均走环境配置，不入领域模型）。当前基线不是单一供应商：Embedding/Reranker 使用 OpenRouter，Chat/高风险蕴含使用 fluxionai Responses API。具体契约以 [ADR-0017](../../adr/0017-mvp-cloud-model-and-budget.md) 和当前主结果为准。

- **Embedding（已定并已实测）**：OpenRouter `qwen/qwen3-embedding-8b`，`POST {base}/embeddings`。原生 4096 维，**用 MRL `dimensions=1024` 对齐 PROBE-003 已冻结的 1024/cosinesimil 索引契约**。PROBE-006 已用 1024 维真实 Embedding 完成小规模 Recall@5 并冻结 `wide-1024`；本轮没有执行同语料 4096 维对照，因此不能宣称 1024 维相对原生维度无召回损失。Stage A 已执行 → `PASS_WITH_ADJUSTMENT`，见 `../probe-results/probe-005-model-adapter.md`。
- **Chat / 高风险蕴含（已定并已实测）**：fluxionai `gpt-5.6-terra`，OpenAI Responses API；真实计费。base + key 仅经环境变量注入。
- **Reranker（已定并已实测，2026-08-26 用户提议 `qwen/qwen3-reranker-8b`）**：OpenRouter `qwen/qwen3-reranker-8b`（上游 Fireworks），Cohere 形状 `POST {base}/rerank`，**与 Embedding 同一 base、同一密钥**。原文「OpenRouter 无 rerank 端点」是错误前提，已在 Stage C 证伪并更正 ADR-0017：先用 401-vs-404 路由判别（真实路由无密钥返 401，伪造路径返 404）在**零费用**下确认路由存在，再以一次最小计费调用确认模型可用。Stage C 已执行 → `PASS_WITH_ADJUSTMENT`，见 `../probe-results/probe-005-model-adapter-rerank-openrouter.md`。
- ⚠️ **数据治理提示**：OpenRouter 是数据路径上的**额外第三方处理方**，可能记录/留存 prompt。探针仅发送合成文本可接受；**生产环境承载真实客服数据前，必须评估其留存与合规风险**，并据此更新 ADR-0017 / 新增多供应商数据流 ADR。
- **密钥纪律**：key 只从 `OPENROUTER_API_KEY` 环境变量读取（可由仓库外的未跟踪 env 文件注入，见 `scripts/probes/run-probe-005-embedding.sh`），不入仓库、日志、报告，不作为命令行参数传递。

## 历史：Chat 供应商决策（2026-08-25 起）

首个候选 `https://agentrouter.org/v1`（model `gpt-5.6-sol`）Stage B 实测 **BLOCKED，判定为供应商不适配（非探针失败）**。受控排查三条硬事实：

1. **非 OpenAI 兼容**：`/chat/completions` 任何 UA 都 401/超时；实际是 `/v1/messages`（Anthropic Messages 协议）。与 ADR-0017「OpenAI 兼容边界」前提冲突。
2. **以 `User-Agent: claude-cli/*` 做准入门禁**：非 Claude CLI 客户端一律 401。**服务端（NestJS/worker）无法在不伪装 CLI 身份下调用** —— 而伪装既脆弱又疑似违反 ToS，不应写入企业架构。
3. **模型标识不可信**：标称 `gpt-5.6-sol`、自称 "ChatGPT"、响应却是 Anthropic 格式，无法核验真实承载模型与提供方。对「可信 RAG」是硬伤。

**建议**：Chat 改用合法的 OpenAI 兼容供应商。最省事的是 **OpenRouter**（Stage A 已用它做 embedding，chat/completions 原生兼容、可审计、`usage` 规范），只需一个真实 chat model id；或官方直连（OpenAI/Anthropic/Azure）。探针脚本 `scripts/probes/probe_005_chat.py` 供应商中立，换 `--base/--model` + `CHAT_API_KEY` 即可复跑，无需改代码。

## 历史：Chat 协议改用 Responses API（2026-08-26）

用户指示 Chat 腿改走 OpenAI **Responses API**（`POST {base}/responses`）。据此新增供应商中立探针 `scripts/probes/probe_005_responses.py` + wrapper `run-probe-005-responses.sh`，并对 agentrouter.org 复跑。**结论翻转：Chat Completions 腿 BLOCKED，Responses 腿 `PASS_WITH_ADJUSTMENT`** —— 该中转站确实实现了 Responses 协议，`/chat/completions` 只是没实现。

Responses 与 Chat Completions 的契约差异（ModelAdapter 需吸收）：

| 关注点 | Chat Completions | Responses |
|---|---|---|
| 系统提示 | `messages[0].role=system` | 顶层 `instructions` |
| 用户输入 | `messages[]` | 顶层 `input` |
| 输出长度 | `max_tokens` | `max_output_tokens` |
| 取正文 | `choices[0].message.content` | `output[].content[].type=="output_text"` |
| 结构化输出 | `response_format` | `text.format`（`json_schema`/`json_object`） |
| 用量 | `usage.prompt_tokens/completion_tokens` | `usage.input_tokens/output_tokens`（含 `reasoning_tokens`、`cached_tokens`） |
| 流式 | 匿名 delta chunk | **具名事件**（`response.output_text.delta` / `response.completed` …） |
| 终止态 | `finish_reason` | `status`（`completed`/`in_progress`/`incomplete`） |

**ADR-0017 的「OpenAI 兼容边界」必须由 `chat/completions` 放宽为「OpenAI 兼容（Chat Completions 或 Responses 二者之一）」**，并在 ModelAdapter 内保留一层协议方言开关；这是本探针要求的 ADR 修订项。

实测详见 `../probe-results/archive/probe-005-supplier-evaluations/probe-005-model-adapter-responses-agentrouter.md`。Responses 腿的关键 LIVE 事实：

- 契约、`usage`（input/output/total + reasoning/cached）、响应 id、request-id 头齐备 → 预算账本可按真实 token 结算。
- **流式取消可行**：具名事件流可数 delta，中途断连即停；完整生成回传 usage → ADR-0029「取消按已产生 token 结算」成立（取消瞬间 `status=in_progress` 且流内暂无 usage，需 Adapter 本地按已收增量计量）。
- **结构化输出 `text.format` 的 `json_schema`(strict) 与 `json_object` 均真实生效**（解析 + schema 校验双过），不是被静默忽略 → 不会把未校验响应交给 Answer/Citation。
- 答案真实带 `[D1]/[D2]` 引用编号。

仍未解决的四个硬项（与协议无关，属供应商本身）：

1. **UA 准入门禁依旧**：只有 `User-Agent: claude-cli/*` 得 200，curl/OpenAI-SDK/默认 urllib 全 401。服务端无法在不伪装 CLI 身份下调用 → 仍不可进生产。
2. **不传 `instructions` 时端点注入自有 system prompt**（实测 21334 字符的 Codex agent 提示词）。显式传入 `instructions` 可完全覆盖 —— **ModelAdapter 必须始终显式传入，禁止依赖端点默认值**，否则 grounded-answer 提示词被污染。
3. **模型身份仍不可核验**：请求/回显均 `gpt-5.6-sol`，模型自称 **"GPT-5 Codex"**。
4. **可用性不足**：**6 次非流式调用中 2 次超过 90s 读超时（挂起率 0.333）**，同类请求正常 5-9s；TTFT ≈ 2.6-5.3s。挂起是间歇性的，会让同一份探针在不同运行间给出 `PASS_WITH_ADJUSTMENT`/`BLOCKED` 两种结论（实测发生过），因此探针已对每个非流式调用重试 3 次并单列挂起率，且把「端点挂起」与「格式被静默忽略」在判定里分开——只有后者是协议缺陷。交互式问答必须走流式，ADR-0027 当时的高风险 P95<=1.5s 在此供应商不可达（该目标已于 2026-08-26 按实测修订为 3.5s）。

**净结论**：**协议问题已解决（Responses 可用），供应商问题未解决**。`probe_005_responses.py` 供应商中立，换 `CHAT_BASE/CHAT_MODEL/CHAT_API_KEY`（并把 `CHAT_USER_AGENT` 置空）即可对官方 OpenAI 或其他 Responses 兼容供应商复跑定档。

## 当前基线与历史变更：fluxionai.space（2026-08-26）

用户指定 Chat base 改为 `https://fluxionai.space/v1`，环境变量后续提供。据此已调整探针默认值，**未做任何网络调用**（缺 key/model 时脚本 exit 3，零费用）：

- `CHAT_BASE` 默认 `https://fluxionai.space/v1`，`CHAT_PROVIDER` 默认 `fluxionai`。
- **`CHAT_USER_AGENT` 默认置空**（普通 urllib UA）—— 这才是 NestJS/worker 真能发出的 UA。agentrouter 的 `claude-cli` UA 门禁只作为发现记录，不进架构。
- **`CHAT_MODEL` 改为必填**：一个供应商的 model id 在另一个 base 上无意义，猜一次就白烧一次真实计费调用。
- 报告文件名按供应商分片（`probe-005-model-adapter-responses-<provider>.md/.json`），新供应商不覆盖 agentrouter 的既有事实记录 —— 供应商横向对比正是 ADR-0017 定档所需。

待用户提供 `CHAT_MODEL` 与 `CHAT_API_KEY` 后，复跑 `scripts/probes/run-probe-005-responses.sh` 即可对 fluxionai 定档。需重点复核的正是 agentrouter 未过的四项：UA 门禁是否存在、是否注入自有 system prompt、模型身份是否可核验、挂起率/TTFT 是否满足 ADR-0027。

### fluxionai + `gpt-5.6-terra` 实测（2026-08-26，两次独立运行一致）

状态 **PASS_WITH_ADJUSTMENT**，报告 `../probe-results/probe-005-model-adapter-responses-fluxionai.md`。**agentrouter 的两个致命项在此消失**：

| 关注点 | agentrouter | fluxionai + gpt-5.6-terra |
|---|---|---|
| UA 准入门禁 | 仅 `claude-cli/*` 得 200 | **无门禁**：默认 urllib UA 直接 200 → 服务端可合法直连 |
| 挂起率（非流式 >90s） | 2/6 = 0.333 | **0/6 = 0.0**（另一次 0/4） |
| 非流式单次 | 9.4s | **2.8-3.3s** |
| 流式 TTFT | 5.28s | **1.82-2.22s** |
| 未知模型 | 503（非 4xx） | **404**，可正常归一 |
| strict `json_schema` | 200 + schema 通过 | 200 + schema 通过 |
| `json_object` | 200 + schema 通过 | **500 `upstream_error`（3 次尝试全 500，另有补测 502/502/timeout）** |
| 流式取消 | 生效 | 生效（取消瞬间 `status=in_progress`、流内无 usage，同 agentrouter） |
| 完整生成回传 usage | 有 | 有（`input/output/total` + reasoning/cached） |
| 注入自有 system prompt | 21334 字符 Codex 提示词 | **21488 字符，同一份 Codex 提示词** |
| 模型身份 | 请求/回显 `gpt-5.6-sol`，自称 "GPT-5 Codex" | 请求/回显 `gpt-5.6-terra`，**自称 "GPT-5"** |

剩余待决策（均已进报告）：

1. **结构化输出方言能力必须按供应商登记**：此供应商只能走 `text.format.json_schema`(strict)，**不得把 `json_object` 当降级回退**（确定性 500/502，不是偶发抖动）。补测另证：不加 `text.format`、只用 `instructions` 要求输出 JSON 时 3/3 返回可解析 JSON —— 但那条路没有服务端 schema 保证，仍以 `json_schema` 为唯一结构化通道。能力无损失（`json_schema` 更强）。
2. **ADR-0027 高风险 P95<=1.5s 不可达 → 已拍板放宽并原地修订（2026-08-26）**：TTFT 1.82-2.22s，单次完整生成 2.9-3.0s。用户选择「放宽时延目标」而非「高风险腿改配非推理模型」。ADR-0027 现为常规 **P95 ≤ 2.0 s**（依据 Stage A 批量 Embedding 1.04-1.41s）、高风险 **P95 ≤ 3.5 s**，并新增硬约束：**逐句 Embedding 批量调用与蕴含校验调用必须并发发起**（串行实测下界 1.4s + 3.0s ≈ 4.3s，必然超 3.5s）。
3. **必须始终显式传 `instructions`**：不传则被注入 21488 字符 Codex agent 提示词（与 agentrouter 同一份，暗示同源上游），显式传入可完全覆盖。
4. **模型身份不可核验**：`gpt-5.6-terra` 自称 "GPT-5"。可信 RAG 需供应商出具模型映射说明；否则生产环境的「承载模型可审计」这一条不成立。
5. **SSE 事件流含无关事件**：纯文本响应里出现一个 `response.audio.transcript.delta` → Adapter 的事件解析必须白名单化，忽略未知/无关事件，不得因未知事件类型报错。
6. **数据治理不变**：仍是数据路径上的第三方处理方，承载真实客服数据前需评估留存/合规（ADR-0017/0025）。

## 历史候选：Chat 供应商换为 StepFun（阶跃星辰）（2026-08-26）

用户指定用 StepFun 替代 fluxionai 作为 Chat 供应商。关键发现改变了协议腿：

- **StepFun 没有 OpenAI Responses API**。其开放平台只提供 OpenAI 兼容 **Chat Completions**（`POST {base}/chat/completions`）与 Anthropic 兼容 **Messages**（`/step_plan`）两种形状。因此 Chat 腿从 `/responses` 切回 **`/chat/completions`**，用户拍板走 Chat Completions（改动最小，复用现有 OpenAI 形状）。这恰好印证 ADR-0017 已把「OpenAI 兼容边界」放宽为「Chat Completions 或 Responses 二者之一」的正确性——StepFun 落在 Chat Completions 一侧。
- **StepFun 是第一方模型厂商而非中转站**（上海，自研 Step 模型族）。这直接针对 agentrouter/fluxionai 未过的两项治理硬伤：**模型身份可核验**（自研 step-* 模型，非匿名上游）、**预期无注入的 Codex agent 提示词**（那是中转站产物）。探针会实测复核而非假设。
- **base = `https://api.stepfun.com/v1`**（国内平台；`.ai` 为国际站）；**model = `step-3.5-flash`**（用户选定，文本推理，196B/11B active、256K；最终以 `{base}/models` 白名单为准）。

据此已重写 `scripts/probes/probe_005_chat.py` 与 `run-probe-005-chat.sh`，**把 responses 腿的全部严谨性回填到 chat 腿**（此前 chat 探针远弱于 responses 探针），**未做任何网络调用**（缺 key/model 时脚本 exit 3，零费用；已实测）：

- `CHAT_BASE` 默认 `https://api.stepfun.com/v1`，`CHAT_PROVIDER` 默认 `stepfun`，密钥另接受 `STEPFUN_API_KEY`。
- **`CHAT_MODEL` 必填**（缺则 exit 3）；**`CHAT_USER_AGENT` 默认置空**（普通 urllib UA）。
- **凭据预检**：首个最小调用返回 401/403 即 exit 3 且**不写报告**——401 不是供应商结论，不能记成 BLOCKED。
- **每个非流式调用重试 3 次 + 全局挂起率统计**；结构化输出对 5xx 也重试（把「端点挂起」与「格式被静默忽略」分开判定）。
- **报告按供应商分片**：`probe-005-model-adapter-chat-<provider>.{md,json}`；旧的 agentrouter chat 运行已改名为 `-agentrouter` 保留，不被覆盖。
- 判定逻辑对齐 responses 腿：ADR-0027 时延（完整生成 >3.5s / TTFT >2.0s 触发待决策）、结构化输出方言能力登记、模型身份一致性（step-* 或「阶跃」视为一致）、可用性挂起率。

已对 StepFun 完成 LIVE 运行（见下两节）。探针另新增两个开关，供正式定档使用：`CHAT_REASONING_EFFORT`（把 `reasoning_effort` 固定进每个 payload，并记进报告——产品实际会发什么，探针就该测什么）与 `CHAT_RPM`（安全默认 8，低于实测账号 10 RPM 上限，并带 429 退避重试）。按既定 3.5 s 门禁，本轮**不把 `ADR-0017` 的 Chat 基线由 fluxionai 迁到 StepFun**：StepFun 解掉了中转站的两项治理硬伤，但时延尾部尚未满足验收目标（见下）。

### StepFun 契约实测结论（`step-3.5-flash-2603` + `reasoning_effort=low`，2026-08-26，两次独立运行一致）

按两次独立运行的惯例执行（`CHAT_REASONING_EFFORT=low`、`CHAT_RPM=8`，各 13 次非流式调用），两轮**判定与每一项契约结论完全一致**：`PASS_WITH_ADJUSTMENT`。报告位于 `../probe-results/archive/probe-005-supplier-evaluations/`。

| 检查项 | run1（07:35Z） | run2（07:45Z） | 判定 |
|---|---|---|---|
| 挂起率（>90s 读超时） | 0/13 | 0/13 | **通** —— 对比 agentrouter 0.333 |
| 吸收的 429 | 0 | 0 | 限速 RPM=8 生效，样本干净 |
| 非流式契约调用 | 200 / 2.111 s | 200 / 2.273 s | model 回显一致、`usage` 齐备、`finish_reason=stop` |
| `x-request-id` 头 | 无 | 无 | **可审计标识只能取响应体 id** |
| 流式：首个任意事件 / 可读正文 / 完整 | 0.394 / 1.855 / 1.981 s | 0.305 / 1.918 / 2.078 s | 两轮一致：中间约 1.6 s 只有 CoT 在流 |
| 流式 `reasoning_content` 增量数 | 79 | 79 | 完全一致 |
| 流式 usage（`include_usage`） | 有，`cached_tokens: 64` | 有，`cached_tokens: 64` | ADR-0029 可按流式 usage 结算 |
| 流式取消 | 生效，5 个增量后断开并回传 usage | 同 | 取消侧计量可行（ADR-0029 按已产出 token 结算） |
| `json_schema`（strict） | 通过、schema 校验通过 | 同 | **真生效**，非静默忽略 |
| `json_object` | 通过 | 同 | **两种方言都可用**（对比 fluxionai `json_object` 确定性 500） |
| 错误映射 | 错误密钥 401、未知模型 404、超时可映射 | 同 | Adapter 可按状态码分类，无需猜 |
| 模型身份 | 回显 `step-3.5-flash-2603`，自称「Step」，一致 | 同 | **第一方厂商身份可核验**——agentrouter/fluxionai 未过的项 |
| 注入自有 system prompt | 无（未观察到中转站式提示词） | 同 | 对比 agentrouter/fluxionai 各注入约 21k 字符 Codex 提示词 |
| ADR-0027 高风险 3.5 s（n=5） | 1.952–3.061 s，中位 2.665，**0 次越界** | 2.049–3.236 s，中位 2.39，**0 次越界** | 本轮满足；但见 A/B 合并分布的尾部 |
| ADR-0027 常规 2.0 s（n=5） | 4/5 越界 | 5/5 越界 | **常规腿超时按上界设，Embedding 与蕴含调用必须并发** |
| `reasoning_tokens` 单列 | 恒为 0 | 恒为 0 | **CoT 折进 `completion_tokens` 不单列** |
| 单次问答成本 | ¥0.000633（165 in + 238 out） | 未传单价，未估算 | 见 A/B 节的成本与缓存结论 |

三项**只有契约探针能给**的结论：

1. **`reasoning_tokens` 恒为 0，而 `reasoning_content` 实测数百字** → ADR-0029 账本**无法把成本拆成「思考 vs 答案」**，只能按 `completion_tokens` 总量结算；且 Adapter 必须把 CoT 计入 `max_tokens` 预留，否则正文被静默截断（旧版报告里 `max_tokens=64` 就把身份问询的正文整段吃掉，被误读为「身份不可核验」）。
2. **两种结构化输出方言都真生效**，与 fluxionai 形成对照（那边 `json_object` 确定性 500）→ 供应商能力登记表里 StepFun 这一行没有缺口，**不必把 `json_object` 当降级回退去赌**。
3. **模型身份与提示词治理两项都过**：回显与自述一致、无第三方注入。这正是 agentrouter（自称 GPT-5 Codex）与 fluxionai（`gpt-5.6-terra` 自称 GPT-5）未过的项。

**已作废的两条旧判定（保留原报告 + 勘误，不静默覆盖）**：

- 旧版 `step-3.5-flash` 两次运行：未限速/截断参数导致部分样本失真；仅保留 `reasoning_effort` 能力差异作为历史旁证，原始文件已移入供应商归档。
- 方法论：**我方运行条件（限流、截断、预算不足、凭据失败）永不记作供应商契约裁决**——这条已写进 ADR-0017 第 3 节，两次都是靠它才没把假结论留在档里。

### `step-3.5-flash-2603` + `reasoning_effort` A/B 实测（2026-08-26，用户指定切换）

用户把 Chat 模型切到 `{"model": "step-3.5-flash-2603", "reasoning_effort": "low"}`，并要求**不凭供应商说明认定达标**：同一请求对比 `low` 与 `high`，每档 ≥20 次，记录首个任意流事件、首个可见正文、完整响应时间、completion tokens、回答及引用正确率；**验收目标 = `low` 档完整响应 p95 ≤ ADR-0027 高风险预算 3.5 s**。

新增专用仪器 `scripts/probes/probe_005_chat_effort_ab.py` + `run-probe-005-chat-effort-ab.sh`。**为什么另起一个脚本**：契约探针回答「契约成不成立」，而时延预算是**分布问题**，需要不同的仪器（同一 payload 曾在不同时段测到 9.695 s 与 1.495 s，任何单次调用都无权裁决 p95）。方法上四条刻意设计：

1. **两档交错发起**，不分块跑。供应商负载按分钟级漂移，先 20 次 low 再 20 次 high 会把漂移算成参数效果。
2. **四个时钟**：首个任意流事件（进度条可动）/ 首个可见正文（用户有字可读）/ 完整生成（ADR-0027 预算）/ completion tokens（ADR-0029 成本）——四者回答不同问题，混为一谈就会得出「TTFT 1.9 s」这种既非进度也非预算的数。
3. **质量与时延同表**：为压时延而调低推理，只有在答案与引用不退化时才算赢，故每条样本都按 fixture 的两个事实（签收后 7 天可退款、退货运费由商家承担）与引用编号机械判分。
4. **按账号 RPM 上限限速 + 429 退避重试**，且 429 从不作为样本。

#### 实测结果（`low` / `high` 各 20 次 × 2 轮独立运行 = 每档 40 样本）

| 指标 | `low` | `high` |
|---|---|---|
| 完整生成 p50 | **2.05 s** | 1.882 s |
| 完整生成 p90 | 3.245 s | 3.002 s |
| 完整生成 **p95（合并 40 样本）** | **3.752 s** | 3.965 s |
| 完整生成 max | 6.969 s | 10.967 s |
| >3.5 s 次数 | 4/40 | 3/40 |
| >2.0 s 次数 | 25/40 | 16/40 |
| 可读正文首字 p50 / p95 | 1.834 s / 3.52 s | 1.685 s / 3.839 s |
| **首个任意流事件 p50** | **0.313 s** | 0.292 s |
| CoT 字数 min–max（中位） | 189–424（295） | 288–465（295） |
| completion tokens 均值 | 246.2 | 254.2 |
| **答案正确率** | **1.0（40/40）** | **1.0（40/40）** |
| D1+D2 引用率 | 1.0 | 1.0 |
| finish_reason=length | 0 | 0 |
| 单次成本 | **¥0.00064** | ¥0.00067 |

单次运行的 p95 分别是 **2.308 s（run1）与 5.668 s（run2，两轮相隔 6 分钟）**——这正是「p95 不能只跑一次」的直接证据，故定档以合并分布为准，不取有利的那一轮。报告位于 `../probe-results/archive/probe-005-supplier-evaluations/`（`--pool-from` 为离线合并模式，零调用零费用）。

#### 五项结论（结论 2 已按后续契约运行的对照证据收窄）

1. **验收目标未达标（合并分布）**：`low` 档 p95 **3.752 s > 3.5 s**，4/40 超预算，最坏 6.969 s。**中位数很好（2.05 s），问题全在尾部**：run2 的第 11–20 次迭代 p50 从 1.92 s 劣化到 3.112 s，即端点在持续负载/时段推移下尾部变差。**因此不能以「更快」为由直接替换旧版并宣布无需再放宽预算**；但也不建议再放宽 ADR-0027——正确的落点是**在 Adapter 侧治理尾部**（超时+重试或对冲请求；p90 仍为 3.245 s，尾部与主体分离明显），并在 PROBE-006 用真实语料复测。
   **冷却判别实验**：空转 5 分钟后按 RPM=6 只跑 12 次 `low`，12/12 落在 **2.26–3.036 s**（p50 2.371 s、p95 3.036 s，**0 次越 3.5 s**）。即那条 >3.5 s 的尾巴**与我方持续负载相关**（疑似按吞吐的软限流），不是端点的固定属性——同一 payload 同一账号，冷却后就没有尾巴。这对 Adapter 是好消息（尾部可用限流/排队/对冲治理），但 n=12 且与时段混淆，**不足以据此宣布验收达标**，正式定档仍以合并 40 样本为准。报告位于 `../probe-results/archive/probe-005-supplier-evaluations/`。
2. **`reasoning_effort` 被接受，但在本 RAG 负载上拧不动**（这是个被**收窄过**的结论，原稿曾写成「在 `-2603` 上实测无效」，证据不支持那么宽）：在 grounded 引用 fixture（max_tokens=1200）上两档 CoT 字数分布完全重叠（189–424 vs 288–465，中位 295 vs 295）、completion tokens 仅差 3.2%、`low` 的完整生成 p95 甚至不优于 `high`；但**同一模型**的契约探针 `reasoning_accounting` 检查在**琐碎短问题**（「只回答模型名称」）上测到 `low` CoT **45–48 字符 / 29–32 completion tokens、0.72–0.83 s**，对 `high` 的 **295–588 字符 / 160–302 tokens、1.89–4.84 s**，差异极大。
   两个测量不矛盾，合起来才是真结论：**任务自身的推理需求给 CoT 设了地板，`low` 只是上限而非目标**；本引用任务的地板（约 300 字符）已高于 `low` 的上限，所以旋钮在这里没有余量可拧。→ **不得把 `reasoning_effort=low` 当作 RAG 答案腿的压时延手段**（在真实负载形态上无可测收益），时延必须靠超时/重试/对冲与模型选择解决；默认仍传 `low`（无害、成本略低，且对简单问答确有收益），而**升档到 `high` 也不是质量手段**（本 fixture 两档均 40/40 全对）。旁证：旧版 `step-3.5-flash` 上该参数同样有效（low CoT 45–49 字符 vs high 299，历史结果见供应商归档）——**参数支持没变，变的是任务难度是否触到它**。
3. **新增容量约束：该账号档位 RPM = 10**（`request limited RPM reached, current: 11, limit: 10`，无 `retry-after` 头）。首次未限速的 A/B **40 个样本里 31 个被 429 吃掉**，只剩 5 个幸存者——若照此出结论就是幸存者偏差。**429 属我方发起速率，永不作为供应商契约裁决**（与 Stage C reranker 同一条方法论）。生产侧需按并发问答量核算配额，Adapter 内做排队/退避与降级；探针现内建 RPM 限速与 429 退避，且合并判定前先检查样本完整性（可用样本 <80% 直接作废时延判定）。
4. **推理内容先流完才出正文**：首个任意流事件 **0.313 s**，可读正文首字 **1.834 s** —— 中间约 1.5 s 只有 `delta.reasoning_content` 在流。UI 只能显示「思考中」进度，**不得把 `reasoning_content` 当答案渲染**（未经引用校验的内容不得呈现，ADR-0027/0032）。两档此间隔一致，非参数可调。
5. **成本与缓存**：单次问答 ¥0.00064（prompt 165 + completion 246 tokens，单价 $0.10/$0.30 per 1M 折 ¥0.72/¥2.16）；**40/40 次都命中 `cached_tokens: 64`**（system prompt 前缀缓存）→ ADR-0029 结算须按缓存命中价分档，否则高估输入成本。Chat 腿在单次预算里远非大头（Stage C 的 1024 候选 rerank 单次 ¥0.1587 才是）。

## Stage A（Embedding）实测结论（2026-08-25 已执行）

LIVE 事实（详见 `../probe-results/probe-005-model-adapter.{md,json}`）：

- 原生维度 **4096**；`dimensions=1024` 生效并返回 1024 维，**与 PROBE-003 冻结契约一致**。
- 向量**已 L2 单位归一化**（范数 1.0）→ `cosinesimil` 与 `innerproduct` 等价，PROBE-003 选的 `cosinesimil` 安全，无需改。
- 批量 1/4/8 条延迟约 1.04 / 1.41 / 1.37 s，**顺序按 `index` 保持**；`usage.total_tokens` LIVE 可用，可直接作为预算账本结算口径。
- 错误密钥 → HTTP 401，可归一。
- **待决策 1**：>32 条批量**未被供应商拒绝**（返回 200）→ 批量上限保护必须做在 ModelAdapter 侧，不能依赖供应商。
- **证据边界**：原生 4096 vs 冻结 1024 的同语料召回差距尚未测量；PROBE-006 的 Recall@5 评测使用已冻结的 1024 维路径，足以支持阶段 1 采用 1024 维，但不代表生产规模或 4096 维对照基线。
- SIMULATED（无业务代码，随实现复验）：ADR-0025 数据分级门禁、ADR-0029 预算账本预扣/结算/回收。

## Stage C（Reranker）实测结论（2026-08-26 已执行）

驱动：`scripts/probes/probe_005_rerank.py` + `run-probe-005-rerank.sh`（供应商中立，换 `--base/--model` 即可复跑）。报告：`../probe-results/probe-005-model-adapter-rerank-openrouter.{md,json}`。结论 **`PASS_WITH_ADJUSTMENT`**。

方法上的两处刻意设计（避免自欺）：

1. **零费用先证伪前提**：ADR-0017 原文断言 OpenRouter 无 rerank 端点。`/api/v1/models`（417 个模型）里既无 rerank 也无 embedding，故模型列表不能作为证据；改用 401-vs-404 路由判别——`POST /api/v1/rerank` 无有效密钥返 **401**，而 `POST /api/v1/definitely-not-a-real-endpoint-xyz` 与 `/foo/bar` 返 **404**——在未花一分钱前证明该路由真实注册，之后才发起计费调用。
2. **gold 置于候选末位**：若把黄金文档放在首位，一个只回显输入顺序的假 reranker 也会「命中」。全部排序质量用例把 gold 放最后一位，gold@1 = **1.0（3/3）**，分差 0.41 / 0.99 / 0.98。

LIVE 事实：

- 契约：HTTP 200 / 0.89 s，`results[].{index, relevance_score, document}` 齐备、分数降序、index 不越界；有响应 id（`gen-rerank-…`）但**无 `x-request-id` 头**；`usage` 直接返回 `total_tokens` 与美元 `cost`。
- 候选规模（PROBE-003 冻结上限 1024 是必须承受的值，不是任意压力点）：8 / 64 / 256 / 1024 → **0.89 / 0.95 / 1.45 / 3.4-6.6 s**（1024 四次运行 3.36 / 3.46 / 3.49 / 6.61 s），成本 **¥0.0012 / 0.0099 / 0.0397 / 0.1587**（汇率假设 7.2），各档 gold@1 均 True。
- `top_n=3` 生效；6042 字符长候选不被截断且仍为 top1；错误密钥 → 401，未知模型 → 400（消息明确），空 `documents` → 400。
- **待决策 1（新的产品级取舍）**：满额 1024 候选 rerank 单次 ¥0.1587，仅此一项就把 ADR-0029 每日 16 元压到约 **100 次问答/日**；而 64 候选只需 ¥0.0099 / 0.95 s。**「融合候选上限 1024」不等于「rerank 输入规模」**，两者必须分开冻结。T1a 的开发种子 Manifest 显式写 **N=64**，不允许环境变量覆盖；T6 在真实业务语料下比较 N 后再拍板正式值。
- **待决策 2**：2048 条候选（冻结上限的 2 倍）**未被供应商拒绝**（HTTP 200，6.62 s，¥0.32）→ 与 Embedding 腿同一结论，候选上限保护必须做在 Adapter 侧。
- **待决策 3**：`return_documents=false` **不生效**（响应仍回显全部候选正文）→ 大候选集下响应体积与日志脱敏风险归 Adapter，回显正文禁止入日志。
- **待决策 4**：大候选调用会触发 **HTTP 429 且不带 `retry-after` 头**；429 不返回 `usage`（属零成本拒绝）。检索链路必须把 429 当常规分支处理：退避重试 + 截断候选数降级。**探针自身因此对所有调用统一做 429 退避**——未做退避的那次运行（03:34Z）里，紧随 1024 大调用之后的 `top_n` 与 `return_documents` 两项检查被 429 污染，一度得出「top_n 不生效」的错误结论，这也是「限流不是供应商契约裁决」必须写进 Adapter 约束的直接证据。
- 单次完整探针运行的真实花费 $0.0747 ≈ ¥0.54（供应商直接返回的 `cost` 汇总）。
- SIMULATED（随实现复验）：ADR-0025 数据分级门禁在 rerank 路径同等适用；ADR-0029 预扣/结算/回收；融合候选构造与 Top5 截断、ACL 权威复核属 PROBE-003/T6 范围。

## 历史决策日志（原始目的与过程记录）

原 ModelAdapter 内部边界、错误映射、取消、数据门禁和预算账本机制均保留，仅云侧供应商按上表替换。

## 当前依据

- [ADR-0017](../../adr/0017-mvp-cloud-model-and-budget.md)
- [ADR-0025](../../adr/0025-data-class-routing-enforcement-point.md)
- [ADR-0027](../../adr/0027-tiered-citation-verification-budget.md)
- [ADR-0029](../../adr/0029-model-budget-ledger-and-limits.md)
- 技术设计方案第 4、11、12、13 节
- 工程评审闭合记录第 14、15 节和 F-15、F-24

## 输入与边界

- 仅使用合成或严格脱敏短文本。
- Chat、Embedding、Reranker 和引用验证的实际模型与 base 通过环境变量提供。
- 单次 <= 5 元、每日 <= 16 元、月度 <= 500 元；交互池 350、评测池 100、应急 50 元。
- 不把供应商 SDK 类型泄漏到业务模块。
- 逐句验证 Embedding 必须合并为一次批量调用；单次预算口径包含 Chat、查询 Embedding、逐句验证 Embedding 和高风险蕴含调用之和。

## 必须验证

1. Chat、Embedding、Reranker 的请求/响应能映射到内部契约，模型名称和错误码可审计。**已实测三腿均成立**；Reranker 为 Cohere 形状 `results[].{index,relevance_score,document}`，但**无 `x-request-id` 头**（只有响应体 id），可审计标识以响应 id 为准。
2. Embedding 维度、批量大小、超时和限流行为可测量；逐句批量 Embedding 的真实延迟随句数的变化曲线。
3. Chat 流式输出能取消，断流、超时、限流和供应商错误能归一化。
4. 结构化输出失败时返回受控错误，不把未校验响应交给 Answer/Citation。
5. `UNKNOWN`/敏感等级在 Chat、Embedding、Reranker 和引用验证四条路径都被阻断，且阻断发生在 ModelAdapter 准入层而非调用点。
6. 预算账本在调用前于同一 PostgreSQL 事务内写入 `RESERVED` 并取得 lease；超过单次/每日/月度/池上限时不再发起供应商请求；结算写回实际用量并释放差额；流式取消按已产生 token 结算；进程被杀后 lease 过期能回收额度。
7. 引用验证常规路径与高风险路径（含一次蕴含调用）的真实可达性；不可达时给出建议数值。**已实测：原 600 ms / 1.5 s 均不可达，ADR-0027 已按实测冻结为 2.0 s / 3.5 s（含并发硬约束）。**
8. 一次典型高风险问答的真实总费用，用于校验单次 <= 5 元与每日 16 元是否留有余量。**Reranker 已实测为该口径中最大单项（1024 候选 ¥0.1587 → 每日 16 元约 100 次问答）；rerank 输入规模 N 待拍板。**
9. 记录 TTFT、完整生成、Embedding 批量、Reranker 延迟、错误率和真实费用。**Reranker 延迟曲线已实测：8/64/256/1024 候选 → 0.89/0.95/1.45/3.4-6.6 s；须作为检索链路独立计时项，不计入 OpenSearch 250 ms 预算。**

## 产出

- `probe-005-model-adapter.md`（Stage A · Embedding）
- `probe-005-model-adapter.json`
- `archive/probe-005-supplier-evaluations/`（agentrouter 与 StepFun 历史供应商证据、重复运行和事后勘误）
- `probe-005-model-adapter-responses-fluxionai.md/.json`（当前 Stage B · Responses 基线）
- `probe-005-model-adapter-rerank-openrouter.md/.json`（Stage C · Reranker 腿，PASS_WITH_ADJUSTMENT；含 401-vs-404 零费用路由判别、gold 置末位的排序质量、候选规模成本/延迟曲线与 429 事件登记）
- ModelAdapter 契约样例、错误映射表和费用报告，覆盖四类调用的 `ModelCallContext`。
- **Chat Completions ↔ Responses 双方言映射表**（见上「Chat 协议改用 Responses API」节），供 ADR-0017 修订。
- 引用验证分层预算的实测数值与建议冻结值。
- 脱敏策略和供应商留存策略快照。

## 通过标准

- `PASS`：内部契约、错误映射、取消、数据门禁和预算账本预扣/结算/回收均成立，且分层验证预算实测可达。
- `PASS_WITH_ADJUSTMENT`：需要更换模型、调整超时/预算/验证时延目标或限制能力，但保留内部 ModelAdapter 边界与预算账本机制。
- `BLOCKED`：无法保证敏感数据阻断、预算硬阻断，或基本 Chat/Embedding/Reranker 契约。

## 测试与回滚

- 使用真实云端小模型，但不保存敏感请求/响应；费用由预算池硬阻断。
- 探针失败撤销本地环境变量和测试数据，不修改业务代码和正式 Manifest。
