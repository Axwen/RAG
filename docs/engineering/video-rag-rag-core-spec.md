# `rag-core` 纯逻辑 Spec

> 目标：让文档 RAG 和未来 Video RAG 共享可测试的语义逻辑，同时不引入任何存储、媒体工具或模型 SDK。  
> 实现位置：`packages/rag-core/src/`  
> 契约来源：[公共契约 Spec](video-rag-public-contract-spec.md)

## 1. 依赖红线

允许依赖：`@rag/contracts` 和 TypeScript/Node 标准库。禁止依赖：

- Prisma、PostgreSQL、OpenSearch、RabbitMQ、SQLite；
- FFmpeg、FFprobe、Tauri、Windows API；
- 具体 ASR/OCR/VLM/Embedding/Reranker/Chat SDK。

`rag-core` 不做 I/O、网络、事务、队列 ACK、ACL 查询或文件读取。

## 2. 已实现的纯逻辑

| 模块 | 公共入口 | 语义 |
|---|---|---|
| 候选 | `fuseCandidateLists` | 加权 RRF 融合 lexical/dense/metadata |
| 候选 | `deduplicateCandidates` | 按 `sourceVersionId + evidenceId` 去重 |
| 候选 | `compareCandidates`、`sortAndRankCandidates` | score/rank/source/version 的确定性排序 |
| 候选 | `diversifyCandidates`、`rerankCandidates` | 按来源版本/模态限额并应用外部 Reranker 分数 |
| 时间 | `temporalRelationBetween` | overlap/adjacent/none |
| 时间 | `annotateTemporalRelations` | 给同一版本候选标注与邻居的关系 |
| 上下文 | `assembleContext` | 过滤阻断/不可用/错位 Evidence，去重并限量 |
| 引用 | `formatLocator`、`formatCitation` | page/time/frame/region/url 确定性格式化 |
| 引用 | `validateCitation` | Source、Version、Evidence、Locator 和安全状态校验 |
| 回答 | `isGroundedAnswer` | 每个非空事实句需要可验证 verified Citation |
| Provider | `canAcceptProviderResult` | SourceVersion/Generation/Fingerprint/Run/Attempt/状态写回门禁 |
| 评测 | `recallAtK`、`meanReciprocalRank`、`ndcg` | 检索指标 |
| 评测 | `correctAssetRate` | Top-K 是否命中正确素材 |
| 评测 | `temporalIoU`、`bestTemporalIoU` | 时间区间定位质量 |

## 3. 算法口径

### 3.1 候选融合

每一路 Candidate 先保留自身 `retrievalSource`、raw score、rank、channelId 和 Locator。融合使用：

```text
fusedScore(candidate) = Σ sourceWeight / (rrfConstant + sourceRank)
```

同一 `sourceVersionId + evidenceId` 合并后，按融合分数、原始 rank、来源版本、Evidence、模态、来源类型和 candidateId 全序排序，再重新编号 rank。输入顺序改变不能改变输出。

### 3.2 时间关系

只从 `time_range` 计算：

- 区间交集大于 0 → `overlap(overlapMs)`；
- 无交集且间隔不超过窗口 → `adjacent(gapMs, direction)`；
- 非时间 Locator 或超窗 → `none`。

时间关系是排序/展示特征，不是授权或证据真实性。

### 3.3 上下文组装

`assembleContext` 只接收 Candidate + 已取回的 Evidence：

1. 按 Candidate rank 遍历；
2. Candidate/Evidence ID 与 sourceVersion 必须一致；
3. 只允许 `candidate/published` 且非 `blocked`；
4. Evidence ID 去重；
5. 按 `maxItems`/`maxCharacters` 截断。

纯视觉 Evidence 可以留下 `text=null`，由上层搜索/UI 使用其 Locator/Artifact；不强行生成描述。

### 3.4 Citation 验证和 Grounded Answer

`validateCitation` 至少比较：`evidenceId`、`sourceId`、`sourceVersionId`、结构化 Locator，并拒绝 deleted/quarantined/blocked/rejected。它不查询数据库，也不判断当前用户 ACL；这些由调用方在拿到 Evidence 前后完成。

`isGroundedAnswer` 对空句不作事实要求；对非空句要求至少一个 `verified` 且 `validateCitation(...).valid` 的 Citation。没有 Citation 的句子不算 grounded。

### 3.5 Provider 旧结果门禁

```text
status ∈ {running, retrying}
sourceVersionId == currentSourceVersionId
runId == currentRunId
generation == currentGeneration
inputFingerprint == currentInputFingerprint
attempt == currentAttempt
```

六项同时成立才返回 true。函数返回 true 只表示“允许进入 Adapter 的原子写回”，不代表已经完成写库或索引。

### 3.6 评测

- Recall@K：Top-K 命中的去重 Expected Evidence 数 / 期望 Evidence 数；
- MRR：第一个相关 Candidate 的倒数 rank；
- nDCG：二值相关性、标准 log2 discount；
- Correct Asset Rate：Top-K 是否命中期望 sourceId；
- Temporal IoU：`intersection / union`，非时间 Locator 得 0；
- Citation Precision 和 Grounded Answer Rate 由上层根据逐句 Citation 验证结果聚合，核心只提供 Citation validator/grounded 判定所需的公共入口。

## 4. 不能放进 `rag-core` 的逻辑

- PostgreSQL ACL 权威复核、业务审计写入和删除事实；
- OpenSearch kNN/BM25 查询、SQLite FTS/向量 SQL；
- RabbitMQ retry/DLX、Outbox、lease 和进程恢复；
- FFprobe/FFmpeg、shot detection、ASR、OCR、VLM；
- 任何 Provider 的模型路由、预算预扣或原始错误翻译。

## 5. 测试要求

- 同一输入随机重排后融合结果一致；
- 多路同一 Evidence 去重且不丢 sourceVersion/channel/Locator；
- `startMs < 0`、`endMs <= startMs`、非整数毫秒均拒绝；
- page/character/bbox/frame/region/url 全部可格式化；
- Citation source/version/Locator 不一致、deleted、quarantined、blocked 和 rejected 均拒绝；
- Generation、InputFingerprint、Attempt、Run 或状态任一不匹配均拒绝旧结果；
- 文档 Evidence 和视频时间 Evidence 共用同一 Context/Citation/metric 入口；
- 测试不启动 Prisma、OpenSearch、RabbitMQ、SQLite、FFmpeg 或模型 Provider。

## 6. 评审硬化项

当前代码是首版纯逻辑实现，不代表以下硬化项已经完成。实现任务见 [Video RAG 公共基座实施任务](video-rag-implementation-tasks.md)。

| 类别 | 必须关闭的要求 |
|---|---|
| 校验 | Candidate、Query、TemporalRelation、Citation、Run、Event、Evaluation 和指标对象的运行时校验；非法权重/分数显式拒绝 |
| 确定性 | 完整排序键、固定 score direction、最近时间邻居、ranked-candidate/Top-K 统一口径；输入重排不改变输出 |
| 安全 | Context Assembly 接收授权结果；检索可见性与回答资格分离；诊断 Citation 与最终可发布 Citation 分离 |
| 性能 | 候选和上下文预算；Temporal adjacency O(n log n) 或近似线性；bestTemporalIoU 单次循环 |
| 互操作 | JSON Schema、跨语言 fixtures/golden outputs、未来 Web/Desktop E2E 和 Adapter 取消/恢复/旧结果集成测试 |

具体算法口径补充：

1. Candidate 必须保留每一路 contributions 和 matchedChannels，并携带 score kind/direction、projection/index snapshot identity。
2. TemporalRelation 的 before/after 以当前 Candidate 为参照；邻接按同一 sourceVersionId 的最近时间邻居计算。
3. Context Assembly 只接受已授权且 answer eligible 的 Evidence；视觉 Evidence 可以通过 Artifact/content reference 进入上下文，即使没有文本。
4. Citation 的诊断格式化与最终可发布校验分离；formatter 不能掩盖校验失败。
5. 指标入口必须接收明确的 ranked-candidate/Top-K 口径和候选预算；Temporal IoU 先按 sourceVersionId 对齐，evidenceId 缺失时使用 source/version/modality/Locator fallback。
6. Provider 写回只允许当前 active attempt；取消、superseded 或 expired 的结果即使保留为历史事实，也不能改变当前索引。
