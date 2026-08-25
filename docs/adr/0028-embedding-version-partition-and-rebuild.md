---
status: accepted
---

# IndexPartition 唯一键加入 embeddingVersion，并交付显式索引重建协议

原 `IndexPartition` 唯一键为 `(tenantId, knowledgeSpaceId, dataClass, indexSchemaVersion)`，不含 Embedding 版本。换 Embedding 模型或改向量维度时，只能靠递增 `indexSchemaVersion` 表达，使一个版本号同时承载 mapping 与模型两件事实，与"每个版本只表达一个维度的事实"的原则冲突，也让"Embedding 变更触发全量回归"这条评测规则没有可依赖的物理边界。

`IndexPartition` 唯一键改为 `(tenantId, knowledgeSpaceId, dataClass, indexSchemaVersion, embeddingVersion)`。Embedding 模型标识、维度、归一化方式和相似度度量属于 `embeddingVersion` 的组成部分；其中任何一项变化都产生新分区，不原地重写旧分区。`IngestionManifest` 与 `ReleaseManifest` 继续记录使用的 `embeddingVersion`，兼容矩阵按分区校验。

阶段 1 交付显式的索引重建协议，但不交付自动化的全量重嵌入编排。协议内容为：管理员对一个知识空间发起 `rebuild` 命令，指定目标 `indexSchemaVersion` 与 `embeddingVersion`；系统在新分区内按现有候选 Release 流水线重建投影，数据来源是对象存储中的不可变 `ParseArtifact` 与 PostgreSQL 中的 `chunk_manifest`，不重新解析原文件也不要求原文件仍在保留期内；新 Release 通过数量、哈希、作用域和抽样检索校验后，按现有 `IndexActivationIntent` 协议原子切换 Alias；旧分区保留为可回滚目标，直到显式回收。

重建前必须重新校验删除墓碑、Legal Hold 和有效期，含已删除或正在清理文档的 Release 不得激活，这与发布和回滚使用同一套前置校验。重建产生的模型调用走与常规入库相同的预算闸门（见 ADR-0029），预算不足时重建暂停并保持可恢复，不允许突破月度上限。

阶段 1 明确不承诺：自动触发的全量重嵌入调度、双写期与影子检索对比、灰度 Alias 分流、以及基于成本的分批编排。这些是阶段 2 内容。阶段 1 的 DoD 只要求：重建可手动发起、可观察进度、可校验、可原子切换、可回滚，且失败后不留下半可检索状态。
