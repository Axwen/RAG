# PROBE-005 ModelAdapter 探针结果（Stage A · Embedding）

- 状态：**PASS_WITH_ADJUSTMENT**
- 执行时间：2026-08-25T10:24:18Z
- Provider：openrouter（OpenAI 兼容 /v1/embeddings）
- 模型：`qwen/qwen3-embedding-8b`

> LIVE = openrouter API 真实返回；SIMULATED = 数据分级门禁与 PostgreSQL 预算账本（无业务代码，随 ModelAdapter 实现复验）。仅发送合成文本，密钥不入库/日志/报告。

## 维度与契约（LIVE）

- 原生维度：**4096**（trace-id 可审计：False）
- MRL `dimensions=1024`：返回 1024 维，匹配 PROBE-003 冻结 1024 契约：**True**

## 归一化 / 空间度量（LIVE）

- L2 范数：[1.0, 1.0, 1.0]；已单位归一化：**True**；建议 space_type：`innerproduct/cosinesimil`

## 批量 / 延迟曲线（LIVE）

| 句数 | HTTP | 秒 | 返回条数 | 顺序保持 | total_tokens |
|---|---|---|---|---|---|
| 1 | 200 | 1.42 | 1 | True | 19 |
| 4 | 200 | 3.753 | 4 | True | 81 |
| 8 | 200 | 14.482 | 8 | True | 155 |
| 8 | 200 | 20.201 | 8 | True | 155 |

## 确定性与错误映射（LIVE）

- 同输入自相似 cosine：0.999902；位相等：False
- 错误密钥 → HTTP 401（401：True）
- 超 32 条批量 → HTTP None（被拒：False）

## 成本（LIVE 用量）

- 统计到的 token 用量（部分调用）：448
- 单价（元/百万 token）：0.0；估算：None 元

## 决策与遗留

- 超 32 条批量未被拒绝：已转为 Adapter 侧批量上限约束，不依赖供应商拒绝。
- 模型原生维度 4096 与冻结的 kNN 维度 1024 不一致：PROBE-006 已使用 1024 维真实 Embedding 完成小规模 Recall@5 并冻结 `wide-1024`；由于没有执行同语料 4096 维对照，仍不得宣称“1024 相对原生维度无召回损失”。真实业务语料回归见 Probe Decision Gate。

## SIMULATED（服务层，随 ModelAdapter 实现复验）

- **data_class_gating**：ADR-0025: UNKNOWN/敏感等级必须在 ModelAdapter 准入层（而非调用点）阻断 Chat/Embedding/Reranker/引用验证四条路径。业务代码尚未存在（设计期仓库），本探针只发送合成文本，门禁为 SIMULATED，随 ModelAdapter 实现的集成测试复验。
- **budget_ledger**：ADR-0029: 调用前在同一 PostgreSQL 事务写入 RESERVED 并取 lease，结算写回实际用量、释放差额，进程被杀后 lease 过期回收。无 DB/业务代码，SIMULATED；本探针 LIVE 记录真实 usage.total_tokens 供预扣口径校准。
- **chat_reranker**：Chat / 高风险蕴含已由 fluxionai `gpt-5.6-terra` Responses API 定档；Reranker 已由 OpenRouter `qwen/qwen3-reranker-8b` 的 Cohere 形状 `POST /rerank` 定档。两条路径的供应商事实见各自主结果；数据分级门禁与预算账本仍需随 ModelAdapter 集成复验。

> **2026-08-26 后续定档**：Stage A 执行时 Chat/Reranker 还只是草稿假设，随后已被独立 Stage 实测替代；当前以上方 `chat_reranker` 摘要和各自主结果为准。
> - **「OpenRouter 无 rerank 端点」是错误前提**。Stage C 用 401-vs-404 路由判别在零费用下证明 `POST {base}/rerank` 真实注册，随后实测 `qwen/qwen3-reranker-8b`（Cohere 形状，与 Embedding 同 base 同密钥）`PASS_WITH_ADJUSTMENT`。见 `probe-005-model-adapter-rerank-openrouter.md` 与 [ADR-0017](../../adr/0017-mvp-cloud-model-and-budget.md) 第 1、3、4、5 节。注：OpenRouter `/api/v1/models` 既不列 rerank 也不列 embedding，模型列表的沉默不构成证据。
> - **Chat 腿不走 OpenRouter**。Stage B 最终定档 fluxionai `gpt-5.6-terra` + OpenAI **Responses** 协议（`PASS_WITH_ADJUSTMENT`），见 `probe-005-model-adapter-responses-fluxionai.md`。
> 本节其余 SIMULATED 项（`data_class_gating`、`budget_ledger`）仍未验，且 ADR-0025 的四路径门禁与 ADR-0029 的预扣/结算同等适用于已定档的 rerank 路径。
