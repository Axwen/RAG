# Video RAG 后续实施路线

> 这是公共基座首版和 V0.1 硬化完成后的独立路线，不改变当前文档 RAG 的 T0～T16 Web 主链依赖，也不要求现在创建独立视频服务。真实媒体实现仍未开始。

## 1. 总体原则

```text
公共契约/纯逻辑稳定
       ├── 文档 RAG：继续 PostgreSQL + OpenSearch + RabbitMQ + MinIO + Keycloak
       └── Video RAG：进入本地 Asset/Worker/SQLite/Artifact Adapter
```

共享：协议、版本语义、候选/引用语义、纯逻辑、评测格式。  
不共享：数据库、消息队列、文件存储、部署拓扑、Provider 进程管理。

## 2. 仓库分工

真实 Video RAG 不作为当前 Web RAG 的一次性大改造，而是按三个仓库的边界推进：

| Lane | 仓库 | 首要交付 | 当前状态 |
|---|---|---|---|
| W | 当前 Web RAG | 公共契约、`rag-core`、Web Adapter 预留和企业文档 RAG 主线 | 当前继续实现，媒体运行时不启用 |
| M | `scene-core` | Rust 媒体核心、FFmpeg/FFprobe、基础 Artifact、Manifest、取消/资源 | 规划资料已落到独立目录，git 尚未初始化；待 V1 实施 |
| D | `scene-seek` | Tauri、本地 SQLite/Artifact/Worker、时间线、索引和本地 AI Adapter | 规划资料已增量迁移至既存仓库，当前无提交；待 V1 实施 |

W/M/D 共享 Evidence、Provider、EmbeddingChannel、Candidate、Citation、Evaluation、引擎协议和测试向量；不共享数据库、队列、对象存储、文件布局或部署拓扑。向量化、关键字查询、Rerank 和评测共享语义与纯逻辑，平台分别实现查询执行、模型 Adapter、存储和资源管理。

已迁移的仓库资料与复制边界见 [Video RAG 三仓库规划包](../architecture/repositories/README.md)。

## 3. 批次

### V0a：公共基座首版（当前分支已落地）

已交付：

- ADR-0041～0045；
- Evidence/Locator/Provenance/Provider/Artifact/JobEvent/Channel/Candidate/Citation/Evaluation 契约；
- `rag-core` 融合、去重、确定性排序、时间关系、上下文、Citation、评测和旧结果门禁；
- 冲突矩阵、架构 Review、readiness gate、评测计划和测试入口。

不交付真实视频运行时。

### V0b：公共基座硬化（当前下一批次）

- 版本化 Envelope、JSON Schema、Hash/Fingerprint 规范和跨语言 conformance fixtures；
- Evidence、Provider、Candidate、Query、Citation、Evaluation、JobEvent 的完整运行时校验（实现位于 `rag-core`，类型契约位于 `contracts`）；
- Artifact finalize、受控 staging handle、事件幂等/恢复和 active attempt 写回集成测试；
- Candidate score/通道/投影身份、可见性/回答资格、确定性排序、候选预算和时间邻接性能；
- EvaluationRun 完整重放身份、生命周期、资源阶段指标和确定性 runner。

验收：V0.1 公共基座硬化门禁全部通过；仍不引入 FFmpeg、ASR、OCR、VLM、Tauri、SQLite 或视频 Worker。

### V1：本地媒体边界

由 Video Adapter 负责：

- Asset/AssetVersion 注册、hash、文件引用和缺失状态；
- FFprobe JSON 采集；
- FFmpeg 封面、音频、关键帧和 Artifact 清理；
- SQLite WAL schema、事务、任务恢复和 Worker Supervisor；
- 本地权限、删除、过期和日志脱敏策略。

验收：G0 全部通过，异常退出和资源不足不会伪报完成。

### V2：文本时间证据

- 字幕导入；
- ASR Provider；
- speech/subtitle Evidence；
- FTS/稀疏检索、片段定位和 SRT/JSON 导出；
- CER/WER、Recall@K、MRR、Temporal IoU 和失败恢复。

验收：G1 全部通过；模型选择不写成公共全局常量。

### V3：视觉检索

- shot/scene segmentation；
- keyframe Artifact；
- OCR 和 image-region；
- 视觉 Embedding Channel；
- 文字搜画面、图片搜画面、候选融合、时间邻接和多样性。

验收：G2 全部通过；视觉 channel 与文本 channel 物理/逻辑隔离。

### V4：可信问答和持续演进

- caption/VLM 作为可选增强，不替代镜头级召回；
- rerank 和跨模态融合实验；
- Citation 跳转、Grounded Answer、冲突/注入处理；
- 用户反馈、失败查询、hard negative、Provider 对比和资源自适应路由。

验收：G3/G4 全部通过，才可讨论与 Seelyn 基线的可重复比较。

## 4. 依赖与并行

| Lane | 内容 | 依赖 |
|---|---|---|
| A | contracts、rag-core、协议测试 | V0a；V0b 硬化后冻结 |
| B | 评测格式、脱敏 fixture、Temporal 指标 | V0a；V0b runner 后冻结 |
| C | 本地媒体导入、SQLite、Artifact、Worker | A 的 V0.1 稳定、G0 前置条件满足后开始 |
| D | 字幕/ASR/FTS | C 的 G0 通过后 |
| E | shot/scene/OCR/视觉 channel | D 有文本基线后 |
| F | 问答、Citation UI、导出和资源门禁 | E 有片段召回基线后 |

文档 RAG T1b/T2/T3/T4/T5/T6/T7/T8/T9/T10/T11/T12/T14/T15/T16 仍按既有依赖推进；V0a/V0b 只提供公共类型、校验、纯逻辑和评测输入，不要求这些票据改用本地基础设施。详细硬化任务见 [Video RAG 公共基座实施任务](video-rag-implementation-tasks.md)。

## 5. Provider/模型实验口径

以下参数不得在 V0 写死：

- ASR/OCR/视觉 Embedding/Caption/Reranker 的具体模型；
- shot/scene 阈值和采样频率；
- text/image/video channel 的维度、距离和归一化；
- 融合权重、时间邻接窗口、diversity 和 rerank N；
- CPU/GPU/远程 Provider 路由。

所有实验必须记录 channel、Provider、模型、输入指纹和资源指标。

## 6. 未来拆服务判断

V0～V4 均不创建独立 `video-rag-service`。只有满足以下条件才重新评估：

- 至少有两个稳定消费者（例如 Web Video RAG 和本地 Video RAG）；
- Provider/索引/容量隔离已经成为真实运维问题；
- 公共协议已在跨语言实现中稳定；
- 独立部署的收益高于跨服务一致性、权限和发布复杂度。
