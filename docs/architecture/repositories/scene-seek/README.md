# `scene-seek` 规划包

> 目标仓库：既存 git 仓库，当前无提交。本文件已增量迁移到现有仓库的架构资料目录，并与既有 Seelyn 逆向证据并存。

## 1. 定位

`scene-seek` 是本地优先的 Video Intelligence / Video RAG 工作台：负责媒体导入、任务恢复、Evidence 浏览、时间线、检索、引用跳转和本地资源治理。

它消费固定版本的 [`scene-core`](../scene-core/README.md)，但不把媒体处理逻辑复制进 UI，也不要求连接 Web RAG 的 PostgreSQL、RabbitMQ 或对象存储。

## 2. 规划资料

- [职责说明](responsibilities.md)
- [本地运行时](local-runtime.md)
- [实施路线](roadmap.md)
- [非目标](non-goals.md)
- [三仓库公共契约](../cross-repository-contracts.md)

## 3. MVP 方向

先实现可靠的本地媒体边界和时间化 Evidence，再实现字幕/ASR、shot/scene、OCR、视觉 Embedding、文字搜画面、图片搜画面、rerank、Citation 跳转和资源评测。UI 不以聊天框替代搜索和时间线。
