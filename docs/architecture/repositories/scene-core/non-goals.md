# `scene-core` 非目标

以下能力明确不进入媒体引擎：

## 业务与治理

- 租户、KnowledgeSpace、用户、ACL、Keycloak；
- 审核、Release、删除、过期、Legal Hold 和领域审计；
- RAG 查询、回答、Citation 或业务知识冲突裁决。

## 基础设施

- PostgreSQL、SQLite、OpenSearch、RabbitMQ、Redis；
- 云对象存储、桌面 Artifact Store 或文件监控；
- 网络服务身份、队列消费和跨平台部署编排。

## AI

- ASR、OCR、VLM/Caption；
- Embedding、Rerank、Generation；
- 任何供应商 API、模型权重、API Key 或模型进程管理。

## 产品

- Web UI、Tauri UI、时间线交互和搜索页面；
- 独立 Video RAG Service；
- 将一个视频包装成一个 Document 或只返回整条视频。

引擎可以提供音频/帧等 Artifact，供平台 AI Adapter 后续分析；“可以被 AI 使用”不等于“引擎负责 AI”。
