# T17：Video RAG 公共基座

## 目的

在不改变文档 RAG Web 运行时的前提下，把公共语义层从“文档 Chunk + 页码 + 全局 Embedding”提升为可承载未来 Video RAG 的 Evidence、Provider、Channel、Candidate、Citation 和 Evaluation 协议。

T17 是跨切面公共基座 Ticket，不等于 Video RAG 运行时已经实现，也不把文档 RAG 的 PostgreSQL、OpenSearch、RabbitMQ、MinIO、Keycloak 替换为本地设施。

## 批次划分

### V0a：公共协议与纯逻辑首版（当前分支已落地）

- 新增 ADR-0041～0045；
- 新增 `@rag/contracts` 的 evidence/providers/embedding/retrieval/evaluation 类型契约，以及 `@rag/rag-core` 的边界校验；
- 新增 `@rag/rag-core` 的候选融合、去重、确定性排序、时间邻接、上下文组装、Citation 格式化/校验、Temporal IoU、Recall/MRR/nDCG、Grounded Answer 和 Provider 结果写回门禁；
- 新增协议单测、冲突矩阵、架构 Review、契约 Spec、纯逻辑 Spec、readiness gate 和评测计划。

### V0b：公共基座硬化（后续）

- 完成 D11～D49 对应的运行时校验、版本化 Envelope、Artifact/事件状态、Candidate/Query/评测身份和确定性算法约束；
- 建立 JSON Schema、跨语言 conformance fixtures/golden outputs，以及取消/重试/恢复/旧结果隔离的 Adapter 集成测试；
- 不将媒体引擎、数据库、队列、对象存储或模型 SDK 引入公共核心。

任务分解见 [Video RAG 公共基座实施任务](../video-rag-implementation-tasks.md)。

### V1：文档 Adapter 对齐（后续）

- 将现有文档 Chunk/ParseArtifact 映射为 Evidence；
- 不改变当前文档事实表、ACL、Release、AnswerSnapshot 和 Web 中间件；
- 增加旧文档 Citation/检索结果兼容测试。

### V2：本地 Video Adapter（后续）

- Asset/AssetVersion、SQLite WAL、本地 Artifact Store 和 Worker Supervisor；
- FFprobe/FFmpeg、字幕/ASR、shot/scene、OCR、视觉 Embedding 和片段检索；
- 通过 readiness gate 分阶段验收，不进入本 Ticket 的公共核心。

## 三仓库落地边界

T17 V0 的公共协议先落在当前 Web RAG 仓库；三仓库的可复制规划资料见 [Video RAG 三仓库规划包](../../architecture/repositories/README.md)。

- 当前 Web RAG：继续承载 `packages/contracts`、`packages/rag-core`、文档 RAG Web 主线和未来 `MediaEngineAdapter` 预留；
- `scene-core`：规划资料已落到独立目录，git 尚未初始化；后续承载 Rust 媒体引擎、FFmpeg/FFprobe 和 Artifact Manifest；
- `scene-seek`：规划资料已增量迁移至既存仓库，当前无提交；后续承载 Tauri、本地 SQLite WAL、Artifact Store、Worker、时间线和本地 AI Adapter；
- 三方共享语义协议、纯逻辑、测试向量和评测格式，不共享数据库、消息队列、对象存储或部署拓扑。

该边界不扩大 T17 V0 的实现范围，也不表示真实媒体运行时已经实现。

## 当前范围

### 可以进入 RAG 基座

- Evidence、SourceAsset、AssetVersion、Locator、Provenance；
- ProviderArtifact、ProviderRun、JobEvent、版本/指纹/Attempt/Generation；
- EmbeddingChannel；
- RetrievalCandidate、TemporalRelation、Citation；
- EvaluationDataset、EvaluationQuery、ExpectedEvidence、EvaluationRun 和指标；
- 融合、去重、时间关系、上下文、Citation 校验和评测纯逻辑。

### 禁止进入 RAG 基座

- FFmpeg、FFprobe、ASR、OCR、VLM/Caption；
- Tauri、Rust、SQLite、本地文件监控或本地模型进程管理；
- 视频专用 Worker；
- 独立 Video RAG 服务；
- 用户媒体、真实转写、授权信息、模型权重和原始数据库。

## 不变量

```text
sourceVersionId 不一致 → 拒绝旧结果写回
generation 不一致 → 拒绝旧结果写回
inputFingerprint 不一致 → 拒绝旧结果写回
取消或 superseded 的 run → 不能改变当前索引
Embedding 维度属于 EmbeddingChannel
Citation 支持 time_range，不能假设所有来源有 page
Video Evidence 不是普通 Document Chunk
公共核心只依赖 `@rag/contracts` 与本包纯逻辑，不引入数据库、队列、媒体工具或模型 SDK
Web RAG 继续使用 PostgreSQL、OpenSearch、RabbitMQ、对象存储适配器和 Keycloak，不被本地 Video RAG 替换
预算账本、审计写入口和 Prisma 依赖留在 Web RAG 的 database/config/contracts 边界，不进入 `rag-core`
合并时保留 Asset → Scene/Shot → Evidence、多通道 Evidence、time_range、frame/image_region、EmbeddingChannel 和句级 Citation 语义
```

## 依赖和并行关系

- V0 不依赖 T2～T16 的业务实现，可与文档 RAG 主线并行；
- V1 依赖文档 Chunk/ParseArtifact 的实际 Adapter 入口，但不要求文档全部功能完成；
- V2 依赖 V0 稳定、G0 真实媒体边界和脱敏评测数据；
- 真实 Video RAG 不阻塞当前客服文档 RAG 的 Web 交付。

## 验证

V0：

- `pnpm run check:links`；
- `pnpm run typecheck`；
- `pnpm run test`；
- 可用时 `pnpm run verify`；
- 确认 `rag-core` 不导入数据库、队列、媒体工具和模型 SDK。

V1/V2 追加 readiness gate 中的真实媒体、恢复、片段检索、时间定位和资源基准验证。

## V0b 前置：T6/T7/T8 与 `rag-core` 的复用边界

V0b 开工前不得在 T6/T7/T8 中凭调用方猜测重写已有纯逻辑；按下表处理，新增例外必须在对应票据中写明原因：

| 既有函数/能力 | 后续票据 | 口径 |
|---|---|---|
| `compareCandidates`、`sortAndRankCandidates`、`deduplicateCandidates`、`fuseCandidateLists`、`diversifyCandidates` | T6 | **T6 直接复用**候选融合、去重和确定性排序；`acl_scope_key` 的编译和权威授权复核另留在授权/数据库边界，不复制进 `rag-core`。 |
| `rerankCandidates` 与 `RERANK_OUTPUT_TOP_K` | T7 | **T7 直接复用**排序核心；Top-5、Provider 输入预算和调用准入由 T7/ModelAdapter 入口负责，不把供应商调用塞进 `rag-core`。 |
| `validateEvidenceLocator`、`isEvidenceLocator`、`formatLocator`、`formatCitation`、`validateCitation`、`isGroundedAnswer` | T8 | **T8 直接复用**公共 Locator/Citation 语义；授权判定、最终发布策略和高风险验证由调用方注入或在边界层完成。 |
| `assembleContext` | T8 | **待定**：先保留当前安全状态过滤；T8 出现真实授权调用方后，决定直接扩展输入还是另建适配函数，并记录原因。 |
| `timeRangeFromLocator`、`temporalRelationBetween`、`annotateTemporalRelations`、`temporalIoU`、`bestTemporalIoU` | T6/T7/T8 | **待定**：这些函数不属于当前三张票的主要交付面；若调用方需要改动，优先扩展现有函数并补跨模态回归，不另起同义实现。 |

## V0b 追加不变量

Artifact 未 finalize → 不能驱动 Evidence/索引写回  
非 active attempt → 不能写回当前索引  
检索可见性 != 回答资格  
Embedding 维度、score 方向和索引 projection identity 必须显式携带  
EvaluationRun 必须可按 dataset/pipeline/provider/model/channel/engine 重放

## DoD

- [x] 已新增公共契约和纯逻辑实现；
- [x] 已建立事实/推断/提案边界和现状冲突矩阵；
- [x] 已新增 ADR 并建立与既有 ADR 的修订关系；
- [x] 已区分文档 `wide-1024` 与视频 segmentation；
- [x] 已加入时间化 Citation、Provider 旧结果隔离和 Evaluation 指标；
- [x] 已对 `sameLocator` 的文档与视频 Locator 分支建立回归覆盖；
- [x] 已写明 T6/T7/T8 与 `rag-core` 纯逻辑的复用边界；
- [x] `contracts` / `rag-core` 依赖纯净性、覆盖率棘轮余量和无迁移/无真实媒体实现均有独立验收判据；
- [ ] 文档 Chunk → Evidence Adapter；
- [ ] 真实媒体导入和 Video V0/V1/V2/V3；
- [ ] FFmpeg、ASR、OCR、VLM、Tauri、本地 Worker 和独立服务（明确由后续路线决定，不属于 V0 DoD）。
