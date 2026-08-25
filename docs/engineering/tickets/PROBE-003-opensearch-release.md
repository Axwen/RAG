# PROBE-003：OpenSearch 混合检索与 Release/Alias 探针

## 目的

验证 OpenSearch 文档/Chunk 双索引、1024 维向量、kNN 引擎与参数选型、BM25 + 向量过滤、版本化 Alias、候选 Release 原子切换、作用域键过滤、重启恢复和查询资源边界（含堆外内存）。

## 当前依据

- 工程评审闭合记录第 4、14、15 节
- [ADR-0019](../../adr/0019-event-driven-index-projections.md)
- [ADR-0023](../../adr/0023-orthogonal-runtime-state-machines.md)
- [ADR-0026](../../adr/0026-acl-scope-key-and-authoritative-recheck.md)
- [ADR-0028](../../adr/0028-embedding-version-partition-and-rebuild.md)

## 输入与边界

- 单节点 OpenSearch，JVM 初始 2 GiB；容器内存上限与 JVM heap 分开记录，堆外向量内存不得挤爆容器。
- 两个 KnowledgeSpace、两个 IndexPartition（唯一键含 `embeddingVersion`）、文档索引和 Chunk 混合索引。
- 合成文档、作用域键、版本、删除墓碑和 1024 维向量。
- 单次最多 fan-out 2，候选最多 1024，请求总超时 250 ms；ACL 候选复核不在本探针的 250 ms 预算内。
- kNN 候选组合至少覆盖 `lucene` 与 `faiss` 两种 engine，`hnsw` 方法下比较不同 `m` / `ef_construction` / `ef_search`。

## 必须验证

1. Index Schema 与向量 dimension/metric/归一化方式一致，错误组合被拒绝；`embeddingVersion` 不同的分区不共用索引。
2. kNN engine、method 与参数组合的选型结论：召回、查询延迟、索引体积、构建时间和堆外原生内存峰值，产出一组冻结的默认参数。
3. 带过滤条件的 kNN（filtered kNN）相对无过滤 kNN 的召回衰减可测量，且在最严格的作用域过滤下仍满足候选数量要求；若衰减不可接受，记录改用后过滤或分区隔离的结论。
4. BM25 和向量查询都带 tenant、KnowledgeSpace、Partition、Release、`acl_scope_key`、有效期和删除过滤；索引内不存在 `acl_subject_ids` 与 `acl_revision` 字段。
5. Candidate Alias 可以一次操作切换到新 Release，并保留上一 Release 回滚。
6. Alias 已切但 PostgreSQL 确认丢失时，Intent/Reconciler 能确认或恢复。
7. 删除中的 Release、Legal Hold 和过期证据不能被激活或回滚。
8. 记录写入、查询 P50/P95、Alias 切换、重启恢复、JVM heap 峰值、堆外原生内存峰值、容器 RSS 峰值和候选数量。

## 产出

- `probe-003-opensearch-release.md`
- `probe-003-opensearch-release.json`
- Index Schema、Alias 操作和故障注入脚本。
- 冻结的 kNN engine/method/参数默认值，写入 Index Schema 版本。
- 查询性能和内存报告（heap、堆外、容器 RSS 分列）。

## 通过标准

- `PASS`：作用域过滤、Alias、回滚和性能硬边界均成立，且 kNN 参数与内存占用在单节点 2 GiB heap 边界内自洽。
- `PASS_WITH_ADJUSTMENT`：需要调整索引字段、kNN engine/参数、Alias 操作或查询预算，但不改变 OpenSearch 作为索引事实投影的定位。
- `BLOCKED`：无法保证作用域过滤、原子切换/恢复、1024 维向量契约，或带过滤 kNN 的召回衰减使 Recall@5 不可能达标。

## 测试与回滚

- 使用真实 OpenSearch 容器和 REST API；不以内存 Mock 替代。
- 探针失败删除测试 Index、Alias 和容器卷即可回滚。

