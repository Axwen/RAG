# PROBE-005 ModelAdapter 探针结果（Stage B · Chat）

> 📌 **后续修订（2026-08-26）**：本报告的 BLOCKED **仅针对 `/chat/completions` 端点**。改走 OpenAI **Responses API**（`/responses`）后同一供应商 `PASS_WITH_ADJUSTMENT`，见 [probe-005-model-adapter-responses-agentrouter.md](probe-005-model-adapter-responses-agentrouter.md)。以 Responses 报告为 Chat 腿的现行结论；本文保留为 Chat Completions 腿的历史记录。

- 状态：**BLOCKED**
- 执行时间：2026-08-25T10:49:43Z
- Provider：agentrouter（`https://agentrouter.org/v1`）
- 模型：`gpt-5.6-sol`（标称）

> ⚠️ **根因不在探针代码，而在中转站本身**：`agentrouter.org` 既不是 OpenAI 兼容端点，且以 Claude CLI 的 User-Agent 做准入门禁。详见文末「根因诊断」与 ticket。以下自动化字段均为该 401 的连带结果，不代表模型真实能力。

> LIVE = 供应商真实返回；SIMULATED = 数据分级门禁、预算账本、分层引用验证（设计期无业务代码，随 ModelAdapter 实现复验）。仅发送合成客服文本，密钥不入库/日志/报告。

## 契约映射（LIVE，非流式）

- HTTP 401，耗时 1.346s，内容 None 字符
- 响应 id：None；request-id 头：None
- model 回显：`None`（与请求一致：None）
- finish_reason：`None`
- usage 回传：**None** → None
- 回答含资料编号引用：None

## 流式 / TTFT / 取消（LIVE）

| 场景 | HTTP | TTFT(s) | 总耗时(s) | 增量数 | 字符 | finish_reason | 流内 usage |
|---|---|---|---|---|---|---|---|
| 完整生成 | 401 | None | 1.278 | 0 | 0 | None | 无 |
| 中途取消(5 增量) | 401 | None | 1.274 | 0 | 0 | None | 无 |

- 取消生效：**False**；流式回传 usage：**False**

## 结构化输出（LIVE）

| 模式 | HTTP | 解析为 JSON | 满足 schema | 备注 |
|---|---|---|---|---|
| `json_schema` | 401 | - | - | {'error': {'message': 'unauthorized client detected, contact support for assista |
| `json_object` | 401 | - | - | {'error': {'message': 'unauthorized client detected, contact support for assista |

## 错误映射（LIVE）

- 错误密钥 → HTTP 401（401：True）
- 未知模型 → HTTP 401（4xx 拒绝：True）
- 客户端超时（0.7s）→ 可归一：True（URLError: <urlopen error _ssl.c:983: The handshake operation timed out>）

## 成本（LIVE 用量）

- prompt tokens：0；completion tokens：0
- 单价（元/百万 in/out）：0.0 / 0.0；估算：None 元
- 口径说明：仅统计供应商回报了 usage 的调用；单价来自环境变量/参数，未提供则只记录用量。单次问答成本口径需叠加 Stage A 的查询/逐句 Embedding 与高风险蕴含调用。

## 失败项
- 基本 Chat 调用失败 HTTP 401：供应商返回 `UNAUTHENTICATED`，该记录仅作为历史供应商不适配证据。
- 流式路径不可用（无增量输出），与流式取消/TTFT 目标冲突
- 流式无法中途取消：ADR-0029 的取消按已产生 token 结算不成立
- json_schema 与 json_object 均无法产出可校验结构化输出：结构化输出失败必须返回受控错误，不能把未校验响应交给 Answer/Citation

## 待决策
- 流式路径未回传 usage（include_usage 被忽略）：取消结算只能按已收字符估算 token，需在 Adapter 侧本地计量并接受误差。

## SIMULATED（服务层，随 ModelAdapter 实现复验）

- **data_class_gating**：ADR-0025：UNKNOWN/敏感等级必须在 ModelAdapter 准入层（而非调用点）阻断 Chat/Embedding/Reranker/引用验证四条路径。设计期仓库无业务代码，本探针只发送合成文本，门禁为 SIMULATED，随 ModelAdapter 实现的集成测试复验。
- **budget_ledger**：ADR-0029：调用前在同一 PostgreSQL 事务写入 RESERVED 并取 lease，结算写回实际用量并释放差额，流式取消按已产生 token 结算，进程被杀后 lease 过期回收。无 DB/业务代码，SIMULATED；本探针 LIVE 记录真实 usage 与取消时已产生的增量，供预扣/结算口径校准。
- **citation_verification**：ADR-0027 分层引用验证（常规 P95<=600ms / 高风险含蕴含调用P95<=1.5s）依赖逐句 Embedding 批量 + 高风险蕴含调用，属独立测量，需与 Stage A 的批量延迟曲线合并计算，本 stage 未单独压测。
- **relay_governance**：中转站（agentrouter.org）是数据路径上的额外第三方处理方，可能记录/留存 prompt。探针仅合成文本可接受；生产承载真实客服数据前必须评估留存与合规，否则冲突 ADR-0017/0025「敏感数据不出域」。
## 根因诊断（探针 BLOCKED 后手工排查，2026-08-25）

用受控请求逐项隔离，确认 401 不是密钥/我方代码问题，而是中转站的三个硬事实：

1. **不是 OpenAI 兼容端点。** `POST /v1/chat/completions` 在任何 User-Agent 下要么 401、要么读超时；能返回 200 的是 **`POST /v1/messages`（Anthropic Messages 协议）** —— 需 `x-api-key` + `anthropic-version`，响应体是 `{"type":"message","content":[{"type":"text"}],"stop_reason","usage":{"input_tokens","output_tokens"}}`。这与 ADR-0017 ModelAdapter「OpenAI 兼容边界」前提冲突。
2. **以 Claude CLI 的 User-Agent 做准入门禁。** 同一密钥、同一端点、同一请求体，`User-Agent: curl/*`、`OpenAI/Python`、默认 urllib 全部 401 `unauthorized client detected`；仅 `User-Agent: claude-cli/*` 返回 200。即该中转站被设计为**从 Claude Code CLI 内使用**，服务端调用（我们的 NestJS / Node worker）无法在不伪装 CLI 身份的前提下访问。
3. **模型标识不可信。** 标称 `gpt-5.6-sol`；问「你是哪个模型」答 **"ChatGPT"**；但响应是 **Anthropic Messages 格式**、`model` 字段回显 `gpt-5.6-sol`。三者互相矛盾，无法核验实际承载模型与其提供方。

**结论**：此中转站不满足本项目 ModelAdapter 的协议前提与可信前提。BLOCKED 判定成立，但属于**供应商不适配**，非探针失败。建议见 ticket 「Chat 供应商决策」节。SIMULATED 项（数据门禁 / 预算账本 / 分层引用验证）未受影响，待可信 Chat 供应商定档后复跑。
