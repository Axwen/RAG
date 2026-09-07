# Video RAG Readiness Gate

> 目的：决定何时可以从公共基座进入真实 Video RAG 实现。公共契约已先行，但本门禁未通过前不能宣称 Video RAG 可用或优于 Seelyn。

## 1. Gate 结论规则

- `READY`：所有 P0 条件通过，P1 条件有证据或明确批准的后置项；
- `READY_WITH_ACTIONS`：主链可运行，但存在已登记、不会造成证据错误或旧结果污染的行动项；
- `BLOCKED`：任一 P0 失败，或只能返回整条视频、只能依赖 ASR、没有时间引用、没有旧结果隔离或没有资源基线。

没有真实媒体和黄金集时，状态最多为 `CONTRACT_READY`，不等于 Video RAG `READY`。

当前分支状态：CONTRACT_READY_WITH_ACTIONS。公共契约和纯逻辑已有首版实现，但 V0.1 硬化项、跨语言 conformance 和真实媒体 Gate 尚未全部完成。

## 2. 进入真实实现前必须稳定的公共能力

| 条件 | 验收证据 |
|---|---|
| Evidence/Locator/Provenance 契约 | `@rag/contracts` 类型和非法定位测试 |
| ProviderRun/JobEvent | Run/Artifact/Event 字段可回放，所有结果带版本和指纹 |
| 旧结果隔离 | `generation`、`inputFingerprint`、`runId`、`attempt` 门禁测试 |
| Embedding Channel | 文档 1024 channel 与未来视觉 channel 可并存，维度不在 rag-core 全局 |
| Candidate/Citation | 候选保留来源、模态、Locator、channel、时间关系；Citation 支持 time/frame/region |
| 纯逻辑 | 融合、去重、时间关系、引用校验、Temporal IoU、Recall/MRR/nDCG 可独立测试 |
| 评测格式 | dataset/query/expected evidence/run/metrics/resource 可保存并重跑 |
| 文档兼容 | 现有文档契约、Manifest、ACL 和 Web 基础设施不回归 |

## 2.1 V0.1 公共基座硬化门禁

- [ ] 所有公共对象有 JSON Schema 或等价运行时校验，错误路径可诊断且不会静默放宽；
- [ ] Envelope、Hash/Fingerprint、Evidence ID、Artifact kind、JobEvent payload 和兼容矩阵已有版本规则；
- [ ] Candidate 的 score kind/direction、contributions、matchedChannels、projection/index snapshot、visibility 和 answer eligibility 可回放；
- [ ] Query 显式携带 dense channel/向量身份，结构化过滤与 ACL 外部上下文边界明确；
- [ ] Context/Citation 已区分授权资格、诊断格式化和最终发布校验；
- [ ] 取消、重试、恢复、superseded、幂等事件和 active attempt 写回有 Adapter 集成测试；
- [ ] TypeScript 与未来 Rust 实现通过相同 fixtures/golden outputs，且不依赖 Node sidecar；
- [ ] EvaluationRun 可保存完整重放身份、生命周期、样本/聚合/分桶和资源阶段指标；
- [ ] rag-core 候选预算、确定性排序、最近邻接、Temporal IoU 对齐和 O(n log n) 性能约束有测试。

## 3. Video V0/V1/V2/V3 门禁

### G0：真实媒体边界

- [ ] 本地导入不依赖手工改数据库；
- [ ] content hash、AssetVersion 和缺失文件状态可恢复；
- [ ] FFprobe 产出媒体流、时长、分辨率和错误摘要；
- [ ] FFmpeg 抽帧/音频/封面成功、超时、失败和 Artifact 清理可验证；
- [ ] SQLite WAL 事务、锁冲突、异常退出恢复有测试；
- [ ] 无音轨、损坏媒体、文件被移动/删除是明确失败或降级，而不是“分析完成”。

### G1：文本时间证据

- [ ] 外部/内嵌字幕可导入为 `subtitle` Evidence；
- [ ] ASR 输出为 `speech` Evidence，具有整数毫秒区间；
- [ ] FTS/稀疏检索返回正确 Asset、Evidence、模态和时间；
- [ ] 点击结果可跳到片段而非只打开整条视频；
- [ ] ASR CER/WER、召回和片段定位有黄金标注；
- [ ] ASR Provider 不可用、取消、超时和重试不污染当前结果。

### G2：镜头和视觉证据

- [ ] Asset → Scene/Shot → Evidence 关系可查询；
- [ ] shot/scene 分段边界有人工标注或可复现基线；
- [ ] OCR Evidence 绑定时间和 image region/bbox；
- [ ] 视觉 Embedding 使用独立 image/video_segment channel；
- [ ] 文字搜画面和图片搜画面都返回片段级候选；
- [ ] 视觉索引重建不会混用旧 channel 或旧 segmentationRef；
- [ ] 视觉 Provider 失败、取消和恢复可诊断。

### G3：可信检索与问答

- [ ] lexical、dense、metadata 能融合并保留来源；
- [ ] temporal adjacency、diversity 和 rerank 有固定配置版本；
- [ ] Temporal IoU、Recall@K、MRR/nDCG、Correct Asset Rate 达到项目批准阈值；
- [ ] Citation 支持 time range、frame、region，且可验证；
- [ ] 无据句、blocked Evidence 和冲突证据不会形成 `ANSWERED`；
- [ ] 取消/重试/superseded 的旧结果不能改变当前索引。

### G4：资源和发布

- [ ] import/query P50/P95 已记录；
- [ ] 峰值内存、CPU/GPU 使用和磁盘/WAL 增长已记录；
- [ ] 长视频、批量导入、模型不可用、磁盘不足和 SQLite lock 有恢复演练；
- [ ] 数据集、Pipeline、Provider、模型、Channel、输入指纹全部进入评测报告；
- [ ] 对比 Seelyn 或上一 Pipeline 时结论可回放，不能只凭体验宣称先进；
- [ ] 本地分发、模型安装、许可和隐私边界已单独审查。

## 4. 本轮明确未实现

本轮只完成公共契约、纯逻辑、评测格式和计划，不实现：

- FFmpeg/FFprobe；
- ASR、OCR、VLM/Caption；
- Tauri/Rust UI；
- SQLite schema/WAL Adapter；
- 本地文件 Artifact Store；
- 视频专用 Worker/进程管理；
- 文字搜画面、图片搜画面和真实时间线跳转；
- 独立 Video RAG 服务。

## 5. Gate 产物

每次关闭 Gate 必须提交：

1. `pipelineRef`、dataset/version、Provider/model/channel 清单；
2. 查询和 Expected Evidence 时间标注；
3. 检索、时间、引用、ASR/OCR 和资源指标；
4. 成功/失败/取消/恢复/旧结果隔离报告；
5. 已知回归、未验证项目和下一步行动；
6. 不包含用户媒体、真实转写、授权信息、模型权重或原始数据库的脱敏 fixture。
