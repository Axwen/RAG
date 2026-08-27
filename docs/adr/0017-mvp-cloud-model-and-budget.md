---
status: accepted
revised: 2026-08-26
revision-basis: PROBE-005 Stage A（Embedding）、Stage B（Chat · Responses）与 Stage C（Reranker）实测
---

# MVP 云模型供应商基线与受控模型预算

> 本 ADR 于 2026-08-26 按 PROBE-005 实测**原地修订**：原文以阿里云百炼为唯一云侧供应商、以 `chat/completions` 为唯一兼容协议、并断言「OpenRouter 无 rerank 端点」，三条前提均已被实测推翻。修订记录见文末。

## 1. 供应商基线（按实测冻结）

流程验证 MVP 通过 OpenAI-compatible `ModelAdapter` 接入云模型，分别调用 Chat、Embedding、Reranker 和高风险引用验证能力。业务模块不得直接导入任何供应商 SDK，也不得把具体模型名称写入领域数据模型；模型名称、地域、base、超时和路由策略一律由环境配置提供。

| 能力 | 供应商与模型 | 协议 | 依据 |
|---|---|---|---|
| Embedding | OpenRouter `qwen/qwen3-embedding-8b`，`dimensions=1024` | `POST {base}/embeddings` | PROBE-005 Stage A：原生 4096 维，MRL 截到 1024 对齐 [ADR-0031](0031-chunking-frozen-after-probe.md) 与 PROBE-003 冻结的 1024/`cosinesimil` 索引契约；向量已 L2 单位归一化 |
| Chat / 高风险蕴含校验 | **fluxionai `gpt-5.6-terra`**（`https://fluxionai.space/v1`） | **OpenAI Responses API** `POST {base}/responses` | PROBE-005 Stage B：两次独立运行一致 `PASS_WITH_ADJUSTMENT` |
| Reranker | **OpenRouter `qwen/qwen3-reranker-8b`**（上游 Fireworks，`https://openrouter.ai/api/v1`，与 Embedding 同 base 同密钥） | Cohere 形状 `POST {base}/rerank` | PROBE-005 Stage C：`PASS_WITH_ADJUSTMENT`；合成黄金集 gold@1=1.0（3/3，gold 置于候选末位），字段 `results[].{index,relevance_score,document}` 齐备且分数降序 |

供应商可换，但**换供应商必须重跑对应探针驱动并留下该供应商自己的一份事实记录**（报告按供应商分片）：Chat 用 `scripts/probes/probe_005_responses.py`（Chat Completions 方言用 `probe_005_chat.py`），Reranker 用 `scripts/probes/probe_005_rerank.py`，Embedding 用 `scripts/probes/probe_005_embedding.py`。本 ADR 的时延、能力与错误码结论都是对具体端点的实测结论，不可跨供应商继承。

> 「OpenRouter 无 rerank 端点」是原文的**错误前提**。实测：`POST /api/v1/rerank` 在无有效密钥时返回 401，而任意伪造路径返回 404，据此在**未产生任何费用前**证明该路由真实存在；随后实测该模型可用（上游 Fireworks）。`/api/v1/models` 里既没有 rerank 也没有 embedding 模型，故模型列表的沉默不能作为端点不存在的证据。

## 2. 协议边界：OpenAI 兼容 = Chat Completions 或 Responses

原文的「OpenAI 兼容边界」实际隐含了 `chat/completions` 这一种方言。实测表明中转类供应商可能只实现其中之一（agentrouter.org 只有 `/responses`，`/chat/completions` 全部 401/超时），因此边界放宽为：

**OpenAI 兼容 = Chat Completions 或 Responses 二者之一**，由 `ModelAdapter` 内部一层**协议方言开关**吸收差异，对上游业务模块只暴露统一的内部契约。方言差异表：

| 关注点 | Chat Completions | Responses |
|---|---|---|
| 系统提示 | `messages[0].role=system` | 顶层 `instructions` |
| 用户输入 | `messages[]` | 顶层 `input` |
| 输出长度 | `max_tokens` | `max_output_tokens` |
| 取正文 | `choices[0].message.content` | `output[].content[].type=="output_text"` |
| 结构化输出 | `response_format` | `text.format` |
| 用量 | `usage.prompt_tokens/completion_tokens` | `usage.input_tokens/output_tokens`（含 `reasoning_tokens`、`cached_tokens`） |
| 流式 | 匿名 delta chunk | 具名事件（`response.output_text.delta` / `response.completed` …） |
| 终止态 | `finish_reason` | `status`（`completed`/`in_progress`/`incomplete`） |

预算账本（[ADR-0029](0029-model-budget-ledger-and-limits.md)）的结算口径按两种方言归一后的内部 `usage` 字段计量；Responses 的 `reasoning_tokens` 计入 output 侧成本。

## 3. ModelAdapter 必须自带的供应商防护（实测驱动，不得依赖供应商）

1. **始终显式传入自己的系统提示**。fluxionai 与 agentrouter 在不传 `instructions` 时都会注入一份 21k 字符级的 Codex agent 提示词，污染 grounded-answer 提示词；实测显式传入可完全覆盖。**禁止依赖端点默认值**，这是 [ADR-0032](0032-untrusted-content-and-prompt-injection.md) 的注入面之一。
2. **按供应商登记「结构化输出方言能力」**。fluxionai 的 `text.format.json_schema`(strict) 正常，`json_object` 确定性 500/502（3 次尝试全 500，补测 502/502/timeout）。因此**结构化输出只走 strict `json_schema`，不得把 `json_object` 当降级回退**。结构化输出失败一律返回受控错误，绝不把未校验响应交给 Answer/Citation。
3. **自校验模型白名单**。agentrouter 对未知模型返回 503（不可归一），fluxionai 返回 404；不得依赖供应商拒绝非法模型名。
4. **自限批量与候选上限**。OpenRouter 对 >32 条的 Embedding 批量不拒绝（返 200），对 2048 条 rerank 候选（PROBE-003 冻结上限的 2 倍）同样不拒绝（返 200，6.62s，单次 ¥0.32）；批量与候选上限保护必须做在 Adapter 侧。
5. **流式事件白名单解析**。fluxionai 的纯文本响应流里出现了无关的 `response.audio.transcript.delta`；未知/无关事件必须忽略而不是报错。
6. **取消按本地已收增量计量**。取消瞬间 `status=in_progress` 且流内尚无 `usage`，ADR-0029「取消按已产生 token 结算」要靠 Adapter 本地计量已收 delta 实现。
7. **短超时 + 重试 + 熔断**。同一协议下不同供应商的挂起率差一个量级（agentrouter 0.333，fluxionai 0.0），可用性属供应商属性而非协议属性，必须由 Adapter 侧兜底。
8. **429 是常规分支，不是异常**（rerank 腿实测）。大候选 rerank 会触发限流，且响应**不带 `retry-after` 头**；Adapter 必须自带退避重试，并允许「截断候选数」作为降级手段，不得让一次限流打穿问答请求。探针本身也因此对所有调用做 429 退避——未做退避的那次运行里，紧随 1024 大调用之后的两项检查被 429 污染，一度得出「`top_n` 不生效」的错误结论。
9. **rerank 结果顺序与 Top-K 必须在 Adapter 侧复核**。虽然实测 `relevance_score` 降序且 `top_n` 生效，但截断与排序是内部契约的一部分，不得直接信任响应顺序。
10. **rerank 回显正文禁止入日志**。`return_documents=false` 在该端点**不生效**（响应仍回显全部候选正文）；大候选集下响应体积与脱敏风险由 Adapter 承担，日志只允许记录 `index` / `relevance_score` / chunk 标识。

## 4. 数据边界与预算（原文保留）

当前只允许合成或严格脱敏数据进入云模型执行区。首月模型预算上限为 500 元，并同时设置单次 Token 上限、每日问答/评测次数上限、总调用量和费用告警。达到预算后停止离线评测任务；在线请求返回受控的服务不可用或仅证据结果，不静默超支，也不自动把敏感数据降级发送到云端。`UNKNOWN`/敏感等级的阻断发生在 `ModelAdapter` 准入层而非各调用点（[ADR-0025](0025-data-class-routing-enforcement-point.md)），Chat、Embedding、Reranker、引用验证四条路径同等适用。

**新增：rerank 候选数直接决定预算天花板。** rerank 按全部候选正文计费，实测（`usage.cost` 由供应商直接返回，可直接作为 [ADR-0029](0029-model-budget-ledger-and-limits.md) 的结算口径）：

| rerank 候选数 | 单次成本（汇率假设 7.2） | 单次耗时 | ADR-0029 每日 16 元可支撑问答数 |
|---|---|---|---|
| 8 | ¥0.0012 | 0.89 s | ~13000 |
| 64 | ¥0.0099 | 0.95 s | ~1600 |
| 256 | ¥0.0397 | 1.45 s | ~400 |
| 1024（PROBE-003 融合候选上限） | ¥0.1587 | 3.4–6.6 s（4 次运行区间） | **~100** |

若把 1024 条融合候选全量送 rerank，仅 rerank 一项就把每日 16 元压到约 100 次问答，且 3.4–6.6 s 的抖动本身超出检索链路预算。**1024 是融合候选上限，不等于 rerank 输入规模**——两者必须分开冻结，见第 5 节未闭合项。

**新增：多方供应商的数据处理方风险。** Embedding 与 Reranker（OpenRouter，同一 base 与密钥）、Chat（fluxionai）现由两家不同的第三方承载，中转类供应商是数据路径上的额外处理方，可能记录/留存 prompt。探针仅发送合成文本，可接受；**生产承载真实客服数据前必须完成留存与合规评估**，否则与本 ADR 与 ADR-0025 的「敏感数据不出域」冲突。

## 5. 未闭合治理项（不阻断阶段 1 实现，阻断生产承载真实数据）

- **StepFun 候选暂不替换当前 Chat 基线**：`step-3.5-flash-2603` 的第一方模型身份、结构化输出、流式 usage、取消和错误映射均通过，治理属性优于当前中转基线；但 `reasoning_effort=low/high` 两轮各 20 个有效样本的合并分布中，`low` 完整生成 p50 2.05 s、p95 3.752 s、最大 6.969 s，4/40 超过 ADR-0027 的 3.5 s 高风险预算。冷却后 12 个 `low` 样本 p95 回落到 3.036 s，说明主要问题是持续负载下的尾部抖动；`low` 在当前 grounded 引用任务上也未形成可测时延优势。按既定门禁，本次不迁移供应商、不继续放宽 ADR-0027；StepFun 保留为候选，后续只有在真实语料和目标并发下证明尾部可通过限流、排队或对冲稳定治理时再立新 ADR 切换。实测见 `docs/engineering/probe-results/archive/probe-005-supplier-evaluations/probe-005-model-adapter-chat-stepfun-effort-ab-step-3.5-flash-2603-pooled.md`。
- **承载模型身份不可核验**：fluxionai 请求/回显均 `gpt-5.6-terra`，模型自称 "GPT-5"；agentrouter 的 `gpt-5.6-sol` 自称 "GPT-5 Codex"，两家注入同一份 Codex 提示词，疑似同源上游。「可信 RAG」要求承载模型与提供方可审计，需供应商出具模型映射说明。**在此项闭合前，本基线只用于阶段 1 的合成数据流程验证。**
- **Reranker 输入规模（rerank N）未冻结**：供应商与模型已按 Stage C 实测冻结（第 1 节），但「一次问答送多少条候选进 rerank」尚未拍板，它同时决定成本（¥0.0012→¥0.1587）、延迟（0.89 s→3.4-6.6 s）与召回上限，属产品级取舍，需用户拍板后写入本 ADR 第 1 节、[ADR-0029](0029-model-budget-ledger-and-limits.md) 成本模型与检索链路预算。T1a 先建立必填 `RetrievalManifest.rerankInputSize`，**开发种子 Manifest 显式写 N=64**（¥0.0099/次、0.95 s，仍留出约 1600 次/日余量），不得默认全量 1024，也不得允许环境变量覆盖一次运行的快照事实。T6 在真实业务语料下比较 N 对质量、延迟和成本的影响后再拍板正式值；否则黄金集回归无法把指标变化归因到「召回变化」或「N 变化」。
- **rerank 延迟抖动**：1024 候选四次运行为 3.36 / 3.46 / 3.49 / 6.61 s，P95 已明显超出检索链路预算，且供应商限流不带 `retry-after`。冻结 N 时必须按上界而非均值设超时。

## 6. 修订记录

- **2026-08-26（PROBE-005 StepFun 候选）**：完成 `step-3.5-flash-2603` 契约探针与 `reasoning_effort=low/high` A/B；因合并 `low` p95 3.752 s 超过 3.5 s 门禁，保留 fluxionai Chat 基线，不迁移供应商、不放宽预算，并把 StepFun 尾部治理列为后续候选验证项。
- **2026-08-26（PROBE-005 Stage C）**：Reranker 由「未定」冻结为 OpenRouter `qwen/qwen3-reranker-8b`（Cohere 形状 `POST {base}/rerank`），删除原文「OpenRouter 无 rerank 端点」的错误前提并记录其证伪方式（401 vs 404 路由判别，零费用）；第 3 节新增第 8–10 项（429 常规分支、Top-K 侧复核、回显正文禁入日志）并把第 4 项扩为「批量与候选上限」；第 4 节新增 rerank 候选数—成本—延迟对照表与其对 ADR-0029 每日上限的挤压；第 5 节把「Reranker 未定」替换为「rerank 输入规模 N 未冻结」与延迟抖动两项，并要求 N 落在 `RetrievalManifest.rerankInputSize`（工程评审闭合记录第 4.2 节据此新增该必填字段）。实测明细见 `docs/engineering/probe-results/probe-005-model-adapter-rerank-openrouter.md`。
- **2026-08-26（PROBE-005）**：供应商基线由阿里云百炼改为 OpenRouter（Embedding）+ fluxionai（Chat）；协议边界由 `chat/completions` 放宽为「Chat Completions 或 Responses」并引入方言开关；新增第 3 节的七项 Adapter 侧防护、第 4 节的多供应商数据处理方风险、第 5 节的模型身份治理项。当前契约见 `docs/engineering/tickets/PROBE-005-model-adapter.md`，供应商切换过程见 `PROBE-005-model-adapter-decision-log.md`，实测主结果见 `docs/engineering/probe-results/README.md`。
