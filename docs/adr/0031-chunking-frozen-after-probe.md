---
status: accepted
---

# 分块策略经 PROBE-006 实测后冻结，不在探针前写死参数

现状是只有 `ChunkingStrategy` 契约和 `ChunkManifest` 版本化，没有阶段 1 的具体策略；父子粒度、token 数、重叠比例、表格与条款的切分规则全部未定。分块是对 Recall@5 与引用可定位率影响最大的单一变量，却是五个探针里唯一没有被覆盖的假设。把参数凭经验写死会让首轮评测无法归因到分块还是检索。

新增 PROBE-006 分块与引用定位探针，输入复用 PROBE-002 的解析样本与 50 题黄金集的子集，对比候选分块参数组合在固定语料上的 Recall@5、引用可定位率、表格与条款截断率和索引体积。探针产出一份冻结的 `ChunkingManifest` 默认值，写入 `IngestionManifest`，此后参数变化按 Manifest 不可变规则新建版本。

PROBE-006 在 PROBE-002 通过后执行，与 PROBE-005 可并行，但不得与 DeepDOC 或批量评测同时占用 24 GiB profile。它属于 Probe Decision Gate 的组成部分：结论为 `BLOCKED` 时不得进入 T1b、T5、T6 的正式索引实现，因为分块参数会同时决定 Prisma 的 `chunk_manifest` 字段和 OpenSearch mapping 的父子关系表达；T1a 的基础 Manifest/Prisma 契约和迁移准备可以继续，但不编码最终 Chunk 字段。

阶段 1 的默认候选方向仍是结构化自适应加 parent-child、表格与代码块整块不切、按 `section_path` 对齐标题层级；但这些是探针的输入假设而不是已确认决策。探针可以推翻其中任何一项，包括"是否在阶段 1 引入父子分块"。

探针冻结之后，分块参数变化与 Embedding 变化同等对待：都触发全量黄金集回归，都需要按 ADR-0028 的重建协议在新分区重建，不允许在现有分区内混用两种分块版本。
