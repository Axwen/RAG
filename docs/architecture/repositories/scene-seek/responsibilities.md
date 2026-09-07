# `scene-seek` 职责说明

## 1. 产品职责

桌面端提供本地 Video Intelligence / Video RAG 工作台：

- 导入和管理本地音视频 Asset/AssetVersion；
- 展示 Asset → Scene/Shot → Evidence 层次；
- 以时间线查看字幕、语音、OCR、视觉和元数据证据；
- 支持文字搜画面、图片搜画面、混合检索和 rerank；
- 支持 Citation 按时间区间、帧或区域跳转；
- 显示任务进度、失败、取消、恢复和资源使用；
- 在本地资源和隐私约束下接入 AI Adapter。

## 2. 桌面端不把本地成功当作公共成功

桌面端的本地索引、SQLite 状态和 Artifact Store 只是本地运行时事实源。它们必须通过公共 Evidence、ProviderRun、Candidate、Citation 和 Evaluation 语义输出结果，不能因为换了存储就改变：

- `startMs >= 0`、`endMs > startMs`；
- sourceVersion/run/generation/inputFingerprint 关联；
- cancelled/superseded 结果不能写回；
- 不同 EmbeddingChannel 不混写；
- 无证据句不能标记 grounded。

## 3. 本地 AI Adapter

桌面端可以使用本地 Python/Node sidecar 或其他受控 Adapter：

```text
scene-core Artifact
  -> local Speech/OCR/Embedding/Rerank/Caption Adapter
  -> ProviderRun + EvidenceProvenance
  -> local FTS/vector index
```

Adapter 可以选择本地模型或受控云 Provider，但必须由桌面产品明确数据外发和用户授权；供应商 SDK 不能进入 `scene-core`。

## 4. 与 Web 的互操作

桌面端首先以本地闭环为目标，不把 Web RAG 作为启动依赖。未来可以导出/导入公共 Evidence、Artifact Manifest、Evaluation 数据或 Citation，但需要：

- 明确协议版本和来源版本；
- 不导出未授权媒体和密钥；
- 不把本地绝对路径当作跨平台对象引用；
- 导入后重新执行本地可用性、权限和旧结果写回门禁。
