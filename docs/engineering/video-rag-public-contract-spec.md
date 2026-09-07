# Video RAG 公共契约 Spec

> 状态：已落地 TypeScript 契约首版，评审硬化项尚未全部实现；具体 Video 运行时仍以后续 Adapter 为边界。  
> 关联 ADR：[0041](../adr/0041-modality-neutral-evidence-and-citation.md)、[0042](../adr/0042-embedding-channel-and-index-identity.md)、[0043](../adr/0043-provider-run-and-runtime-adapter-boundary.md)、[0044](../adr/0044-retrieval-evaluation-and-video-readiness.md)、[0045](../adr/0045-shared-media-engine-and-three-repository-boundary.md)

## 1. 契约分层

```text
@rag/contracts
  evidence/      SourceAsset, AssetVersion, Evidence, Locator, Provenance
  providers/     Artifact, ProviderRun, JobEvent, execution identity
  embedding/     EmbeddingChannel
  retrieval/     Query, Candidate, TemporalRelation, Citation
  evaluation/    Dataset, Query, ExpectedEvidence, Run, Metrics

@rag/rag-core
  candidate fusion/dedup/order
  temporal relation/context assembly
  citation formatting/validation/grounded answer
  retrieval and temporal metrics
  provider result write-back gate
```

这些包不依赖 Prisma、PostgreSQL、OpenSearch、RabbitMQ、SQLite、FFmpeg 或模型 SDK。

## 2. 来源和版本

### 2.1 `SourceAsset`

| 字段 | 类型 | 语义 |
|---|---|---|
| `sourceId` | `string` | 稳定来源身份 |
| `kind` | `document \| web_page \| video \| audio \| image` | 来源类型，不等于文件格式 |
| `format` | `string \| null` | 原始格式；允许未来视频/图片格式，不扩大当前文档 Manifest 的上传范围 |
| `title` | `string \| null` | 展示标题 |
| `contentHash` | `string` | 当前来源内容指纹 |

### 2.2 `AssetVersion`

`AssetVersion` 固定不可变内容边界：`sourceVersionId`、`sourceId`、单调 `version`、`contentHash`、创建时间和可选 `durationMs`。文档版本和视频版本都可以实现它；任何 Evidence 必须绑定版本而不是仅绑定文件名或路径。

### 2.3 `SourceFormat` 与 `SourceKind`

当前 `packages/contracts/src/manifests/content.ts` 的 `SourceFormat` 仍表示文档 ingestion 支持的 `pdf/md/json/csv`。本 Spec 的 `SourceKind` 表示资产类型。视频 `mp4`、图片 `png` 等格式进入未来 Video Adapter 时，不应伪造为当前文档 Manifest 已支持的格式。

## 3. Evidence 和 Locator

### 3.1 `EvidenceItem`

```ts
interface EvidenceItem {
  evidenceId: string
  source: {
    sourceId: string
    sourceKind: SourceKind
    sourceVersionId: string
    contentHash: string
  }
  level: 'asset' | 'scene' | 'shot' | 'evidence'
  parentEvidenceId: string | null
  modality: 'text' | 'speech' | 'subtitle' | 'ocr' | 'visual' | 'caption' | 'metadata'
  locator: EvidenceLocator
  text: string | null
  confidence: number | null
  language: string | null
  speakerRef: string | null
  provenance: EvidenceProvenance
  contentHash: string
  security: {
    injectionRisk: 'unknown' | 'none' | 'suspected' | 'blocked'
    availability: 'candidate' | 'published' | 'quarantined' | 'deleted'
  }
}
```

视频最小分层：

```text
AssetVersion
  └── Evidence(level=scene)
        └── Evidence(level=shot)
              ├── Evidence(modality=visual)
              ├── Evidence(modality=speech)
              ├── Evidence(modality=subtitle)
              ├── Evidence(modality=ocr)
              ├── Evidence(modality=caption)
              └── Evidence(modality=metadata)
```

`parentEvidenceId` 只表达证据层级，不是数据库外键协议；Adapter 可用自己的事实模型保存关系。

### 3.2 `EvidenceLocator`

| `type` | 字段 | 用途 |
|---|---|---|
| `page_range` | `startPage`, `endPage` | 文档页码 |
| `character_range` | `start`, `end` | 文档/网页字符范围，半开区间 |
| `bbox` | `page`, `x`, `y`, `width`, `height` | 页面区域；`page` 可为空 |
| `time_range` | `startMs`, `endMs` | 视频/音频片段，整数毫秒 |
| `frame` | `frameNumber`, `timeMs` | 关键帧或抽帧结果 |
| `image_region` | `x`, `y`, `width`, `height` | 图片/帧区域 |
| `url_fragment` | `url`, `selector` | 网页定位 |

公共校验：

- `time_range.startMs` 和 `endMs` 必须是非负整数，且 `endMs > startMs`；
- `character_range.start/end` 为非负整数，且 `end > start`；
- `page_range` 为正整数，且 `endPage >= startPage`；
- `frame.timeMs` 为非负整数；可选 `frameNumber` 也为非负整数；
- 区域坐标是非负有限数，宽高大于 0；源尺寸/归一化范围由 Adapter 按媒体元数据校验；
- Locator 不执行 ACL，不决定 Evidence 是否能进入回答。

### 3.3 `EvidenceProvenance`

每个分析结果至少要带：

```text
providerRef + providerVersion
modelRef + modelVersion
inputFingerprint + outputFingerprint
runId + generation + attempt
producedAt + parentArtifactIds
```

未知模型或无法回溯输入的结果只能作为诊断信息，不能进入正式可引用 Evidence。

## 4. Provider、Artifact 和 Job

### 4.1 任务族

```text
probe
media_extract
segmentation
subtitle
speech
ocr
visual_embedding
caption
text_embedding
rerank
generation
citation_verification
```

这些是公共任务语义，不是某一个 Provider SDK 的命令名。

### 4.2 `ProviderArtifact`

Artifact 保存 `artifactId`、来源版本、Provider/model 版本、输入/输出指纹、Run/Generation/Attempt、`artifactType`、opaque `storageRef`、hash、mime、size 和产出时间。公共层不能假设 `storageRef` 是 S3 URI、Windows 路径或 SQLite blob。

### 4.3 `ProviderRun`

状态：

```text
queued → running → succeeded
             ├── failed → retrying → running
             ├── cancelled
             ├── expired
             └── superseded
```

每次重试都必须保留前一次失败 Attempt/Run 的事实。`outputFingerprint` 成功前可为空，完成后必须写入。

### 4.4 `JobEvent`

事件包含 `jobId`、`runId`、来源版本、Generation、Attempt、单调 `sequence`、类型、时间和受控 payload。payload 不得放媒体二进制、正文、Token、凭证或模型原始思维链。

## 5. Embedding Channel

```ts
interface EmbeddingChannel {
  channelId: string
  modality: 'text' | 'image' | 'video_segment' | 'multimodal'
  providerRef: string
  modelRef: string
  modelVersion: string
  dimension: number
  distance: 'cosine' | 'dot' | 'euclidean'
  normalization: 'none' | 'l2'
}
```

`dimension` 必须是正整数。文档 1024 维是 `DOCUMENT_EMBEDDING_DIMENSION` 兼容基线；未来视觉 channel 可以是其他维度。Channel 身份变化时创建新索引投影，不在旧分区混写。

`wide-1024` 是文档 `ChunkingManifest` 标识；视频切分应由独立 `segmentationRef`/`shotPolicyRef` 表达。

## 6. Retrieval Candidate 和 Citation

### 6.1 Candidate

```ts
interface RetrievalCandidate {
  candidateId: string
  sourceId: string
  sourceVersionId: string
  evidenceId: string
  modality: EvidenceModality
  locator: EvidenceLocator
  channelId: string | null
  retrievalSource: 'lexical' | 'dense' | 'metadata' | 'fusion' | 'rerank'
  score: number
  rank: number
  temporalRelation: TemporalRelation
}
```

`sourceVersionId + evidenceId` 是公共去重身份。`channelId=null` 仅适用于 lexical/metadata 等非向量通道。

### 6.2 Citation

Citation 必须携带 `evidenceId`、源/版本和 Locator，状态为 `unverified`、`verified` 或 `rejected`。任何回跳、展示或生成前验证都必须重新确认 Evidence 的 ACL、删除、过期和注入状态。

## 7. Evaluation

最小对象：

- `EvaluationDataset`：dataset/version/name/queryCount/inputFingerprint/createdAt；
- `EvaluationQuery`：文本、可选图片 Artifact、metadata 和期望 Evidence；
- `ExpectedEvidence`：source/version、可选 evidenceId、modality 和 Locator；
- `EvaluationRun`：dataset、pipeline、Provider refs、input fingerprint、状态和时间；
- `EvaluationResult`：Retrieval、Temporal、Citation、Resource 四类指标。

评测结果必须能回答：使用什么数据、什么 Pipeline、什么 Provider/model/channel、什么输入指纹、多少资源、何时跑的。

## 8. 兼容和演进

- 新增字段只在不改变既有文档契约语义时直接追加；破坏性变更递增 `CONTRACTS_SCHEMA_VERSION` 并新增 ADR。
- 旧文档 `embeddingRef` 由文档 Adapter 映射为一个明确的文档 Embedding Channel；不要求一次迁移所有文档 schema。
- 不把 Seelyn 的表名、768 维向量、SQLite DDL 或私有 Provider 名称写入公共事实模型。
- 不新增 Prisma migration；契约实现不会要求当前 Web RAG 数据库立即承载 Video 表。

## 9. 评审硬化项与实现状态

以下决策已经批准，但尚未全部落地为代码：

| 主题 | 要求 | 状态 |
|---|---|---|
| 文档维度兼容 | 保留 deprecated 的 EMBEDDING_DIMENSIONS 兼容别名，但不恢复全局 embedding 维度语义；1024 只能归属于文档 EmbeddingChannel | 首版已部分落地 |
| Provider 范围 | ProviderRun 显式区分 asset、query、evaluation；范围不能从任务名推断 | 待实施 |
| Artifact 边界 | 统一 manifest、media_metadata、audio、frame、keyframe、thumbnail、subtitle、transcript、ocr、caption、embedding、parse、index_projection kind；staged/complete/failed/finalize 原子完成；输入只接受受控 staging handle、文件描述符或调用方托管流 | 待实施 |
| 事件语义 | 引擎事件映射到领域 JobEvent；幂等键稳定；payload 按事件类型受控 Schema；不携带媒体、正文、Token、凭证或思维链 | 待实施 |
| 索引身份 | Projection 必须保存 projectionId、indexSnapshotId 和完整 channel fingerprint | 首版字段需扩展 |
| Candidate | 增加 scoreKind、scoreDirection、contributions、matchedChannels、projection/index snapshot、visibility 和 answerEligibility；TemporalRelation 方向固定以当前 Candidate 为参照 | 首版字段需扩展 |
| RetrievalQuery | 显式携带 dense channel 选择和查询向量身份/指纹；结构化过滤是平台无关语义，ACL 作为受控外部上下文 | 首版字段需扩展 |
| EvaluationRun | 保存 Pipeline/Provider/Model/Channel/Engine 完整身份、input fingerprint、生命周期、generation、attempt、样本数、聚合口径、分桶和各阶段资源指标 | 首版字段需扩展 |
| Evidence 与指标 | evidenceId 为空时按 source/version/modality/Locator fallback；Evidence 跨字段校验；Temporal IoU 先按 sourceVersionId 对齐 | 首版部分覆盖 |
| 版本互操作 | 统一 Hash/Fingerprint 前缀、编码和规范化；使用版本化 Envelope、JSON Schema、兼容矩阵和 golden fixtures | 待实施 |

Artifact 未 finalize、非 active attempt、未授权 Evidence 或 retrieval-only Candidate 均不能驱动当前索引、回答上下文或发布 Citation。详细任务见 [Video RAG 公共基座实施任务](video-rag-implementation-tasks.md)。
