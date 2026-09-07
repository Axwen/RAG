# Video RAG 评测与验收计划

> 目标：用可重复、可回放的数据和资源指标判断 Video RAG 是否真的可用、是否相对上一 Pipeline 改善；不在没有结果时声称优于 Seelyn。

## 1. 数据集格式

建议目录：

```text
evals/video/
  README.md
  queries.jsonl
  labels.jsonl
  injection-cases.jsonl
  expected-metrics.json
```

只允许使用自制、授权或严格脱敏短视频。不得提交用户媒体、真实转写、授权信息、模型权重或原始 Seelyn 数据库。

### 1.1 `queries.jsonl`

每行至少包含：

```json
{
  "queryId": "q-001",
  "text": "画面中出现红色包装的片段",
  "imageArtifactId": null,
  "metadata": {"language": "zh"}
}
```

### 1.2 `labels.jsonl`

每个期望结果包含 source/version、modality、Locator；视频期望必须有 `time_range` 的 `startMs`/`endMs`，可选 `evidenceId`。

### 1.3 `expected-metrics.json`

记录数据集版本、Pipeline/Provider/Channel 版本、阈值、资源上限和允许的已知回归，不把阈值写进代码常量。

## 2. 指标

### 2.1 检索质量

- Recall@K：期望 Evidence 被 Top-K 命中的比例；
- MRR：首个相关结果的倒数 rank；
- nDCG@K：考虑 rank 的相关性；
- Correct Asset Rate：Top-K 是否命中正确 sourceId；
- 按 modality/source/channel 分桶，避免素材级命中掩盖片段级失败。

### 2.2 时间定位

- Temporal IoU：期望时间区间与结果时间区间交并比；
- `bestTemporalIoU@K`：Top-K 中与期望区间最大 IoU；
- 片段边界误差、过长/过碎率；
- 无时间 Locator 的结果不得伪造 Temporal 指标。

### 2.3 证据和回答

- ASR CER/WER；
- OCR 字符准确率与区域定位准确率；
- Citation Precision：Citation 与 Evidence 的 source/version/Locator 和安全状态均验证通过的比例；
- Grounded Answer Rate：非空事实句至少有一个有效 verified Citation 的回答比例；
- 冲突、注入和无证据问题的拒答/证据-only 正确率。

### 2.4 资源和延迟

- import/query P50/P95；
- 峰值内存、CPU 时间、GPU 内存；
- Artifact Store 与 SQLite WAL 磁盘增长；
- 每阶段吞吐、失败率、重试次数、取消响应时间和恢复时间；
- Provider/model/channel 版本必须随结果保存。

## 3. 验收分层

| Gate | 范围 | 通过条件 |
|---|---|---|
| G0 | 契约和媒体边界 | 可导入、可 probe、可恢复，异常不伪报完成 |
| G1 | 字幕/ASR 文本证据 | 时间化 Evidence、FTS、片段跳转、CER/WER 和失败恢复 |
| G2 | 视觉检索 | shot/scene、OCR、视觉 channel、文字/图片搜画面 |
| G3 | 可信 RAG | 融合、时间邻接、Citation、Grounded Answer、旧结果隔离 |
| G4 | 资源和发布 | P50/P95、内存/磁盘、恢复演练、可回放版本清单 |

## 4. 必测失败模式

- 无音轨、无字幕、损坏或文件消失；
- FFprobe/FFmpeg/ASR/OCR/视觉 Provider 不可用、超时、错误输出；
- 任务取消后迟到结果；
- retry attempt、generation、inputFingerprint 不一致；
- SQLite lock、磁盘不足、进程崩溃和恢复；
- 旧 channel/旧 segmentationRef 混入新索引；
- 素材命中但时间区间错误；
- Citation 只有页码、引用到错误视频或错误版本；
- OCR/字幕/Caption 中的 prompt injection；
- 评测高负载挤占正常导入/查询资源。

## 5. 比较和发布规则

1. 没有黄金集和时间标注，只能报告“功能已完成”，不能报告“效果更好”；
2. 要宣称优于 Seelyn，至少一个主目标有可重复提升，且没有未解释的关键指标回归；
3. 质量提升不能换来不可接受的延迟、内存、磁盘、成本或失败率；
4. 每个结论必须回放到 dataset、Pipeline、Provider、模型、Channel、输入指纹和资源报告；
5. Seelyn 结果若不可获得，明确标为 `baseline_unavailable`，不使用逆向观察替代实测对照。
