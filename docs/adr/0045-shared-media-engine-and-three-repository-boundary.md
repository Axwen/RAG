---
status: accepted
date: 2026-09-04
revises:
  - 0001-typescript-control-plane-python-model-runtime.md
  - 0014-parser-service-around-ragflow-deepdoc.md
  - 0024-rabbitmq-asynchronous-task-bus.md
  - 0043-provider-run-and-runtime-adapter-boundary.md
decision-basis: 用户确认的三仓库规划；Video RAG 公共基座架构 Review；本地优先与 Web 企业运行时并存要求
---

# 共享 Rust Media Engine 与 Web/Desktop 三仓库边界

## 背景

Web RAG 的知识库未来可能同时包含文档、图片、音频和视频，但 Web 控制面与本地 Video RAG 工作台有不同的运行约束：

- Web 侧需要继续使用 PostgreSQL、OpenSearch、RabbitMQ、对象存储适配器和 Keycloak；
- 桌面侧需要本地文件、离线/弱网运行、SQLite WAL、本地 Artifact Store 和本地 Worker；
- 音视频探测、转码、抽音频、帧抽取和时间戳处理更适合由 Rust 调用 FFmpeg/FFprobe 周边能力；
- ASR、OCR、Embedding、Rerank、Caption 和 Generation 的供应商 SDK 更新频繁，不应与媒体处理进程绑定。

如果把上述能力全部塞入 Web RAG，一个存储或部署边界的选择就会扩散成整个公共核心的依赖；如果完全复制两套媒体处理，又会造成时间戳、Artifact Manifest 和错误语义漂移。

## 决策

### 1. 先固定三个仓库，不创建第四个仓库

规划目标是三个相互独立、通过版本化协议协作的仓库：

| 仓库 | 当前落点 | 核心职责 |
|---|---|---|
| Web RAG | 当前仓库 | Web UI、Node 控制面/Worker、企业存储与治理、公共契约、`rag-core` 和 Web 侧 Adapter |
| `scene-core` | 独立目录（规划资料已迁移，git 尚未初始化） | Rust 媒体引擎、FFmpeg/FFprobe 调用、媒体 Artifact 生成和资源/取消语义 |
| `scene-seek` | 既存仓库（规划资料已增量迁移，当前无提交） | Tauri 桌面工作台、本地存储/索引/Worker、时间线和本地 AI Adapter |

当前仓库继续保存三仓库总规划、公共语义契约事实源和跨仓库调用协议；媒体核心与 Video RAG 职责资料已分别迁移到 scene-core 和 scene-seek。迁移不是把三个仓库变成一个 Git 仓库，也不是建立 Git submodule 依赖。

暂不创建独立 `rag-foundation` 或 `ai-runtime` 仓库。只有公共协议在至少两个独立实现中稳定、版本发布和兼容维护已经成为真实负担时，才重新评估拆分。

### 2. `scene-core` 是共享媒体平面，不是共享业务服务

`scene-core` 提供 Rust library 和 CLI/Worker binary 两种消费形态。MVP 负责：

- probe 和音视频流元数据；
- 音频抽取、封面/关键帧/基础帧抽取；
- 时间戳归一化、媒体 Hash/Fingerprint；
- Artifact Manifest、进度、取消、超时、受控错误和资源统计。

它不负责数据库、消息队列、对象存储、权限、审计、AI Provider SDK、RAG 查询、索引、业务状态或 UI。FFmpeg/FFprobe 的 argv、进程句柄和临时路径只属于引擎内部实现或引擎调用协议，不进入公共语义 Evidence/Citation 契约。

### 3. Web 侧通过 Adapter/Worker 调用媒体引擎

浏览器不直接调用媒体引擎。未来 Web 媒体入库链路为：

```text
Web UI
  -> Node API / Control Plane
  -> Web Job + Worker
  -> MediaEngineAdapter
  -> scene-core CLI/Worker（本地进程、容器或受控进程池）
  -> Artifact Manifest + 受控 Artifact
  -> Web Object Storage Adapter
  -> Evidence / Index Projection / Release
```

初期优先使用同机进程或受控 Worker 调用 JSON/JSONL 协议，不把 HTTP/gRPC 服务作为前置依赖。未来若 Web Video RAG 的吞吐、隔离或扩缩容证明需要独立引擎服务，可以在保持协议不变的前提下增加服务化 Adapter；这不等于现在创建 `video-rag-service`。

Web 侧仍拥有：来源版本、租户、ACL、任务事实、审计、删除/过期、对象存储持久化、OpenSearch 投影、Release 和回答引用。媒体引擎只提供可验证的媒体处理结果。

### 4. 桌面侧固定版本消费同一引擎

`scene-seek` 通过 Tauri/Rust 本地 Worker 或受控 sidecar 调用 `scene-core`。桌面端负责本地导入、任务恢复、SQLite WAL、本地 Artifact Store、索引 Adapter、时间线和用户交互。

桌面端必须固定已发布的 media engine tag 或 commit SHA，并记录：

```text
engineVersion
engineCommit
engineProtocolVersion
```

不得依赖引擎浮动的 `main` 分支。桌面端可以在支持的场景直接链接 Rust library，也可以调用 CLI/Worker；两种形态必须通过同一组协议测试和输出 Manifest 兼容矩阵。

### 5. AI 运行时与媒体引擎分离

AI 能力按能力接口而不是按某一家模型组织：

```text
SpeechToTextProvider
OcrProvider
EmbeddingProvider
RerankProvider
CaptionProvider
GenerationProvider
```

- Web RAG：由服务端 Python/Node Adapter 调用供应商 SDK，并执行数据等级、预算、取消、审计和错误归一；
- Desktop：由本地 Python/Node Adapter 或 sidecar 按本地资源和用户配置执行；
- `scene-core`：不包含任何 AI SDK，不直接绑定模型或供应商。

替换模型只改变 Adapter 的 Provider/model/channel 版本和评测记录，不改变媒体引擎的媒体处理协议。

### 6. 复用语义、算法和评测，不强制复用物理后端

以下能力按三层复用：

| 能力 | 共享内容 | 各平台独立内容 |
|---|---|---|
| 向量化 | `EmbeddingChannel`、输入输出指纹、Provider 能力接口、版本记录 | Web/桌面模型 Adapter、缓存和向量索引实现 |
| 关键字查询 | 查询意图、字段/模态语义、过滤和候选协议 | OpenSearch、SQLite FTS 或其他本地索引 Adapter |
| Dense 查询 | 查询向量的 channel 身份、候选字段、分数语义 | 各平台向量索引、过滤下推和资源策略 |
| Fusion / 去重 / Temporal adjacency | `rag-core` 纯逻辑、确定性排序、共享测试向量 | 平台特有的召回入口和持久化 |
| Rerank | `RerankProvider` 语义、输入候选格式、版本/预算/取消记录 | Web 云 Adapter、桌面本地 Adapter 和模型进程 |
| Citation / Grounding | Evidence、Locator、Citation、句级校验和时间定位语义 | Web API/回答快照、桌面时间线跳转和本地 UI |
| Evaluation | 数据集、查询、ExpectedEvidence、Recall/MRR/nDCG/Temporal IoU/Citation/Resource 指标格式 | 评测 Runner、数据集存储、资源采集和报告展示 |

因此“复用”优先意味着**协议、纯逻辑、测试向量和评测格式一致**；在运行时兼容时可以直接复用代码，在 Rust 与 TypeScript 不能直接共用实现时，以跨语言一致性测试替代强行共享代码。

### 7. 公共契约不等于公共存储格式

共享协议固定语义身份和关联关系：`sourceVersionId`、`evidenceId`、`runId`、`generation`、`channelId`、Locator、Artifact metadata 和 Fingerprint。各平台可以用不同表、文件布局、索引字段和缓存，但适配器必须能还原公共契约。

原始媒体、解析 Artifact、索引向量和回答快照不要求使用同一种物理格式。引擎输出的 Artifact Manifest 是跨仓库的交换边界；Web/桌面负责将其保存到各自的存储，并补齐领域权限和生命周期信息。

### 8. 结果写回和取消边界保持不变

```text
generation 不一致        -> 拒绝旧结果写回
inputFingerprint 不一致  -> 拒绝旧结果写回
sourceVersionId 不一致   -> 拒绝旧结果写回
cancelled/superseded run  -> 不得改变当前索引
```

引擎进程收到取消信号不等于业务 Run 已取消。Web/桌面 Adapter 必须同时更新自己的任务事实，并在落 Evidence、Artifact 引用和索引前执行公共写回门禁。

## 不变量

- Web RAG 现有 PostgreSQL、OpenSearch、RabbitMQ、对象存储适配器和 Keycloak 不因引入媒体引擎而删除或替换。
- `scene-core` 不连接数据库、消息队列、对象存储，不读取权限信息，不调用真实 AI Provider。
- 浏览器和桌面 UI 都不能把供应商 SDK 或 FFmpeg 参数直接暴露为业务协议。
- 媒体引擎输出必须可由 `sourceVersionId`、engine/provider 版本、input/output fingerprint 和 run 关联解释。
- 向量维度属于 `EmbeddingChannel`；不同平台和模态不得依靠一个全局维度或一个无区分的向量字段。
- Web 与桌面可以拥有不同索引和存储，但同一 EvaluationDataset 和协议测试向量应能比较其语义结果。
- 任何独立服务化决定都必须由真实吞吐、资源隔离、发布和故障恢复证据推动，而不是预先按微服务拆分。

## 影响

### 保留的 Web RAG 主线

ADR-0001、0010、0014、0024 和 0043 的 Web 侧边界继续有效：TypeScript 控制面、Python Parser/AI Adapter、模块化单体、RabbitMQ 异步任务和 Web 企业存储不被 Video RAG 改写。本文只明确媒体处理是一个可被 Web Adapter 调用的外部运行时边界。

### 新增的规划资料

- [三仓库规划总览](../architecture/repositories/README.md)
- [跨仓库公共契约](../architecture/repositories/cross-repository-contracts.md)
- [Web RAG 规划包](../architecture/repositories/web-rag/README.md)
- [Rust Media Engine 规划包](../architecture/repositories/scene-core/README.md)
- [scene-seek Video RAG 规划包](../architecture/repositories/scene-seek/README.md)

本文不表示真实媒体运行时已经实现；目标仓库的规划资料已存在，但仍须按 readiness gate 实施和验收。
