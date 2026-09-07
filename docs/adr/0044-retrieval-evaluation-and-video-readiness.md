---
status: accepted
date: 2026-09-04
revises:
  - 0033-deterministic-evidence-conflict-resolution.md
  - 0035-stage1-runtime-protocol-ratification.md
decision-basis: Video RAG 公共基座架构 Review；证据驱动检索与可重复评测要求
---

# Retrieval Candidate、Temporal Grounding 与 Video RAG 评测门禁

## 背景

现有检索设计已经规定 ACL 预过滤、候选权威复核、融合、Rerank、冲突确定性消解和句级引用，但公共候选与评测类型尚未形成。视频需要同时保留模态、来源、Locator、Embedding Channel 和时间关系，不能用“返回整条视频”或“只做 ASR”替代。

## 决策

1. 公共契约新增 `RetrievalQuery`、`RetrievalCandidate`、`TemporalRelation`、`Citation`、`EvaluationDataset`、`EvaluationQuery`、`ExpectedEvidence`、`EvaluationRun` 及检索/时间/引用/资源指标。
2. `RetrievalCandidate` 至少保留 `sourceId`、`sourceVersionId`、`evidenceId`、`modality`、`locator`、`channelId`、`retrievalSource`、`score`、`rank` 和 `temporalRelation`。
3. 检索逻辑按 lexical、dense、metadata 分路召回，再进行候选融合、Evidence 去重、时间邻接关系标注、结果多样性和可选 rerank；结构化过滤不是向量检索的替代品。
4. `rag-core` 只实现存储无关的确定性逻辑：候选融合/排序/去重、时间关系、上下文组装、引用格式化/校验、Temporal IoU、Recall@K、MRR、nDCG、Correct Asset Rate 和 Grounded Answer 判定。
5. Video RAG readiness gate 至少要求真实媒体导入、FFprobe/FFmpeg、时间化字幕/ASR Evidence、shot/scene 分层、OCR、视觉 Embedding、文字搜画面、图片搜画面、Temporal IoU、引用跳转、取消/恢复、旧结果隔离和资源基准；这些不是本轮 Web 基座实现项。
6. 没有黄金集、时间标注、Provider/模型/Channel 版本和 P50/P95/资源结果时，只能声称“契约/功能已完成”，不能声称“效果优于 Seelyn”。

## 不变量

- 同一 Evidence 的多路召回结果可被确定性去重；排序不依赖 Map/数据库返回顺序。
- Temporal IoU 只比较合法的时间区间；无时间 Locator 的候选不伪造时间分数。
- Citation Precision 只统计可验证、定位与 Evidence 一致的 Citation；无证据句不能算 grounded。
- 评测运行必须记录 dataset、pipeline、Provider/model/Channel 版本和输入指纹，结果可重放。
- Web RAG 和本地 Video RAG 可以使用不同的物理索引/存储 Adapter，只要输出公共候选、引用和评测格式。

## 与既有 ADR 的关系

- ADR-0033 的冲突全序和 Finalizer 门禁继续有效；本文让冲突来源以公共 Candidate/Evidence 表达。
- ADR-0035 的运行期硬协议继续有效；本文补齐公共纯逻辑和 Video readiness gate，不降低文档 RAG 的权限、引用、删除和恢复门禁。
