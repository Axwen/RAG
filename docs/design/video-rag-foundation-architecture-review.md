# Video RAG 公共基座架构 Review

> 日期：2026-09-04  
> 评审对象：当前企业级文档 RAG 基座与未来本地 Video Intelligence / Video RAG 目标  
> 评审状态：`CLEARED_WITH_REQUIRED_FOUNDATION_CHANGES`  
> Phase 1 证据矩阵：[Video RAG 公共基座 Phase 1：现状、事实边界与冲突矩阵](../engineering/video-rag-foundation-conflict-matrix.md)

## 1. 总结结论

现有基座的 Web 架构方向成立，但公共语义层还不能直接承载 Video RAG。必须先完成一轮**公共基座泛化**：

```text
文档 Chunk / 视频 Shot-Scene / 语音-字幕-OCR-视觉-Caption-元数据
                              │
                              ▼
                 Evidence + Locator + Provenance
                              │
                              ▼
      Provider/Job 版本化 → Channel 化索引 → Candidate/Citation/Evaluation
```

本 Review 的明确结论：

1. 保留文档 RAG 的 PostgreSQL、OpenSearch、RabbitMQ、MinIO、Keycloak 和 ACL 两段授权设计。
2. 共享协议、语义模型、`rag-core` 纯逻辑和评测格式；不共享数据库、消息队列、对象存储或部署拓扑。
3. 文档 `wide-1024` 仍是当前文档分块基线，但不是所有模态的分段策略；Embedding 1024 仍可作为文档 channel，不能是全局常量。
4. Video Evidence 以 Asset → Scene/Shot → Evidence 表达；不把视频改造成 Document，也不把视频 Provider 塞进 DeepDOC Parser。
5. 取消、重试、恢复、superseded 和旧结果隔离必须先有公共元数据契约；真正的 CAS、事务、队列 ACK 和本地进程控制由 Adapter 实现。
6. 当前不创建独立 `video-rag-service`，不实现 FFmpeg、ASR、OCR、VLM、Tauri 或本地视频 Worker。

## 2. 领域边界和数据流

### 2.1 共享语义边界

公共层可以承载以下稳定语义：

- 来源资产、不可变版本和 Evidence 身份；
- page/character/bbox/time/frame/image-region/url-fragment Locator；
- Provider、Artifact、Run、JobEvent 及输入/输出指纹；
- Embedding Channel 和分区身份；
- Candidate、TemporalRelation、Citation 和评测指标；
- 融合、去重、排序、时间关系、引用验证和评测计算。

公共层不能感知以下实现细节：

- Prisma、PostgreSQL、OpenSearch、RabbitMQ、MinIO、SQLite；
- FFmpeg argv、Windows 路径、Tauri command、进程句柄；
- 具体模型 SDK、向量库 API 或 Provider 私有响应格式。

### 2.2 文档 RAG 数据流

```text
DocumentVersion
  → Parser/ParseArtifact
  → Document Chunk + wide-1024
  → document Embedding Channel
  → PostgreSQL/OpenSearch/RabbitMQ/MinIO
  → ACL pre-filter + candidate authority recheck
  → Evidence projection + Citation + AnswerSnapshot
```

已有文档领域事实继续由 [ADR-0021](../adr/0021-multi-format-parser-artifact.md)、[ADR-0026](../adr/0026-acl-scope-key-and-authoritative-recheck.md)、[ADR-0028](../adr/0028-embedding-version-partition-and-rebuild.md) 和 [ADR-0038](../adr/0038-vlm-parser-backend-and-multimodal-scope.md) 约束。

### 2.3 本地 Video RAG 数据流

```text
Video/Audio/Image Asset
  → AssetVersion + media metadata
  → probe / media extract / segmentation
  → Scene/Shot
  → speech / subtitle / OCR / visual / caption / metadata Evidence
  → sparse + per-channel dense projections
  → candidate fusion + temporal adjacency + diversity + rerank
  → time-located search / Citation / grounded answer / export
```

推荐的本地事实源和投影：

| 层 | 本地实现 | 公共层可见内容 |
|---|---|---|
| 事实源 | SQLite WAL | AssetVersion、ProviderRun、JobEvent、Evidence 元数据 |
| Artifact | 本地文件 Artifact Store | `storageRef`、hash、mime、size、Provider provenance |
| Worker | 本地 Worker Supervisor | ProviderRun/JobEvent 状态 |
| 稀疏索引 | SQLite FTS 或同类 Adapter | lexical Candidate |
| 向量索引 | 由评测选择的 channel-specific Adapter | dense Candidate + channelId |
| UI | Tauri/Rust 或其他本地 UI | Citation Locator、时间线跳转 |

## 3. 架构 Review 结果

### 3.1 数据模型和领域边界

**通过条件：** Evidence 不是 Chunk 的别名，AssetVersion 是来源版本边界，ProviderRun/Projection/Citation 各自保持正交状态。

**发现与处理：**

- 当前仓库已有文档版本和 Manifest 语义，但没有公共 Evidence 层；新增 `EvidenceItem.level` 和 `parentEvidenceId` 表达 Asset → Scene/Shot → Evidence。
- 不新增 Prisma Video 表；文档事实表和未来本地 SQLite 事实表由各自 Adapter 管理。
- Asset、AssetVersion、Evidence 和 Projection 的删除/可用性必须保持可区分；`EvidenceSecurity.availability` 只是公共投影，不替代各运行时生命周期。

### 3.2 Evidence、Locator、Provenance

**通过条件：** 任何可检索/可引用结果都能回答“来自哪个源版本、哪个模态、哪里、由谁产生、是否可用于回答”。

- 文档可使用 page/character/bbox；视频可使用 time/frame；图像可使用 image-region；网页可使用 URL fragment。
- `time_range` 仅接受整数毫秒，`startMs >= 0`、`endMs > startMs`。
- 纯视觉 Evidence 的 `text` 可以为 `null`；向量通过 Channel/Projection 关联。
- 引用回跳时重新做 ACL、删除、过期和注入风险检查。

### 3.3 Provider 和 Artifact

**通过条件：** Provider 结果可追溯、可比较、可拒绝迟到写回。

- Provider 任务按任务族区分，视频的 `probe`、`segmentation`、`speech`、`ocr` 和 `visual_embedding` 不伪装成 DeepDOC。
- Artifact 只存 opaque `storageRef` 和元数据；不在公共契约中传媒体二进制。
- `sourceVersionId`、Provider/model 版本、input/output fingerprint、run/generation/attempt 必须随结果传播。

### 3.4 Embedding Channel 和索引分区

**通过条件：** 不同向量空间不能混写，模型或维度变更可构建新分区并回滚。

- 当前文档 1024 维基线进入 `DOCUMENT_EMBEDDING_DIMENSION`，属于文档 Channel；`@rag/rag-core` 不再导出全局维度。
- `channelId` 是 Candidate 必填字段；lexical/metadata 使用 `null`。
- `IndexPartition` 仍由 Web 端按 ADR-0028 维护，未来本地 Adapter 也必须把 Channel/版本纳入投影身份。
- `wide-1024` 仅能出现在文档分块 Manifest；视频必须使用独立 `segmentationRef`。

### 3.5 Retrieval Candidate、Fusion、Rerank

**通过条件：** 结果可解释且不依赖某个索引引擎。

候选在融合前保留 lexical/dense/metadata 来源；融合后通过确定性规则排序和去重。时间邻接只是额外关系，不能替代结构化过滤或 ACL 权威复核。

当前 `rag-core` 实现的最小闭环是：

1. 加权 RRF Candidate fusion；
2. `sourceVersionId + evidenceId` 去重；
3. score/rank/source/version 的确定性排序；
4. 同一素材版本候选的 TemporalRelation 标注；
5. 可用 Evidence 上下文组装；
6. 给后续 Adapter 留出 diversity/rerank 输入。

### 3.6 Citation 和 Temporal Grounding

**通过条件：** Citation 不要求 page，且无法验证的 Citation 不得被格式化为已验证事实。

- Citation 携带 `evidenceId`、源/版本和 Locator；验证由 `rag-core` 纯逻辑执行。
- `time_range` 格式化为 `HH:MM:SS.mmm-HH:MM:SS.mmm` 或短时钟形式；帧、bbox、区域和 URL 也有确定性格式。
- `Grounded Answer` 的每个非空事实句至少要有一个通过当前 Evidence 校验的 `verified` Citation。
- 未解决冲突仍服从 [ADR-0033](../adr/0033-deterministic-evidence-conflict-resolution.md)，不得由模型隐式裁决。

### 3.7 任务状态、幂等和旧结果隔离

**通过条件：** 新一代、新输入、取消或 superseded 的结果都不能写回当前索引。

公共门禁固定为：

```text
current status ∈ {running, retrying}
AND sourceVersionId 相同
AND runId 相同
AND generation 相同
AND inputFingerprint 相同
AND attempt 相同
→ 允许进入 Adapter 的事务/CAS 写回
```

否则拒绝。数据库事务、本地 SQLite 事务、RabbitMQ ACK、Worker 进程停止和 lease 恢复由 Adapter 负责；公共核心不假装提供 exactly-once。

### 3.8 权限、删除、过期、注入和审计

- 文档 Web 端继续按 ADR-0026/0037 由 PostgreSQL 编译 ACL scope，候选合并后做权威复核。
- 本地 Video RAG 需要在其本地边界定义可见性、删除和过期策略；公共 Locator 不承担权限。
- `injectionRisk=blocked`、删除、隔离的 Evidence 不能组装进上下文或 Citation。
- 领域审计仍按 ADR-0040 走业务事实源；遥测和 JobEvent 不应变成另一套领域审计。
- 不把正文、媒体、Token、凭证和模型思维链放进公共事件载荷。

### 3.9 部署边界

| 能力 | 文档 RAG Web | 本地 Video RAG |
|---|---|---|
| 业务事实 | PostgreSQL/Prisma | SQLite WAL Adapter |
| 检索索引 | OpenSearch | SQLite FTS + channel-specific local index Adapter |
| 异步调度 | RabbitMQ + Outbox | Local Worker Supervisor |
| Artifact | MinIO/ObjectStorageAdapter | 本地文件 Artifact Store |
| 身份/授权 | Keycloak + 业务授权 | 本地应用权限策略，由 Video 产品另行定义 |
| 公共共享 | Contracts、纯逻辑、评测格式 | Contracts、纯逻辑、评测格式 |

不以“共享协议”为理由建立统一数据库、统一消息队列或统一部署平台。

### 3.10 测试、评测、性能和恢复

必须同时验证成功与失败路径：

- Locator 非法区间、Citation 错位、blocked/deleted Evidence；
- 多路候选重复、分数相同、输入顺序不同；
- run 取消、generation 变化、inputFingerprint 变化、attempt 重试；
- Recall@K、MRR、nDCG、Correct Asset Rate、Temporal IoU、Citation Precision；
- 查询 P50/P95、峰值内存、磁盘/WAL 增长、CPU/GPU 资源；
- 无音轨、无字幕、文件消失、Provider 不可用、SQLite lock 和迟到结果。

完整格式见 [Video RAG 评测计划](../engineering/video-rag-evaluation-plan.md)。

### 3.11 是否现在拆独立服务

**结论：否。** 当前只有一个未来本地运行时 Adapter，尚无两个稳定消费者、容量数据或跨团队部署边界。先共享协议和测试向量；只有当 Web Video RAG 和本地 Video RAG 都稳定运行、并且容量/发布/隔离需求证明独立服务能降低真实复杂度时，才重新评估拆分。

### 3.12 三仓库与共享 Rust Media Engine

用户确认的落地形态是三个仓库，而不是把所有实现继续堆进当前 Web RAG：

| 仓库 | 负责 | 不负责 |
|---|---|---|
| 当前 Web RAG | Web 控制面、企业存储/治理、公共契约、`rag-core`、服务端 AI Adapter、MediaEngineAdapter | FFmpeg、Tauri、SQLite、本地 Worker、媒体引擎实现 |
| `scene-core` | Rust 媒体处理、FFmpeg/FFprobe 周边、媒体 Artifact/Manifest、进度/取消/资源 | 数据库、队列、对象存储、权限、RAG、AI SDK |
| `scene-seek` | Tauri 工作台、本地 SQLite/Artifact/Worker、时间线、索引和本地 AI Adapter | Web 的 PostgreSQL/RabbitMQ/Keycloak 依赖、引擎内部实现 |

Web 和桌面通过固定版本的引擎协议协作；初期优先同机 CLI/Worker + JSON/JSONL，不预先建立 HTTP/gRPC 媒体服务。向量化、关键字查询、Rerank 和评测共享语义和纯逻辑，但检索后端、模型进程、持久化和资源管理由各平台 Adapter 实现。

详细边界、调用时序、兼容策略和迁移到目标仓库的规则见 [三仓库规划包](../architecture/repositories/README.md) 与 [ADR-0045](../adr/0045-shared-media-engine-and-three-repository-boundary.md)。

## 4. 新增/修订 ADR

| ADR | 决策 | 与既有事实的关系 |
|---|---|---|
| [0041](../adr/0041-modality-neutral-evidence-and-citation.md) | 模态无关 Evidence、Locator、Provenance、Citation | 不删除文档 Chunk/ParseArtifact/AnswerSnapshot，扩展公共投影语义 |
| [0042](../adr/0042-embedding-channel-and-index-identity.md) | Embedding Channel 归属维度和索引身份，文档分块与视频分段分离 | 保留文档 1024 和 ADR-0028 重建语义 |
| [0043](../adr/0043-provider-run-and-runtime-adapter-boundary.md) | ProviderRun/Artifact/JobEvent、旧结果隔离和 Web/本地 Adapter | RabbitMQ 仍是 Web 选择，视频不塞进 DeepDOC |
| [0044](../adr/0044-retrieval-evaluation-and-video-readiness.md) | Candidate、Temporal Grounding、Evaluation 和 readiness gate | 保留 ACL、冲突、引用和删除门禁 |
| [0045](../adr/0045-shared-media-engine-and-three-repository-boundary.md) | 共享 Rust Media Engine 与 Web/Desktop 三仓库边界 | 保留 Web 基础设施；媒体处理通过 Adapter 接入 |

## 5. 交付状态和未解决问题

本轮已经落地公共 TypeScript 契约和 `rag-core` 纯逻辑的首版，但本 Review 不把首版实现误判为完整的 V0 基座。以下事项保留到后续 Video route：

- 真实媒体导入、hash、FFprobe、FFmpeg 和 Artifact 清理；
- 字幕导入、ASR、OCR、shot/scene、视觉 embedding、caption/VLM；
- 本地 SQLite schema、FTS/向量 Adapter、Worker Supervisor 和 Tauri；
- 具体模型、维度、距离、采样频率、切分阈值、融合权重和 rerank 参数；
- 本地权限、删除、恢复、导出和时间线 UI 的人工验收。

这些不是被“未来支持视频”掩盖的缺口，而是 readiness gate 明确要求用真实媒体和可重复评测关闭的后续工程。

## 6. 评审后硬化结论

### 6.1 当前状态口径

| 层次 | 当前结论 | 进入下一阶段的条件 |
|---|---|---|
| 语义方向 | `Evidence`、`Locator`、`Provenance`、`ProviderRun`、`EmbeddingChannel`、`Candidate`、`Citation` 和 `Evaluation` 已形成首版公共形状 | 完成运行时校验、Envelope/兼容矩阵和跨语言 conformance fixture |
| `rag-core` | 已有首版融合、去重、时间关系、上下文、引用、指标和写回门禁 | 完成确定性全序、候选预算、非法分数拒绝、邻接复杂度和 Top-K 口径硬化 |
| Web RAG | PostgreSQL、OpenSearch、RabbitMQ、Object Storage、Keycloak 和文档主链保持不变 | 文档 Adapter 和未来 MediaEngineAdapter 通过 Web 任务、ACL、预算、审计和发布测试 |
| Video RAG | 尚未进入真实媒体实现，最多为 `CONTRACT_READY` | G0～G4 readiness gate 的真实媒体、恢复、效果和资源证据全部满足 |

### 6.2 已批准的硬化决策登记

下表是本轮架构 Review 的执行口径。它们是提案已获确认，不表示每项代码已经完成；实现任务见 [Video RAG 公共基座实施任务](../engineering/video-rag-implementation-tasks.md)。

| 决策 | 已批准口径 | 主要落点 |
|---|---|---|
| D11–D13 | Provider 执行范围区分 `asset/query/evaluation`；引擎事件映射到领域事件；Artifact 使用统一 kind taxonomy | contracts、引擎协议、Adapter |
| D4–D6、D25 | 引擎请求透传 `executionContext`；Artifact 使用 staged/complete/failed/finalize 原子完成语义；媒体输入只能使用受控 staging handle/文件描述符；先固定最小 Media Engine 发布契约 | Web/Desktop Adapter、`scene-core` |
| D7、D19–D21、D30、D34、D37、D47、D49 | Candidate 保留 contributions/matchedChannels、score kind/direction、projection/index snapshot、检索可见性与回答资格；TemporalRelation 方向固定；排序、分数校验、预算和 Top-K 语义确定性 | `rag-core`、检索 Adapter |
| D8、D10、D46、D48 | Temporal adjacency 按最近时间邻居；Temporal IoU 先按 `sourceVersionId` 对齐；邻接采用 O(n log n) 或近似线性实现；best IoU 使用单次循环 | `rag-core` |
| D9、D18、D22、D45 | 只有当前 active attempt 能写回；事件幂等键、恢复规则和 EvaluationRun 生命周期统一；取消、重试、恢复和 superseded 必须有 Adapter 集成测试 | contracts、Adapter、集成测试 |
| D14–D16、D23、D33、D44 | Query 显式携带 dense channel/向量身份；EvaluationRun 保存完整 Pipeline/Provider/Model/Channel/Engine 可重放身份、生命周期、样本数、聚合口径、分桶和资源指标；建立确定性 Evaluation runner | contracts、评测 Runner |
| D15、D32 | 结构化过滤语义进入公共 Query；ACL 作为受控外部上下文；Context Assembly 只接收已授权 Evidence 或授权判定结果 | contracts、`rag-core`、平台 Adapter |
| D17、D26、D28、D35、D36、D40、D41 | `evidenceId=null` 支持 source/version/modality/Locator fallback；Evidence 跨字段校验；统一 ID、Hash/Fingerprint 和内部校验工具；补齐运行时校验、边界和属性测试 | contracts、测试 |
| D24、D27、D29、D39、D42、D43 | TypeScript/Rust 通过 JSON Schema、版本化 Envelope、受控事件 payload、Hash 规范、golden outputs 和 Web/Desktop E2E 矩阵保持一致 | 跨仓库 conformance、CI/手工门禁 |
| D31、D38 | Context 支持视觉 Artifact/content reference；Citation 区分诊断格式化与最终可发布校验 | `rag-core`、UI/API Adapter |

### 6.3 失败模式上的硬门禁

以下条件任何一个失败，都不能把结果写入当前 Evidence、索引或 Release：

```
sourceVersionId / runId / generation / inputFingerprint / active attempt 任一不一致
→ 拒绝写回

Run 已 cancelled / superseded / expired，或 Artifact 未 finalize
→ 拒绝写回

Candidate 分数、权重、rank、Locator 或 channel 身份非法
→ 拒绝进入融合/回答

Evidence 未经过 ACL/可见性授权，或 injectionRisk=blocked
→ 只能保留诊断事实，不能进入回答上下文或发布 Citation
```

这些是跨运行时不变量；数据库 CAS、SQLite 事务、队列 ACK、进程终止和文件清理由各 Adapter 负责，不能由纯逻辑函数冒充 exactly-once。

## 7. 相关正式文档

- [Phase 1 冲突矩阵](../engineering/video-rag-foundation-conflict-matrix.md)
- [公共契约 Spec](../engineering/video-rag-public-contract-spec.md)
- [`rag-core` 纯逻辑 Spec](../engineering/video-rag-rag-core-spec.md)
- [Video RAG readiness gate](../engineering/video-rag-readiness-gate.md)
- [Video RAG 实施计划](../engineering/video-rag-implementation-plan.md)
- [Video RAG 评测计划](../engineering/video-rag-evaluation-plan.md)
- [T17 公共基座 Ticket](../engineering/tickets/T17-video-rag-public-foundation.md)
- [公共基座实施任务](../engineering/video-rag-implementation-tasks.md)
- [三仓库规划包](../architecture/repositories/README.md)
- [跨仓库公共契约](../architecture/repositories/cross-repository-contracts.md)
