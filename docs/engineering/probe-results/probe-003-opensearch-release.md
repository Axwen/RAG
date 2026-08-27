# PROBE-003 OpenSearch 混合检索 / Release-Alias / kNN 参数

- status: `PASS`
- OpenSearch image: `opensearchproject/opensearch:2.19.1`
- 语料: `1500` docs / `30` queries / dim `1024` / space `cosinesimil`

## 冻结默认 kNN 参数
```json
{
  "engine": "lucene",
  "method": "hnsw",
  "m": 16,
  "ef_construction": 128,
  "ef_search": 512,
  "space_type": "cosinesimil",
  "dimension": 1024,
  "rationale": "pure-ANN recall@5=1.0, p95=28.01ms, engine off-heap=0KB"
}
```

## 参数扫描 (recall@5=纯ANN / filtered=带作用域过滤 / p50/p95=过滤路径延迟)

> recall@5 走无 filter 的纯 HNSW 近似路径(真实近似召回);filtered 走带 acl_scope_key 的生产路径,
> 本量级被短路为 exact search 故为 1.0;knn-graph-KB 是该 engine 首次被 exercise 时的堆外原生图增量,
> lucene 的 HNSW 存于 Lucene 段 mmap(计入容器 RSS 而非 knn 原生缓存)故为 0,faiss 占用堆外原生内存。

| engine | m | ef_c | ef_s | recall@5 | filtered | decay | p50ms | p95ms | size(MB) | build(ms) | knnKB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| lucene | 16 | 128 | 100 | 0.9933 | 1.0 | -0.0067 | 8.25 | 25.09 | 28.9 | 1495.0 | 0 |
| lucene | 16 | 128 | 512 | 1.0 | 1.0 | 0.0 | 7.09 | 28.01 | 28.9 | 1495.0 | 0 |
| faiss | 16 | 128 | 100 | 0.9933 | 1.0 | -0.0067 | 6.41 | 25.51 | 29.0 | 1089.5 | 4978 |
| faiss | 16 | 128 | 512 | 1.0 | 1.0 | 0.0 | 5.64 | 24.6 | 29.0 | 1089.5 | 0 |

## 结构与协议校验
- wrong_dimension_rejected: `True`
- invalid_engine_rejected: `True`
- partition_isolated: `True`
- index_fields_ok: `True`
- has_acl_subject_ids: `False`
- has_acl_revision: `False`
- alias_atomic_ok: `True`
- reconciler_ok: `True`
- activation_guards_ok: `True`

## 资源峰值
- JVM heap used: `562.4` MB
- kNN off-heap graph: `4978` KB
- container RSS: `2602.0` MB (23.47 GiB Engine profile)

## 待决策
- 冻结参数基于 1500 条合成高斯向量;engine=lucene 与 ef_search 需在真实 embedding、接近 1024 候选上限的语料上复测后再最终定档(随 PROBE-006 一并复核)。
- 带 acl_scope_key filter 的查询在本量级被 OpenSearch 短路成 exact search(off-heap=0);真实规模下需复核过滤路径是否转为近似及其召回衰减。

> 混合检索用 acl_scope_key 作用域预过滤 + 索引外 PG 权威复核;kNN 冻结 lucene/hnsw m=16 ef_c=128 ef_s=512;Release 用 Candidate Alias 原子切换 + Intent/Reconciler 兜底。
