---
status: accepted
date: 2026-09-04
revises:
  - 0017-mvp-cloud-model-and-budget.md
  - 0028-embedding-version-partition-and-rebuild.md
  - 0031-chunking-frozen-after-probe.md
  - 0037-stage1-index-field-alignment.md
decision-basis: Video RAG 公共基座架构 Review；文档 1024 维基线与未来视觉/多模态 channel 共存要求
---

# Embedding Channel 属于索引身份，文档分块与视频分段分离

## 背景

文档 RAG 已按 PROBE-006 和 ADR-0017 形成 `wide-1024` 文档分块与 1024 维 Embedding 基线。这个基线不能被误读成所有模态共享一个维度，也不能把文档分块名称当成视频 shot/scene 策略。

## 决策

1. 新增 `EmbeddingChannel`，至少固定 `channelId`、`modality`、`providerRef`、`modelRef`、`modelVersion`、`dimension`、`distance` 和 `normalization`。
2. Embedding 维度属于 Channel，不再由 `@rag/rag-core` 导出为全局 `EMBEDDING_DIMENSIONS`。文档 1024 维只作为文档 channel 的显式兼容基线。
3. `IndexPartition`/本地索引投影的身份必须包含 `channelId` 或等价的 channel fingerprint；改变模型、版本、维度、距离、归一化或分段/分块版本时，不在旧分区原地混写。
4. 文档 `wide-1024` 只表示文档 ChunkingManifest。视频使用独立的 `segmentationRef`/`shotPolicyRef`，其参数要通过视频评测确定；本轮不实现视频切分器。
5. 文本、图片、视频片段和多模态向量可以共存，但不同 Channel 的向量不得直接比较或写入同一无区分的向量字段。
6. 现有 `IngestionManifestContent.embeddingRef`、`ReleaseManifestContent.embeddingVersion` 和文档 1024 维索引继续兼容；文档 Adapter 负责把旧引用解析为文档 Embedding Channel。

## 不变量

- `dimension` 为正整数；Channel 身份相同但 dimension/provider/model/version/distance/normalization 任一变化时，必须视为新版本。
- 召回候选必须携带 `channelId`；lexical/metadata 候选可使用 `null`，不得伪造向量 Channel。
- `wide-1024` 不得作为视频 `segmentationRef`，也不得作为所有模态的通用分段策略。
- Seelyn 观察到的 768 维只能是外部样本中的一个 Channel 事实，不能替换当前文档 1024 维基线，也不能成为全局常量。

## 与既有 ADR 的关系

- ADR-0017 的文档云模型和 1024 维基线继续有效，本文把它的维度归属明确到文档 Channel。
- ADR-0028 的新分区、重建、回滚和预算门禁继续有效，本文补充 Channel identity。
- ADR-0031 的文档分块冻结继续有效，本文明确其不覆盖视频分段。
- ADR-0037 的 OpenSearch 字段与 ACL 口径继续有效，本文要求向量投影额外能识别 Channel；不要求新增阶段 1 的 ACL 字段。
