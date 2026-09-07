# 三仓库跨仓库公共契约

> 本文是三仓库的协议总览。当前 Web RAG 保存语义事实源；`scene-core` 和 `scene-seek` 保存迁移后的协议快照，并按协议版本同步。

## 1. 总体原则

三仓库共享的是可验证的语义，不是同一套基础设施：

```text
Web RAG                         scene-core                 scene-seek
────────                       ───────────────                 ──────────────────
Node Control Plane             Rust Media Plane                Tauri Workbench
PostgreSQL/OpenSearch          FFmpeg/FFprobe                  SQLite WAL
RabbitMQ/Object Storage        Host-owned artifacts             Local Artifact Store
Keycloak/Business ACL           JSON/JSONL engine protocol       Local Worker/Index
Python/Node AI Adapter          No AI SDK                        Python/Node AI Adapter
```

公共契约必须描述“结果是什么、如何定位、如何追溯和如何评测”；不能把 PostgreSQL 表名、OpenSearch mapping、RabbitMQ routing key、SQLite 路径、FFmpeg argv 或某个供应商 SDK 暴露为跨仓库必需条件。

## 2. 协议层次

| 层次 | 规范内容 | 当前事实源 | 变更要求 |
|---|---|---|---|
| 语义领域层 | `SourceAsset`、`AssetVersion`、`EvidenceItem`、`Locator`、`Provenance` | `packages/contracts` 与 ADR-0041 | 语义变化新增/修订 ADR；不能只改实现 |
| Provider 运行层 | `ProviderArtifact`、`ProviderRun`、`JobEvent`、Generation/Attempt/Fingerprint | ADR-0043 与 Provider Spec | 状态和旧结果门禁必须保持兼容 |
| 检索层 | `EmbeddingChannel`、`RetrievalCandidate`、`TemporalRelation`、`Citation` | ADR-0042/0044 与 Retrieval Spec | Channel identity 不能被全局维度替代 |
| 评测层 | `EvaluationDataset`、`EvaluationQuery`、`ExpectedEvidence`、Run 与指标 | Evaluation Spec/评测计划 | 同一数据集版本才能比较结果 |
| 媒体引擎层 | JSON/JSONL 请求、事件、Artifact Manifest、错误和取消 | 本文与 [Media Engine Contract](scene-core/engine-contract.md) | 引擎协议独立于语义契约版本 |
| AI 能力层 | STT/OCR/Embedding/Rerank/Caption/Generation 能力接口 | Provider Spec 与 ADR-0045 | SDK 只能位于平台 Adapter |

协议版本至少分为：

```text
semanticContractVersion   # Evidence/Retrieval/Citation/Evaluation 语义
engineProtocolVersion     # media-engine 请求/事件/Manifest
providerCapabilityVersion # AI 能力输入输出和错误语义
implementationVersion     # 仓库/二进制/模型的具体版本
```

修改某一层时，不要用实现版本号代替协议版本号。

## 3. 共享对象的最小关联

### 3.1 媒体处理到 Evidence

```text
SourceAsset
  -> AssetVersion
      -> ProviderRun(provider=scene-core)
          -> ProviderArtifact(Manifest / audio / frame / thumbnail)
              -> EvidenceItem(level=asset|scene|shot|evidence)
                  -> RetrievalCandidate / Citation
```

媒体引擎只负责生成和描述 Artifact；Web/桌面 Adapter 负责把 Artifact 注册到各自存储，补充 Provider/Run 事实、权限、生命周期和 Evidence。不能把媒体引擎生成的 JSON 直接当成已授权知识。

### 3.2 结果写回

任何消费者在持久化 Provider 结果或更新索引前，必须验证：

```text
sourceVersionId == current source version
runId            == current accepted run
inputFingerprint == current input
 generation      == current generation
attempt          == current allowed attempt
run status       ∈ {queued, running, retrying} at write gate
```

`cancelled`、`superseded`、过期或指纹不一致的结果可以保留为历史 Artifact/事件，但不得改变当前 Evidence 可用性、索引或 Release。

## 4. 媒体引擎交换协议

### 4.1 调用方式

第一阶段统一采用 JSON/JSONL 控制协议：

- 请求和状态事件走 stdin/stdout 或等价的受控进程通道；
- 大型媒体和 Artifact 通过调用方管理的 staging 目录、文件句柄或流传递；
- 引擎返回 Manifest、摘要、指纹、资源统计和错误，不连接调用方的数据库/对象存储；
- Web 和桌面各自负责把 Manifest 映射到自己的 Artifact Store。

HTTP/gRPC 不是当前前置依赖。若未来部署成服务，服务只替换调用 Adapter，不改变请求/事件/Manifest 语义。

### 4.2 请求和事件的公共字段

请求还必须透传 executionContext：

```
runId
generation
attempt
scope: asset | query | evaluation
```

输入只能是调用方管理的 staging handle、文件描述符或受控流引用。媒体引擎不接受任意主机路径作为长期领域字段，也不读取业务权限。

所有引擎请求至少关联：

```text
protocolVersion
requestId
operation
sourceVersionId
inputFingerprint（若调用方已知）
engineVersion
engineCommit
cancellation / deadline
```

所有事件至少关联：

```text
requestId
sequence
eventType
occurredAt
progress（可选）
artifactManifest（完成时）
error（失败时使用受控错误）
```

`sequence` 用于去重和恢复；事件不得携带密钥、媒体二进制、完整模型输出或思维链。

### 4.3 Artifact Manifest

Manifest 是交换边界，不是数据库 schema。每个 Artifact 至少表达：

```text
artifactId
kind                  # audio / frame / keyframe / thumbnail / manifest / ...
mediaType
relativeRef 或受控流引用
byteSize
contentHash
sourceVersionId
startMs / endMs（适用时）
engineVersion
createdByRunId
```

时间区间必须遵守公共 Locator 规则：`startMs >= 0`、`endMs > startMs`。引擎无法提供时间定位时必须显式缺失，不能伪造 `0..duration`。

## 5. AI Adapter 契约

媒体引擎不调用 AI。各平台将引擎产物交给自己的 AI Adapter：

```text
Media Artifact / Evidence
  -> SpeechToTextProvider / OcrProvider / EmbeddingProvider
  -> ProviderRun + ProviderArtifact + EvidenceProvenance
  -> platform-specific index adapter
```

每次 AI 结果必须记录 Provider、模型、模型版本、输入/输出指纹、Run、Generation、Attempt 和 Embedding Channel（适用时）。

供应商 SDK 的依赖方向：

```text
Web/desktop AI Adapter -> vendor SDK
Web/desktop AI Adapter -> public capability contract
scene-core        -X-> vendor SDK
rag-core               -X-> vendor SDK
```

## 6. 检索、融合和评测如何复用

### 可以直接共享的内容

- Evidence/Locator/Citation 的字段和校验规则；
- `EmbeddingChannel` 的维度、距离、归一化和模型身份语义；
- RetrievalCandidate 的字段、分数方向、rank 和 temporal relation；
- 融合、去重、确定性排序、时间邻接、上下文组装和 Grounded Answer 的纯逻辑；
- Recall@K、MRR、nDCG、Temporal IoU、Citation Precision、Resource Metrics 的定义；
- 固定输入、排序稳定性、旧结果隔离和指标计算的测试向量。

### 必须由平台适配的内容

- 关键字查询执行：OpenSearch DSL 与 SQLite FTS 不是同一实现；
- 向量查询执行：OpenSearch kNN 与本地向量索引的过滤、量化和资源策略不同；
- Rerank/Embedding/ASR/OCR 的模型进程、网络、缓存、预算和取消；
- Candidate 的存储、ACL 预过滤、删除墓碑、过期和恢复；
- Evaluation Runner 的任务调度、数据集存储、资源采集和报告落盘。

如果 Rust 桌面运行时不能直接复用当前 TypeScript `rag-core`，应优先移植确定性纯逻辑并运行相同测试向量；不要为了“共用代码”把桌面强行依赖 Node 服务。

## 7. 兼容与发布策略

### 7.1 版本固定

桌面端和 Web Worker 消费引擎时都必须记录：

```text
engineProtocolVersion
engineVersion
engineCommit
```

桌面发布包固定 tag 或 commit SHA；Web 的容器镜像固定不可变 digest 或等价版本。开发环境可以使用本地路径，但 CI/发布不能依赖浮动 `main`。

### 7.2 兼容矩阵

每次引擎发布至少说明：

| 维度 | 记录内容 |
|---|---|
| 输入 | 支持格式、是否需要音视频流、最大/最小边界 |
| 输出 | Manifest 字段、Artifact kind、时间精度和缺失语义 |
| 资源 | CPU、内存、磁盘、GPU/硬件加速假设 |
| 取消 | 取消延迟、超时行为、部分 Artifact 清理 |
| 错误 | 可重试/不可重试分类和错误码 |
| 兼容 | 支持的 `engineProtocolVersion` 和消费者版本 |

协议破坏性变化必须升 major；新增可选字段优先 minor；错误码补充和文档修订仍需在公共文档登记。

### 7.3 协议测试

跨仓库 CI 或手工验证至少覆盖：

1. probe 成功、输入格式拒绝和损坏媒体；
2. 无音轨、无视频轨、无字幕、可变帧率和时间戳异常；
3. 进度单调、事件可去重、取消后不误报成功；
4. Manifest Hash、大小、时间区间和 sourceVersion 关联；
5. 重试/恢复时旧 generation 不写回；
6. 同一 EvaluationDataset 上的候选、Citation 和 Temporal IoU 语义一致。

## 8. 安全与数据边界

- 当前只使用合成或严格脱敏样本，不读取用户密钥、真实媒体、真实转写、授权信息、模型权重或原始数据库；
- 引擎接收调用方已经完成的输入授权，不自行决定业务可见性；
- Artifact 临时目录由调用方创建、隔离、清理和审计；
- 日志只记录受控元数据，不记录原始媒体内容、Token、密钥或模型思维链；
- 删除、过期、Legal Hold、ACL 和注入风险由消费平台按自己的事实源执行；
- 跨仓库协议不允许把本地绝对路径、云端连接串和供应商凭证变成持久化领域字段。

## 9. 未来何时拆成独立服务

当前不创建独立 Video RAG 服务。只有同时出现以下证据，才重新评估：

- Web 和桌面已经有至少两个稳定消费者；
- 同机进程/Worker 方式在吞吐、内存、GPU 或故障隔离上成为瓶颈；
- 协议和兼容矩阵已经有跨语言测试；
- 独立部署能降低真实运维复杂度，而不是仅增加网络、权限和发布复杂度；
- 有明确的服务身份、队列、Artifact 传输和观测方案。
