---
status: accepted
revised: 2026-08-26
---

# 分块策略经 PROBE-006 实测后冻结，不在探针前写死参数

现状是只有 `ChunkingStrategy` 契约和 `ChunkManifest` 版本化，没有阶段 1 的具体策略；父子粒度、token 数、重叠比例、表格与条款的切分规则全部未定。分块是对 Recall@5 与引用可定位率影响最大的单一变量，却是五个探针里唯一没有被覆盖的假设。把参数凭经验写死会让首轮评测无法归因到分块还是检索。

新增 PROBE-006 分块与引用定位探针，输入复用 PROBE-002 的解析样本与 50 题黄金集的子集，对比候选分块参数组合在固定语料上的 Recall@5、引用可定位率、表格与条款截断率和索引体积。探针产出一份冻结的 `ChunkingManifest` 默认值，写入 `IngestionManifest`，此后参数变化按 Manifest 不可变规则新建版本。

PROBE-006 在 PROBE-002 通过后执行，与 PROBE-005 可并行，但不得与 DeepDOC 或批量评测同时占用 24 GiB profile。它属于 Probe Decision Gate 的组成部分：结论为 `BLOCKED` 时不得进入 T1b、T5、T6 的正式索引实现，因为分块参数会同时决定 Prisma 的 `chunk_manifest` 字段和 OpenSearch mapping 的父子关系表达；T1a 的基础 Manifest/Prisma 契约和迁移准备可以继续，但不编码最终 Chunk 字段。

探针执行前的候选方向是结构化自适应加 parent-child、表格与代码块整块不切、按 `section_path` 对齐标题层级；这些只是输入假设。第二轮实测已经推翻阶段 1 引入父子分块的假设，当前执行决策见下方冻结记录。

探针冻结之后，分块参数变化与 Embedding 变化同等对待：都触发全量黄金集回归，都需要按 ADR-0028 的重建协议在新分区重建，不允许在现有分区内混用两种分块版本。

2026-08-26 第一轮 PROBE-006 已执行但为 `BLOCKED`：本地候选分块的引用回链和确定性检查通过，然而输入仍使用 PROBE-002 的 `stub` tokenizer，且评测环境没有 Embedding 密钥和真实 OpenSearch 端点，因此没有合法的 Recall@5、写入耗时或索引体积实测。该轮不得产生冻结 Manifest；补齐真实 tokenizer、Embedding 与 OpenSearch 后必须复跑。

2026-08-26 第二轮已使用真实 `infinity-sdk==0.7.3` tokenizer、OpenRouter `qwen/qwen3-embedding-8b`（`dimensions=1024`）和 OpenSearch 2.19.1 完成复测，结果为 `PASS_WITH_ADJUSTMENT`：`compact-256` / `balanced-512` / `wide-1024` / `balanced-512-parent-child` 的 Recall@5 分别为 `0.6667 / 0.6667 / 1.0 / 0.6667`；四组引用可定位率均为 `1.0`，`wide-1024` 截断率为 `0` 且 Chunk ID 确定性通过。阶段 1 冻结 `wide-1024`（`max_chars=1024`、`overlap_chars=128`、`rows_per_chunk=32`、`tolerance_factor=3`、`parent_child=false`、Embedding 1024 维、Index Schema `opensearch-knn-lucene-hnsw-v1`），不启用 parent-child。**证据边界**：本轮只有 5 份 ParseArtifact、6 道黄金题和最小纯 kNN mapping，未验证完整混合检索、Rerank 后质量、生产 ACL/有效期/删除过滤链或完整 50 题黄金集；因此该结果是阶段 1 冻结依据，不是生产检索基线。
