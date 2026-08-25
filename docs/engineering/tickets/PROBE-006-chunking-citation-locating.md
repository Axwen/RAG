# PROBE-006：分块策略与引用定位探针

## 目的

在固定语料上实测候选分块参数组合对 Recall@5、引用可定位率、表格与条款截断率和索引体积的影响，产出一份冻结的 `ChunkingManifest` 默认值，避免首轮评测无法把结果归因到分块还是检索。

## 当前依据

- [ADR-0031](../../adr/0031-chunking-frozen-after-probe.md)
- [ADR-0028](../../adr/0028-embedding-version-partition-and-rebuild.md)
- [ADR-0033](../../adr/0033-deterministic-evidence-conflict-resolution.md)
- 工程评审闭合记录第 4 节

## 输入与边界

- 复用 PROBE-002 产出的 `ParseArtifact` 样本，不重新解析原文件。
- 50 题黄金集的子集，至少覆盖表格类、条款类和长流程类问题。
- 与 PROBE-002 相同的 Embedding 模型与维度，保证组间只有分块变量。
- 在 PROBE-002 通过后执行，可与 PROBE-005 并行；不得与 DeepDOC 解析或批量评测同时占用 24 GiB profile。

## 必须验证

1. 候选参数组合在同一语料上的 Recall@5 差异可测量，组间差异大于运行间波动。
2. 引用可定位率：命中 Chunk 能否稳定回指到原文的页/坐标/`section_path`，父子分块下父块展开是否仍精确定位到子块。
3. 表格与条款截断率：表格、代码块和编号条款被切断的比例，以及整块不切策略对 token 上限的影响。
4. 索引体积与写入耗时随分块粒度和重叠比例的变化。
5. 是否在阶段 1 引入父子分块的结论——探针有权否决该假设。
6. 冻结参数在同一输入上可复现：相同 `ParseArtifact` 与相同参数产生逐字节相同的 Chunk 序列与稳定的 Chunk 标识。

## 产出

- `probe-006-chunking-citation-locating.md`
- `probe-006-chunking-citation-locating.json`
- 冻结的 `ChunkingManifest` 默认值及其写入 `IngestionManifest` 的字段清单。
- 参数组合对比表（Recall@5、引用可定位率、截断率、索引体积、写入耗时）。

## 通过标准

- `PASS`：存在一组参数同时满足 Recall@5 与引用可定位率目标，且截断率与索引体积可接受，可冻结为默认值。
- `PASS_WITH_ADJUSTMENT`：需要调整粒度、重叠比例或放弃父子分块等假设，但分块仍可冻结为确定性 Manifest。
- `BLOCKED`：无法在任何候选组合下同时满足 Recall@5 与引用可定位率，或分块结果不可复现。`BLOCKED` 时不得进入 T1b、T5、T6 的正式索引实现，因为分块参数同时决定 Prisma 的 `chunk_manifest` 字段与 OpenSearch 父子关系表达；T1a Manifest/Prisma Core 可以继续进行，不编码最终 Chunk 字段。

## 测试与回滚

- 使用真实 OpenSearch 容器与真实 Embedding 调用，评测调用走评测池预算。
- 探针失败删除测试 Index 与临时产物即可回滚；不修改业务代码，不写入正式 Manifest。
