# Web RAG 职责说明

## 1. 运行定位

Web RAG 是企业控制面和知识服务，不是媒体编解码平台。即使未来知识库含有音视频，Web 仍负责“谁可以处理、处理结果保存在哪里、哪些 Evidence 可以检索和引用”；媒体引擎负责“如何安全、可恢复地读取媒体并产出 Artifact”。

## 2. 领域职责

### 2.1 资产和版本

Web 侧为租户和知识空间管理 `SourceAsset`/`AssetVersion` 的业务身份、上传权限、生命周期、删除和审计。原始媒体及产物通过 object storage adapter 保存；公共契约不要求 Web 使用某个固定对象存储供应商。

### 2.2 任务和运行

Web 侧创建和管理 `ProviderRun`/`JobEvent` 的业务事实，负责 RabbitMQ 投递、Attempt、Generation、重试、取消、恢复、DLQ 和旧结果写回门禁。媒体引擎的进程退出码只是执行信号，不是业务状态的最终事实。

### 2.3 证据和索引

Web 侧将引擎 Manifest 和 AI Provider 结果转换为 `EvidenceItem`、`EvidenceProvenance` 和 `RetrievalCandidate`，执行 ACL、删除/过期、注入风险和 Release 约束，再投影到 OpenSearch。

视频必须保持：

```text
Asset -> Scene/Shot -> Evidence
```

语音、字幕、OCR、视觉、Caption 和元数据是不同 modality/channel 的 Evidence；不能把它们压成普通文档 Chunk。

### 2.4 查询和回答

Web 查询由 OpenSearch/其他索引 Adapter 执行 lexical、dense 和 metadata 召回，再进入共享候选融合、去重、时间邻接、rerank、Citation 校验和 Grounded Answer 逻辑。回答 API 负责将 `time_range`/`frame`/`image_region` 暴露为可跳转引用。

媒体引擎不参与每一次查询。只有需要生成预览、抽取缺失帧或修复 Artifact 时，查询链路才可能通过受控命令调用它。

## 3. 服务端 AI Adapter

Web 侧模型调用必须经过既有 ModelAdapter/能力 Adapter：

```text
Node control plane / Worker
  -> Python/Node AI Adapter
  -> Provider SDK
```

Adapter 负责数据分级、模型/Provider 版本、预算预扣与结算、取消、错误归一、审计和输入输出指纹。供应商 SDK 不进入 `packages/contracts`、`packages/rag-core` 或 `scene-core`。

## 4. Web 侧演进顺序

1. 保持文档 RAG 主线和现有 Web 基础设施不变；
2. 先实现 `MediaEngineAdapter` 的协议测试和模拟调用，不接真实媒体；
3. 在 readiness gate 通过后接入真实引擎 binary/Worker；
4. 再接入字幕/ASR、OCR、视觉 Embedding、片段检索和时间线 API；
5. 只有 Web Video RAG 出现真实容量和隔离需求时，才评估引擎服务化。
