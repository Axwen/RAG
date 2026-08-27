# PROBE-006 分块策略与引用定位探针结果

- 状态：**PASS_WITH_ADJUSTMENT**
- 执行时间：2026-08-26T11:17:20Z
- ParseArtifact：5 份
- 黄金题：6 题
- 宿主 Docker Engine 可见内存：23.47 GiB（来自 PROBE-000；本轮不外推为完整 24 GiB profile 的容量证明）

> Recall@5 只有真实 Embedding + OpenSearch 路径才计入；本地分块统计不替代真实检索。

> **证据边界**：本轮真实评测覆盖 5 份 ParseArtifact、6 道黄金题、最小 kNN mapping 和纯 kNN 查询路径。它足以支持阶段 1 冻结 `wide-1024`，但不等于完整 BM25+向量混合检索、Rerank 后质量或生产 `tenant/KnowledgeSpace/partition/release/acl_scope_key/valid_from/valid_to/deleted` 过滤链已验证；也不是完整 50 题黄金集的业务回归基线。`truncation_rate` 是 table/code/list 三类 split rate 的平均值。

## 参数对比

| 候选 | 块数 | 引用可定位率 | 截断率 | 确定性 | Recall@5 | 索引估算字节 | 写入秒 |
|---|---:|---:|---:|---|---:|---:|---:|
| compact-256 | 10 | 1.0 | 0.1667 | 是 | 0.6667 | 22798 | 0.0185 |
| balanced-512 | 7 | 1.0 | 0.1667 | 是 | 0.6667 | 21770 | 0.0121 |
| wide-1024 | 5 | 1.0 | 0.0 | 是 | 1.0 | 21131 | 0.0135 |
| balanced-512-parent-child | 13 | 1.0 | 0.3333 | 是 | 0.6667 | 43281 | 0.0332 |

## 冻结结果

```json
{
  "name": "wide-1024",
  "max_chars": 1024,
  "overlap_chars": 128,
  "rows_per_chunk": 32,
  "tolerance_factor": 3,
  "parent_child": false,
  "tokenizer_mode": "infinity",
  "embedding_dimensions": 1024,
  "embedding_version": "qwen/qwen3-embedding-8b",
  "index_schema_version": "opensearch-knn-lucene-hnsw-v1"
}
```

## 决策

- 冻结候选：wide-1024
- parent-child 未优于叶块检索，阶段 1 不启用父子分块
