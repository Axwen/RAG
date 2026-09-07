# Video RAG 公共基座 Phase 1：现状、事实边界与冲突矩阵

> 日期：2026-09-04  
> 分支：`docs/video-rag-foundation`  
> 目的：在修改公共契约和 `rag-core` 之前，固定当前 RAG 基座与 Video RAG 目标之间的冲突、证据等级和最小修订面。
>
> 本文是本分支的 Phase 1 产物。它不是对既有 accepted ADR 的静默覆盖；语义变化通过新增 ADR 显式建立 `revises`/`supersedes` 关系。

## 1. 结论

当前 RAG 基座**不能直接承载 Video RAG**，原因不是 PostgreSQL、OpenSearch、RabbitMQ、MinIO 或 Keycloak 这条 Web 技术路线错误，而是公共语义层仍以文档 Chunk、页码引用和全局 1024 维 Embedding 为默认假设。

修订目标是：

- 文档 RAG 继续使用现有 Web 运行时和企业治理链路；
- Video RAG 复用证据、版本、Provider、检索、引用、评测和纯逻辑协议；
- 本地 Video RAG 使用自己的 SQLite WAL、本地 Artifact Store 和本地 Worker Adapter；
- 不把 FFmpeg、ASR、OCR、VLM、Tauri、SQLite 或视频 Worker 引入 Web RAG 公共核心；
- 不现在创建独立 `video-rag-service`；
- 不把 Video Evidence 降级为 Document 或普通 Chunk。

## 2. 冲突矩阵

| # | 当前事实（仓库证据） | Video RAG 要求 | 冲突等级 | 处理结论 | 计划落点 |
|---:|---|---|---|---|---|
| 1 | `packages/contracts/src` 目前只有 errors、audit、manifests；没有公共 `Evidence`/`Locator`/`Provenance`。解析契约仍围绕 `ParseArtifact` 和文档 Manifest。 | Evidence 必须表达文档、网页、图片、音频和视频的来源、版本、模态、内容及可用性；纯视觉证据允许没有文本。 | P1 | 新增模态无关 Evidence 契约；文档 Chunk 通过 Adapter 映射，不能重命名或替换现有文档事实模型。 | ADR-0041；`packages/contracts/src/evidence/`；Evidence Spec |
| 2 | 现有设计和 `技术设计方案-TS企业级多模态RAG.md` 的引用形状主要是 `chunkId`、页码和字符偏移；没有公共联合 Locator。 | 至少支持 `page_range`、`character_range`、`bbox`、`time_range`、`frame`、`image_region`、`url_fragment`。 | P1 | 新增带运行时校验的联合 `EvidenceLocator`；时间统一为非负整数毫秒。 | ADR-0041；Evidence/Citation tests |
| 3 | 当前 Citation 语义散落在 Answer/技术设计文档中，隐含文档页码；`Citation` 公共类型不存在。 | 引用必须支持文档页/字符、视频时间区间、帧和图片区域，并保留 `evidenceId`。 | P1 | 新增 `Citation` 与 formatter/validator；页码不再是必选定位。 | ADR-0041；`packages/contracts/src/retrieval/`；`rag-core` |
| 4 | `packages/rag-core/src/index.ts` 导出 `EMBEDDING_DIMENSIONS = 1024`；Manifest `vectorPolicy` 以自由 JSON 存 `dimension`，`embeddingRef` 仍是单字符串。ADR-0017/0028 冻结的是文档基线和分区版本语义。 | 维度、距离和归一化属于 Embedding Channel；不同模态可并存，Seelyn 观察到的 768 不能覆盖文档 1024。 | P1 | 保留文档 1024 作为默认 Document channel 事实，但删除其作为全局核心常量的含义；新增 channel 和 index identity 契约，兼容旧 `embeddingRef`。 | ADR-0042；`packages/contracts/src/embedding/`；兼容性测试 |
| 5 | `FROZEN_CHUNKING_MANIFEST_ID = 'wide-1024'` 与 ADR-0031 的冻结记录存在于 `rag-core`，但没有代码层注释/类型约束表明它只适用于文档分块。 | 视频需要 shot/scene/segment policy；不能把 `wide-1024` 当成视频切分或所有模态的通用分段策略。 | P1 | 将文档分块标识改名义为 Document-only；Video 使用 `segmentationRef`/`shotPolicyRef` 字段表达，当前只做契约和计划，不实现切分器。 | ADR-0042；`rag-core` 常量兼容说明；readiness gate |
| 6 | 已批准 ADR-0024 规定文档解析、分块、Embedding、索引和评测走 RabbitMQ；ADR-0038 规定 Parser Service 处理文档/图片解析，VLM 后置。公共 `ProviderRun`/`JobEvent` 尚不存在。 | 视频分析要表达 probe、媒体抽取、字幕/ASR、shot/scene、OCR、视觉 embedding、caption 等独立 Provider/Job 族。 | P1 | 新增 Provider Artifact/Run/Event 契约；视频 Provider 不塞进 DeepDOC Parser。RabbitMQ 仍是 Web Adapter 的实现，不成为公共协议。 | ADR-0043；`packages/contracts/src/providers/` |
| 7 | 当前仓库没有公共任务状态/Attempt/Generation 类型；设计文档虽规定 PostgreSQL 管理取消、重试、DLQ 和 Generation，但未形成可复用结果写回判定。 | 必须支持取消、失败、重试、恢复、过期、superseded；迟到结果不得污染当前索引。 | P1 | 新增可跨运行时实现的 ProviderRun/JobEvent 元数据和纯函数 `canAcceptProviderResult`；数据库/队列状态仍由各 Adapter 管理。 | ADR-0043；Provider tests；`rag-core` |
| 8 | 当前没有 `RetrievalCandidate` 公共类型；OpenSearch 设计主要描述文档索引字段，未保留模态、Evidence locator、channel、retrieval source 和时间关系。 | 候选必须可解释、可去重、可融合、可做 temporal adjacency/diversity/rerank。 | P1 | 新增候选、检索来源、时间关系和查询契约；纯逻辑实现确定性融合、去重、时间邻接和上下文组装。 | ADR-0044；`packages/contracts/src/retrieval/`；`packages/rag-core` |
| 9 | 现有闭合记录、ADR-0024/0026/0037 和技术设计明确了 PostgreSQL + OpenSearch + RabbitMQ + MinIO + Keycloak 的 Web 运行时；本地媒体边界尚未被单独写成公共架构决策。 | 本地 Video RAG 要能采用 SQLite WAL、本地文件 Artifact Store、本地 Worker Supervisor；不能要求本地复制 Web 基础设施。 | P1 | 新增存储/部署适配边界 ADR；不修改或删除 Web 方案，不创建统一数据库/队列抽象来掩盖运行时差异。 | ADR-0043；边界设计文档；Video route |
| 10 | 现有 ADR 已分别覆盖共享知识资产、解析产物、RabbitMQ、ACL、Citation 预算、Embedding 分区、分块、VLM 范围和审计，但没有覆盖模态无关 Evidence、ProviderRun、channel 或本地/Web 适配边界。 | 新语义不能靠修改正文或新增互相重叠 ADR 隐式覆盖。 | P1 | 新增 ADR-0041～0045，逐一标注 `revises`/`supersedes` 关系；旧 ADR 保留其文档 RAG 事实和历史理由。 | `docs/adr/README.md` |
| 11 | `PROJECT_STATE.md` 和工程闭合记录把音视频、多模态向量整体视为后置；ADR-0038 又已将文档图片/OCR 纳入阶段 1、VLM/音频/视频后置。`stage1-implementation-tickets.md` 没有 Video RAG 公共基座票据。 | 不能以“未来支持视频”规避当前契约；同时不能让 Video RAG Worker 反向阻塞文档 RAG 业务链路。 | P1 | 将“公共协议/纯逻辑/评测格式”纳入当前基座增量；把真实媒体处理留在独立 Video route；新增 T17 公共基座票据并明确不改变 T0～T16 的 Web 依赖顺序。 | PROJECT_STATE、闭合记录 §16、stage1 tickets、Video implementation plan |
| 12 | 评测计划有文档 Recall@5、引用可定位率和资源预算，但没有公共 Video Evaluation 数据模型、Temporal IoU、Correct Asset Rate、Citation Precision 和取消后旧结果隔离的成组格式。 | 需要以可回放数据集、Evidence 标注、Provider/模型版本和资源指标判断是否真的变好。 | P1 | 新增 Evaluation 契约、Temporal/Citation metrics 纯逻辑和 Video readiness gate；不复制 Seelyn 原始媒体、转写或数据库。 | ADR-0044；`packages/contracts/src/evaluation/`；`evals/video/README.md` |

## 3. 事实、推断与提案边界

### 3.1 `observed`：可作为事实引用

下列内容来自本仓库或 Seelyn 交接资料中明确标注的事实，引用时必须保留来源等级：

| 等级 | 事实 |
|---|---|
| `repository-fact` | 当前分支为 `docs/video-rag-foundation`，工作区初始状态干净；`@rag/contracts` 目前导出 errors、audit、manifests；`@rag/rag-core` 目前只有冻结常量入口。 |
| `repository-fact` | 当前文档 RAG 的 Web 方案明确使用 PostgreSQL、OpenSearch、RabbitMQ、MinIO 和 Keycloak；RabbitMQ 只承担异步投递，PostgreSQL 是任务/状态事实源。 |
| `repository-fact` | 文档分块标识为 `wide-1024`，文档 Embedding 基线为 1024 维；ADR-0028 已要求 Embedding 变化进入新 IndexPartition，不原地重写。 |
| `repository-fact` | ADR-0038 已将图片 OCR/Office 混合解析纳入文档阶段 1，并将 VLM、音频和视频后置；它没有定义 Video Worker 或视频证据契约。 |
| `observed-static` | Seelyn 安装包证据出现 FFprobe/FFmpeg、speech/Whisper/CrispASR、asset vision/SigLIP、GTE/ONNX、Qwen 等运行时/模型线索，以及 Tauri/Rust source path hints；这不等于恢复了源代码或证明了完整行为。 |
| `observed-static` / `observed-runtime` | Seelyn 只读 SQLite 证据显示 WAL、`videos`、`video_segments`、`speech_segments`、FTS 和多个向量投影；运行时任务摘要显示 visual/speech 分析任务和阶段形状。字段/表属于观察样本，不是本仓库的公共 schema。 |
| `observed-static` | Seelyn 二进制信号中出现按语音、视觉、图片搜索、分析暂停/恢复/停止和 rough-cut 的路由字符串；字符串信号不能单独证明完整 API 语义。 |

### 3.2 `high-confidence-inference`：基于事实的设计推断

| 推断 | 依据 | 限制 |
|---|---|---|
| 当前公共语义层对 Video RAG 不足 | 没有 Evidence/Locator/ProviderRun/RetrievalCandidate/Evaluation 公共类型，且 `rag-core` 只有文档冻结常量。 | 这是接口缺口判断，不代表文档 RAG 已经实现失败。 |
| 文档和视频需要共享协议而非共享存储 | 证据引用、版本化、候选排序和指标可抽象；Web 中间件与本地媒体处理的资源/生命周期约束不同。 | 具体 Adapter API 仍需在真实 Video V0 试验中校准。 |
| Evidence 需要独立于 Chunk | 文档 Chunk 依赖解析/分块；视频 shot/scene/语音/OCR/视觉证据的边界和定位不相同。 | 文档侧仍需后续实现 Chunk → Evidence Adapter。 |
| ProviderRun 的来源版本、Run、Generation/Fingerprint/Attempt 是防止迟到结果污染的最小充分元数据集合 | 任务取消/重试/恢复会有并发和旧结果写回窗口。 | 具体数据库 CAS、lease、队列 ACK 由运行时 Adapter 负责。 |
| Channel 维度必须进入索引身份 | 不同模态/模型的向量空间不一定可比较，且重建需要区分旧投影。 | 具体索引引擎字段和本地向量实现不在本次公共核心范围。 |

### 3.3 `proposal`：本次设计提案

下列内容是本分支为未来产品提出的方案，不应写成 Seelyn 已实现的事实：

- `EvidenceItem`、`EvidenceLocator`、`EvidenceProvenance`、`ProviderArtifact`、`ProviderRun`、`JobEvent`、`EmbeddingChannel`、`RetrievalCandidate`、`Citation` 和 Evaluation 类型的具体字段形状；
- 使用 `startMs`/`endMs` 的非负整数毫秒规范及所有运行时校验；
- 候选融合、去重、时间邻接、上下文组装、引用校验、Temporal IoU、Recall@K、MRR/nDCG 和 Grounded Answer 判定的纯逻辑算法；
- Web Adapter 继续使用 PostgreSQL/OpenSearch/RabbitMQ/MinIO/Keycloak，本地 Adapter 使用 SQLite WAL/本地 Artifact Store/本地 Worker；
- T17 公共基座批次和 Video RAG readiness gate；
- 后续真实媒体导入、FFprobe/FFmpeg、字幕/ASR、shot/scene、OCR、视觉 embedding、文字/图片搜画面、时间线跳转和资源基准。

## 4. 首轮需要修改的文件清单

### 必改

1. `docs/adr/README.md`：登记新增 ADR-0041～0045。
2. `docs/adr/0041-modality-neutral-evidence-and-citation.md`：Evidence/Locator/Provenance/Citation 决策。
3. `docs/adr/0042-embedding-channel-and-index-identity.md`：Channel、维度和文档分块边界决策。
4. `docs/adr/0043-provider-run-and-runtime-adapter-boundary.md`：Provider/Artifact/Job、Generation/Fingerprint 和 Web/本地运行时边界。
5. `docs/adr/0044-retrieval-evaluation-and-video-readiness.md`：候选、评测、时间定位和 readiness gate 决策。
6. `docs/adr/0045-shared-media-engine-and-three-repository-boundary.md`：共享 Rust Media Engine 与 Web/Desktop 三仓库边界决策。
7. `packages/contracts/src/evidence/`、`providers/`、`embedding/`、`retrieval/`、`evaluation/` 及 `src/index.ts`：公共类型；`packages/rag-core/src/contract-validation.ts`：边界校验。
8. `packages/rag-core/src/` 及对应 tests：存储无关纯逻辑；删除全局 Embedding 维度语义但保留兼容别名说明。
9. `docs/design/video-rag-foundation-architecture-review.md`：完整架构 review 和边界。
10. `docs/engineering/video-rag-public-contract-spec.md`：契约字段、校验和兼容策略。
11. `docs/engineering/video-rag-rag-core-spec.md`：纯逻辑输入/输出、不变量和测试向量。
12. `docs/engineering/video-rag-readiness-gate.md`：Video RAG 进入真实实现的门禁。
13. `docs/engineering/video-rag-implementation-plan.md`：批次、依赖、运行时适配和后续路线。
14. `docs/engineering/video-rag-evaluation-plan.md`、`evals/video/README.md`：评测数据格式、指标和资源基准。
15. `docs/engineering/tickets/T17-video-rag-public-foundation.md`：可独立执行的公共基座票据；在主 Ticket 地图和闭合记录挂链。
16. `PROJECT_STATE.md`、`docs/engineering/plan-eng-review-closure.md`、`docs/engineering/stage1-implementation-tickets.md`：登记本次增量，不改变 Web 主线和已批准文档事实。

### 明确不改

- `packages/database/prisma/schema.prisma` 和迁移：本轮不新增 Video 表或本地 SQLite schema。
- `services/parser`：不把视频分析塞进 DeepDOC Parser。
- `infra/compose/`：不把本地 Video RAG 运行时加入 Web Compose。
- `apps/api`/`apps/worker` 的 Video Worker：当前不存在，也不在本轮创建。
- Seelyn 逆向仓库、用户媒体、真实转写、授权信息、模型权重和原始数据库。

## 5. Phase 1 验收

### Review 后续落点

Phase 1 矩阵识别出的公共语义冲突已通过 ADR-0041～0045 建立修订关系。首版实现仍需按 [Video RAG 公共基座实施任务](video-rag-implementation-tasks.md) 关闭运行时校验、Envelope/Hash、Candidate/Query/Evaluation 身份、确定性算法、跨语言 conformance 和 Adapter 恢复测试；这些任务不改变文档 RAG 的 PostgreSQL/OpenSearch/RabbitMQ/MinIO/Keycloak 路线。

- [x] 已先记录 `git status --short --branch`。
- [x] 已阅读目标仓库的 `AGENTS.md`、`PROJECT_STATE.md`、`CONTEXT.md`、ADR 索引、工程闭合记录、实施 Ticket 地图、`packages/contracts/src` 和 `packages/rag-core/src/index.ts`。
- [x] 已只读阅读 Seelyn 目标基线、交接资料和四份 live evidence JSON；未复制任何媒体、转写、授权信息、模型权重或数据库。
- [x] 已区分 `repository-fact`、`observed-static/runtime`、`high-confidence-inference` 与 `proposal`。
- [x] 已列出冲突、ADR/契约/计划/测试修改面。
- [x] 架构 Review、公共契约实现、`rag-core` 实现和验证已在后续 Phase 2～5 完成；结果见 [架构 Review](../design/video-rag-foundation-architecture-review.md)、[公共契约 Spec](video-rag-public-contract-spec.md)、[`rag-core` Spec](video-rag-rag-core-spec.md) 和本分支验证记录。
