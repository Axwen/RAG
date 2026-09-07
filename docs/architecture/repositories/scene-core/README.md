# `scene-core` 规划包

> 目标仓库：独立目录，git 尚未初始化。本文件已从 Web RAG 规划包迁移，当前只描述媒体核心边界，不表示真实媒体运行时已经实现。

## 1. 定位

`scene-core` 是可被 Web RAG 和 scene-seek 消费的媒体处理平面：用 Rust 调用 FFmpeg/FFprobe 周边库，将媒体输入转换为可验证的媒体 Artifact 和 Manifest。

它不是：

- RAG 服务；
- AI 模型网关；
- 数据库或对象存储；
- 权限和审计系统；
- 独立 `video-rag-service`。

## 2. 规划资料

- [职责说明](responsibilities.md)
- [引擎调用协议](engine-contract.md)
- [实施路线](roadmap.md)
- [非目标](non-goals.md)
- [三仓库公共契约](../cross-repository-contracts.md)

## 3. MVP 结论

MVP 只做：probe、流元数据、音频抽取、封面/关键帧/基础帧、时间戳处理、Hash/Fingerprint、Artifact Manifest、进度、取消、超时、受控错误和资源统计。

MVP 不做：ASR、OCR、VLM/Caption、Embedding、Rerank、数据库、消息队列、对象存储、索引、Tauri、权限和审计。
