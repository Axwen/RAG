---
status: accepted
date: 2026-09-04
revises:
  - 0011-shared-knowledge-assets.md
  - 0021-multi-format-parser-artifact.md
  - 0027-tiered-citation-verification-budget.md
  - 0030-answer-body-storage-tiers.md
decision-basis: Video RAG 公共基座架构 Review；Seelyn 交接资料仅作为 observed 参考，不作为运行时依赖
---

# 模态无关 Evidence、Locator 与 Citation

## 背景

现有文档 RAG 的不可变文档版本、ParseArtifact、Chunk 和页码/字符定位仍然有效，但它们不能表达视频镜头、语音、字幕、OCR、关键帧或纯视觉结果。若把视频强行改名为 Document 或 Chunk，会丢失时间关系、模态来源和片段级引用。

## 决策

1. 公共语义层新增 `SourceAsset`、`AssetVersion`、`EvidenceItem`、`EvidenceLocator` 和 `EvidenceProvenance`。它们是跨运行时的协议对象，不要求成为唯一事实表。
2. `SourceFormat` 表示输入文件格式，`SourceKind` 表示来源/资产类型，`EvidenceModality` 表示证据通道，三者不能互相替代。
3. `EvidenceItem` 的 `level` 支持 `asset`、`scene`、`shot`、`evidence`，通过 `parentEvidenceId` 表达 Asset → Scene/Shot → Evidence 层次；文档 Chunk 仍由文档侧事实模型维护，通过 Adapter 投影为 Evidence。
4. `EvidenceLocator` 是联合定位类型，至少支持 `page_range`、`character_range`、`bbox`、`time_range`、`frame`、`image_region` 和 `url_fragment`。时间统一使用非负整数毫秒，必须满足 `startMs >= 0` 且 `endMs > startMs`。
5. `Citation` 必须携带 `evidenceId`、源/版本身份和 Locator。页码不是必填；视频引用至少可表达 `time_range`，图像引用可表达 `frame` 或 `image_region`。
6. 定位只表达“在哪里”，不承担 ACL、删除、过期或注入风险判定。引用回跳前仍必须执行当前权限和可用性检查。
7. 证据可以 `text: null`，因为视觉证据可能只有帧、区域或向量投影；Embedding 数组不内嵌在 Evidence 或 Citation。

## 不变量

- Evidence 必须绑定 `sourceVersionId` 和 `contentHash`，不可脱离不可变源版本解释。
- Provider、模型、输入/输出指纹、Run、Generation 和 Attempt 进入 Provenance；没有可追溯 Provenance 的分析结果不能成为正式 Evidence。
- `availability=deleted`、`availability=quarantined` 或当前 ACL 不通过的 Evidence 不得进入生成上下文或最终 Citation。
- `Citation` 的 Locator 必须与目标 Evidence 的源版本一致；验证失败不能被 formatter 掩盖。
- `time_range` 不接受负数、浮点、`endMs <= startMs` 或超出协议整数范围的值。

## 与既有 ADR 的关系

本文**不删除**文档版本、ParseArtifact、Chunk、AnswerSnapshot 或分层引用验证。它把它们接入更宽的公共 Evidence/Citation 语义：

- ADR-0011 继续定义文档版本作为共享知识资产；本文扩展其公共 Evidence 投影，不把视频资产写入文档事实表。
- ADR-0021 继续定义文档 Parser Adapter 和 ParseArtifact；视频 Provider 不被塞进 DeepDOC Parser。
- ADR-0027 继续定义引用验证预算；本文只扩大可验证 Locator 的种类。
- ADR-0030 继续定义 AnswerSnapshot 的存储层级；快照中的 Citation 现在可以保存时间/帧/区域定位。
