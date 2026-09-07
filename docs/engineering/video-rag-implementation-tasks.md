# Video RAG 公共基座实施任务

> 状态：V0a 首版已落地；V0b 公共基座硬化待实施。
> 范围：当前 Web RAG 仓库只实现协议、校验、纯逻辑和评测输入；真实媒体处理进入后续的 scene-core 与 scene-seek 仓库，当前均未进入实施。
> 关联：[架构 Review](../design/video-rag-foundation-architecture-review.md)、[公共契约 Spec](video-rag-public-contract-spec.md)、[rag-core Spec](video-rag-rag-core-spec.md)、[readiness gate](video-rag-readiness-gate.md)。

## 1. 执行规则

| 规则 | 口径 |
|---|---|
| 当前 Web RAG 可做 | contracts 类型契约、rag-core 运行时校验与纯逻辑、版本化 Envelope、Evidence/Provider/Candidate/Citation/Evaluation 语义、JSON fixtures 和确定性评测 Runner |
| 当前 Web RAG 禁止做 | FFmpeg、FFprobe、ASR、OCR、VLM、Tauri、SQLite、本地文件监控、本地模型进程管理、视频专用 Worker、独立 video-rag-service |
| scene-core 可做 | Rust 媒体探测、抽取、时间戳、媒体 Artifact Manifest、取消、超时和资源统计 |
| scene-seek 可做 | Tauri、SQLite WAL、本地 Artifact Store、Local Worker、索引 Adapter、时间线和本地 AI Adapter |
| 合并规则 | 每项任务独立验证；不覆盖已批准 ADR；若改变公共语义，先新增/修订 ADR 并更新兼容矩阵 |

## 2. 扁平任务清单

| ID | 优先级 | Lane | 状态 | 依赖 | 估算 | 交付与验收 |
|---|---|---|---|---|---:|---|
| VRF-001 | P0 | Web/共享 | 待实施 | V0a | 1.5d | 建立版本化 Envelope、JSON Schema、兼容矩阵、Hash/Fingerprint 前缀/编码/规范化和发布门禁；以 `DOCUMENT_EMBEDDING_DIMENSION` 承载文档 1024 维兼容基线，不恢复全局 `EMBEDDING_DIMENSIONS` 语义；新增字段、破坏性变化和旧文档映射都有兼容测试，覆盖 D2、D3、D24、D27、D29、D42。 |
| VRF-002 | P0 | Web/共享 | 待实施 | V0a | 2d | 完成 Evidence 跨字段校验、Evidence ID 唯一范围/复合身份、Candidate/Query/Run/Event/Evaluation/指标边界校验，并在 rag-core 统一共享校验工具；非法输入返回可诊断错误，覆盖 D26、D28、D35、D36、D40、D41。 |
| VRF-003 | P0 | Web/共享 | 待实施 | VRF-001/002 | 2d | 扩展 ProviderRun execution scope（asset/query/evaluation）、统一 Artifact kind taxonomy、JobEvent 幂等键和事件语义映射；按事件类型约束 payload，不允许任意正文、媒体、凭证或思维链，覆盖 D11、D12、D13、D18、D25、D39。 |
| VRF-004 | P0 | Web/引擎协议 | 待实施 | VRF-001/003 | 2d | 固定最小 Media Engine 请求/事件/Manifest 契约：executionContext 透传 runId/generation/attempt，受控 staging handle/文件描述符输入，Artifact staged/complete/failed/finalize 生命周期；协议不暴露绝对路径、FFmpeg argv 或进程句柄，覆盖 D4、D5、D6、D25。 |
| VRF-005 | P0 | Web/共享 | 待实施 | VRF-001/002 | 1.5d | 扩展 EmbeddingChannel、RetrievalQuery 和索引投影身份，使查询显式声明 dense channel/向量身份，投影保存 projectionId、indexSnapshotId 和 channel fingerprint；维度不再成为全局常量，覆盖 D14、D20、D24、D35。 |
| VRF-006 | P0 | rag-core | 待实施 | VRF-002/005 | 3d | 扩展 Candidate 的 contributions、matchedChannels、scoreKind、scoreDirection、projection/index snapshot、visibility、answerEligibility；非法权重/非有限分数显式拒绝；检索可见性和回答资格分离；统一 ranked-candidate、Top-K、候选预算和确定性全序，覆盖 D7、D15、D19、D21、D30、D34、D37、D47、D49。 |
| VRF-007 | P0 | rag-core | 待实施 | VRF-002/006 | 2d | TemporalRelation 方向固定以当前 Candidate 为参照；邻接按同一 sourceVersionId 的最近时间邻居；Temporal IoU 先按 sourceVersionId 对齐；邻接实现达到 O(n log n) 或近似线性，bestTemporalIoU 使用单次循环，覆盖 D8、D10、D46、D48。 |
| VRF-008 | P0 | rag-core | 待实施 | VRF-002/006 | 1.5d | Context Assembly 接收已授权 Evidence/授权判定结果，支持视觉 Artifact/content reference；只允许 answer eligible 内容进入回答；Citation 诊断格式化和最终发布校验分离，覆盖 D31、D32、D38、D40。 |
| VRF-009 | P0 | Evaluation | 待实施 | VRF-001/005/006/007/008 | 2.5d | 扩展 EvaluationRun 完整身份和生命周期，保存 dataset、pipeline、Provider、model、channel、engine、input fingerprint、generation、attempt、样本数、聚合口径、分桶和 import/query/cancel/recovery/failure/retry 资源指标；evidenceId 为空时使用 source/version/modality/Locator fallback，提供不依赖真实模型的确定性 Runner，覆盖 D16、D17、D22、D23、D33、D44。 |
| VRF-010 | P0 | 跨仓库 | 待实施 | VRF-001/006/007/008/009 | 2d | 生成脱敏 JSON conformance fixtures 和 golden outputs，验证 TypeScript 与未来 Rust 的校验、融合、排序、时间关系、Citation 和指标一致；不通过 Node sidecar 强行共享实现，覆盖 D3、D24、D41、D42。 |
| VRF-011 | P0 | Web/Desktop Adapter | 待实施 | VRF-003/004/009/010 | 3d | 为取消、失败、重试、恢复、superseded、重复事件、部分 Artifact 和迟到结果建立 Adapter 集成测试；只有当前 active attempt 可写回，数据库/SQLite CAS、队列 ACK、进程终止和文件清理由 Adapter 完成，覆盖 D9、D18、D45。 |
| VRF-012 | P1 | Web/桌面 | 待实施 | VRF-006/009 | 2d | 在 Web 和未来 Desktop 的检索入口实施候选预算、上下文预算、资源采集和超限失败语义；确保评测负载不会掩盖正常导入/查询的延迟和内存问题，覆盖 D23、D47、D49。 |
| VRF-013 | P0 | scene-core | 目标仓库未就绪，待实施 | VRF-001/004/010 | 5d | 实现 Rust Media Core MVP：probe、Hash、音频/封面/关键帧 Artifact、时间戳、Manifest、取消、超时、错误和资源统计；通过引擎协议和 golden fixtures，不接数据库、队列、对象存储或 AI SDK，落地 D4、D5、D6、D25。 |
| VRF-014 | P0 | scene-seek | 目标仓库未就绪，待实施 | VRF-010/013 | 6d | 实现 Tauri、本地 SQLite WAL、本地 Artifact Store、Worker Supervisor、事件恢复、FTS/向量 Adapter 和时间线引用跳转；本地 AI Adapter 与引擎分离，不依赖 Web PostgreSQL/RabbitMQ/Keycloak，落地 D43、D45。 |
| VRF-015 | P0 | Web/桌面/评测 | 后续门禁 | VRF-009/010/011/013/014 | 按 Gate | 按 G0～G4 关闭真实媒体导入、字幕/ASR、shot/scene、OCR、视觉 channel、文字/图片搜画面、Temporal IoU、Citation 跳转、取消/恢复、旧结果隔离和资源基准；没有证据时保持 CONTRACT_READY_WITH_ACTIONS，不宣称 Video RAG READY。 |

## 3. 推荐执行顺序

```
VRF-001 ─┬─ VRF-002 ─┬─ VRF-003 ─ VRF-004
         │           ├─ VRF-005 ─ VRF-006 ─ VRF-007 ─ VRF-008
         │           └─ VRF-009 ───────────────┬─ VRF-010
                                               └─ VRF-011 ─ VRF-012

VRF-010 + VRF-004 → VRF-013（scene-core）
VRF-013 + VRF-010 → VRF-014（scene-seek）
VRF-009/011/013/014 → VRF-015（readiness gate）
```

当前只排 VRF-001 和 VRF-002；其余任务标记为“待调用方出现后重排”，不把尚无消费者的协议按想象中的用法提前硬化。VRF-013～VRF-015 还受目标仓库和真实媒体 readiness 证据约束，不应为了“提前支持视频”而混入当前 Web 主线。

| 任务 | 当前排期 | 理由 |
|---|---|---|
| VRF-001 | 排入 | 版本化 Envelope、兼容矩阵和 Hash/Fingerprint 规范是后续协议变更的共同地基，越晚确定返工越大。 |
| VRF-002 | 排入 | 已有 `contract-validation.ts` 作为实现起点，先统一运行时校验可降低后续调用方各自解释契约的风险。 |
| VRF-003 | 待调用方出现后重排 | ProviderRun/JobEvent 的 execution scope 和事件 payload 要等真实 Adapter 消费后才能冻结。 |
| VRF-004 | 待调用方出现后重排 | Media Engine 协议依赖受控输入、事件和 finalize 的实际调用链，当前没有引擎消费者。 |
| VRF-005 | 待调用方出现后重排 | Query 与索引 projection identity 需要真实 dense channel 和索引实现来确定边界。 |
| VRF-006 | 待调用方出现后重排 | Candidate 扩展会影响 T6 的融合、授权可见性和回答资格，等 T6 真正消费 `rag-core` 再定。 |
| VRF-007 | 待调用方出现后重排 | Temporal 邻接和 IoU 的性能/方向约束要由真实时间证据调用方验证，不能只按协议想象冻结。 |
| VRF-008 | 待调用方出现后重排 | Context/Citation 的授权输入和最终发布校验依赖 T8 的真实回答链路。 |
| VRF-009 | 待调用方出现后重排 | EvaluationRun 的重放身份与资源指标依赖评测 Runner 和数据集调用方。 |
| VRF-010 | 待调用方出现后重排 | 跨语言 fixtures 需要 TypeScript 与未来 Rust 的实际实现，不先为不存在的第二实现造契约。 |
| VRF-011 | 待调用方出现后重排 | 取消、重试、恢复和迟到结果测试必须挂在 Web/Desktop Adapter 的真实生命周期上。 |
| VRF-012 | 待调用方出现后重排 | 候选/上下文预算和资源采集要由真实检索入口与 T12/T15 的预算调用方共同确定。 |
| VRF-013 | 暂不排 | `scene-core` 规划资料已迁移，但目标 git 仓库尚未初始化，属于另一仓库的媒体实现。 |
| VRF-014 | 暂不排 | `scene-seek` 规划资料已迁移但当前无提交，且依赖 VRF-013 的真实引擎协议。 |
| VRF-015 | 暂不排 | G0～G4 必须建立在 VRF-013/014 的真实媒体、恢复和资源证据之上。 |

## 4. 任务完成标准

V0b 只有在 VRF-001～VRF-012 中的 P0 验收证据全部齐备后，才可以将公共基座状态从 CONTRACT_READY_WITH_ACTIONS 提升为 CONTRACT_READY。该状态仍不等于真实 Video RAG 可用。

真实 Video RAG 还必须通过 VRF-013～VRF-015 的 G0～G4。评测报告必须绑定数据集版本、Pipeline、Provider、模型、Embedding Channel、引擎版本、输入指纹和资源结果；不得提交用户媒体、真实转写、授权信息、模型权重或 Seelyn 原始数据库。

## 5. 决策覆盖索引

| 决策范围 | 任务 |
|---|---|
| D2、D3、D24、D27、D29、D42 | VRF-001、VRF-010 |
| D4、D5、D6、D25 | VRF-003、VRF-004、VRF-013 |
| D7、D15、D19、D21、D30、D34、D37、D47、D49 | VRF-006、VRF-012 |
| D8、D10、D46、D48 | VRF-007 |
| D9、D18、D22、D45 | VRF-003、VRF-011、VRF-014 |
| D11、D12、D13、D39 | VRF-003 |
| D14、D20 | VRF-005 |
| D16、D17、D23、D33、D44 | VRF-009 |
| D26、D28、D35、D36、D40、D41 | VRF-002、VRF-008、VRF-010 |
| D31、D32、D38 | VRF-008 |
| D43 | VRF-010、VRF-014 |
