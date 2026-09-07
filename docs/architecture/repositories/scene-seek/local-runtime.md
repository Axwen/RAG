# `scene-seek` 本地运行时

## 1. 组件边界

```text
Tauri UI
  -> Desktop Application/Core
      ├── SQLite WAL：资产、Run、Evidence 索引元数据和恢复事实
      ├── Local Artifact Store：原始媒体、音频、帧、字幕和其他产物
      ├── Local Worker Supervisor：任务队列、取消、重试、恢复
      ├── scene-core：探测、抽取、时间和 Manifest
      ├── Local AI Adapter：ASR/OCR/Embedding/Rerank/Caption
      └── Local Search Adapter：FTS、向量和候选融合
```

这不是 Web RAG 的部署拓扑复制。桌面端可以在单机上运行多个进程，但每个边界仍通过协议和状态门禁连接。

## 2. SQLite WAL 责任

SQLite 只保存桌面运行时需要的本地事实，例如：

- Asset/AssetVersion 身份和本地可用性；
- ProviderRun、Attempt、Generation、JobEvent 游标；
- Artifact metadata、Evidence metadata 和索引构建状态；
- 本地评测运行和资源指标；
- 恢复所需的幂等键和错误状态。

原始媒体和大型 Artifact 放在本地 Artifact Store，不把二进制和向量无边界地塞入任务表。具体 schema、加密和备份策略留到 scene-seek 实现阶段的工程设计。

## 3. Worker Supervisor

Supervisor 负责：

- 启动固定版本的 media engine CLI/Worker；
- 维护 request/run/attempt 映射；
- 持久化事件序号，支持重启后恢复；
- 发送取消和截止时间；
- 隔离临时目录和清理部分 Artifact；
- 在写 Evidence/索引前执行 generation、sourceVersion 和 inputFingerprint 门禁；
- 记录 CPU、内存、磁盘和可选 GPU 使用。

它不需要 RabbitMQ。若未来任务量增长，可以增加本地队列或进程池，但不应让桌面端依赖 Web MQ 才能工作。

## 4. 本地检索

本地检索 Adapter 可以分别使用：

- lexical：SQLite FTS 或其他本地全文索引；
- dense：与 `EmbeddingChannel` 绑定的本地向量索引；
- metadata：SQLite 结构化过滤；
- fusion/rerank：共享候选语义和纯逻辑的本地实现/调用；
- Citation：使用本地 Artifact 引用和媒体播放器时间跳转。

本地索引不需要与 OpenSearch 使用同一个物理 schema，但必须能输出公共 `RetrievalCandidate`。

## 5. 本地隐私和删除

桌面端必须定义本地权限、应用锁、删除、过期、导出和临时目录清理。公共协议不会替桌面端决定这些产品策略；但被删除、隔离或不可用的 Evidence 不能进入检索上下文或 Citation。

## 6. 当前不实现

本文件只固定本地运行时边界，当前不创建 Tauri 工程、不引入 SQLite schema、不接入真实媒体或本地模型进程。实现须在 scene-seek 中按 readiness gate 分阶段完成。
