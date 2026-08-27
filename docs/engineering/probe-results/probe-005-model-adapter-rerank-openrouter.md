# PROBE-005 ModelAdapter 探针结果（Stage C · Reranker）

- 状态：**PASS_WITH_ADJUSTMENT**
- 执行时间：2026-08-26T03:37:41Z
- 供应商：`openrouter`，端点 `https://openrouter.ai/api/v1/rerank`
- 模型：`qwen/qwen3-reranker-8b`（上游 `Fireworks`，回显 `accounts/fireworks/models/qwen3-reranker-8b`）
- 数据：仅合成脱敏客服文本，无真实客户数据。

## 1. 契约映射（LIVE）

- HTTP 200，耗时 0.884s，送 8 条候选、`top_n=5`，返回 5 条
- 字段：`index` True，`relevance_score` True，回显 `document` True
- 分数降序：True；index 在候选范围内：True
- 可审计标识：response id `gen-rerank-1787715389-khaIVayLv2sHLLV3spA8`，request-id `None`
- 用量：{'total_tokens': 813, 'cost': 0.0001626}（`cost` 为供应商直接返回的美元成本，可直接作为ADR-0029 结算口径）

## 2. 排序质量（LIVE，合成黄金集）

gold 文档一律放在候选列表**最后一位**，避免「原序回显」被误判为排序正确。命中率 gold@1 = **1.0**（3/3）。

| 查询 | HTTP | 耗时 | 候选数 | top1 index | gold index | gold@1 | gold 分 | 次优干扰分 | 间距 |
|---|---|---|---|---|---|---|---|---|---|
| 订单发货后多久能收到快递 | 200 | 1.23s | 9 | 8 | 8 | True | 0.9991958737373352 | 0.562176525592804 | 0.437 |
| 怎么申请开发票 | 200 | 0.895s | 9 | 8 | 8 | True | 0.9944451451301575 | 0.00035419364576227963 | 0.9941 |
| 密码输错太多次账号被锁了怎么办 | 200 | 0.873s | 9 | 8 | 8 | True | 0.9937100410461426 | 0.013222822919487953 | 0.9805 |

## 3. 候选规模与延迟（LIVE）

PROBE-003 冻结的检索预算是单次最多 1024 条融合候选，因此该值是 rerank 必须承受的上限，不是任意压力点。

| 候选数 | HTTP | 耗时 | 返回条数 | gold@1 | 用量 |
|---|---|---|---|---|---|
| 8 | 200 | 0.892s | 5 | True | {'total_tokens': 862, 'cost': 0.0001724} |
| 64 | 200 | 0.948s | 5 | True | {'total_tokens': 6889, 'cost': 0.0013778} |
| 256 | 200 | 1.452s | 5 | True | {'total_tokens': 27553, 'cost': 0.0055106} |
| 1024 | 200 | 3.493s | 5 | True | {'total_tokens': 110209, 'cost': 0.0220418} |

## 4. 选项与长候选（LIVE）

- `top_n=3` → 返回 3 条（HTTP 200，1.229s），生效：True
- `return_documents=false` → HTTP 200（0.887s），回显被抑制：False
- 长候选 6042 字符 → HTTP 200（1.203s），回显 6042 字符，被截断：False，仍为 top1：True

## 5. 错误映射与候选上限（LIVE）

- 错误密钥 → HTTP 401（401：True）
- 未知模型 → HTTP 400（4xx：True）`{'error': {'message': 'Model qwen/definitely-not-a-model-xyz does not exist', 'code': 400}}`
- 空 `documents` → HTTP 400 `{'error': {'message': '[\n  {\n    "origin": "array",\n    "code": "too_small",\n    "minimum": 1,\n    "inclusive": true,\n    "path": [\n      "documents"\n  `
- 2048 条超量候选 → HTTP 200（6.62s，返回 5 条），结论：`accepted`，用量 {'total_tokens': 220417, 'cost': 0.0440834}
- 运行中 HTTP 429 限流次数：1（明细 [{'attempt': 1, 'documents': 2048, 'retry_after': None, 'seconds': 4.903}]）；所有调用均已做 429 退避重试，限流不计入供应商契约结论。

## 6. 费用（LIVE）

- 本次探针带 usage 的调用合计 373710 tokens，供应商直接返回成本 $0.074742（按假设汇率 7.2 约 ¥0.5381）
- 只统计带 usage 的校验调用；汇率为假设值，不是供应商结算汇率。

## 7. SIMULATED（非供应商责任，随实现复验）

- **data_class_gate**：ADR-0025 的 UNKNOWN/敏感等级准入必须在 ModelAdapter 层阻断，rerank 路径与 Chat/Embedding 同等适用；无业务代码，随实现复验。
- **budget_ledger**：ADR-0029 预扣/lease/结算/回收为服务侧协议；本探针只提供真实 usage（total_tokens + cost）作为结算口径输入。
- **retrieval_integration**：融合候选构造、Top5 截断与 ACL 权威复核属 PROBE-003/T6 范围，本 stage 只测 rerank 端点本身。

## 8. 结论

### 需决策/需实现侧承担
- 1024 候选单次 rerank 实测 3.493s：必须作为检索链路独立计时项，且 Adapter 需按该延迟设置超时与降级（截断候选数而非放弃 rerank）。
- 满额 1024 候选 rerank 单次成本 ¥0.1587（实测 usage.cost $0.0220418，汇率假设 7.2）：仅 rerank 一项就把 ADR-0029 每日 16 元压到约 100 次问答/日；对比 8 候选仅 ¥0.0012/次、0.892s。PROBE-003 冻结的 1024 是**融合候选**上限，不等于必须全量 rerank：需决策 rerank 输入是否截断到更小的 N（成本与延迟同时线性下降），该 N 应写入 ADR-0017 Adapter 约束与 ADR-0029 成本模型。
- 2048 条候选未被供应商拒绝（HTTP 200，耗时 6.62s）：与 Embedding 腿同一结论——候选上限保护必须做在 ModelAdapter 侧。
- 运行中出现 1 次 HTTP 429 限流（被限流调用的候选数 [2048]，retry-after 头=None，退避重试后成功）：大候选 rerank 会触发限流，且供应商未给出 retry-after 头。检索链路必须把 429 视为常规分支——按「退避重试 + 截断候选数」降级，不得让一次限流打穿问答请求；本探针对所有调用做 429 退避重试，否则限流会被误记为供应商契约缺陷（2026-08-26 03:34Z 那次运行未加退避，top_n 与 return_documents 两项检查被紧随 1024 大调用后的 429 污染，结论一度失真）。
- `return_documents=false` 未生效（响应仍回显全文）：大候选集下响应体积与日志脱敏风险由 Adapter 侧承担，不得把回显正文写入日志。


建议结论：**PASS_WITH_ADJUSTMENT**
