# Video RAG 评测输入

这里保存未来 Video RAG 使用的**脱敏/自制/已授权**评测格式说明，不保存用户媒体、真实转写、授权信息、模型权重或原始 Seelyn 数据库。

## 文件约定

- `queries.jsonl`：文本、图片 Artifact 引用和结构化 metadata 查询；
- `labels.jsonl`：期望 `sourceId`、`sourceVersionId`、modality、Evidence 和 Locator；视频期望使用整数毫秒 `time_range`；
- `injection-cases.jsonl`：解析、上下文进入前和输出后的注入测试样本，只放最小脱敏文本；
- `expected-metrics.json`：数据集/流水线版本、指标阈值和资源上限。

具体指标和 Gate 见[Video RAG 评测与验收计划](../../docs/engineering/video-rag-evaluation-plan.md)以及[Video RAG readiness gate](../../docs/engineering/video-rag-readiness-gate.md)。当前目录没有真实媒体和数据文件，等待后续 V0/V1 实测。
