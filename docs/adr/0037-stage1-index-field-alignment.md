---
status: accepted
date: 2026-08-27
decision-basis: PROBE-003 mapping review and Probe Decision Gate closeout
---

# 阶段 1 OpenSearch 索引字段与 ACL 作用域口径对齐

## 决策

阶段 1 的 OpenSearch 文档不单独保存 `data_class` 或 `visibility_class` 字段。

- `data_class` 由 `IndexPartition` 的唯一键和 `index_partition_id` 承载；更换数据等级、Embedding 或索引 schema 时创建新的分区，不在旧索引中原地改写。
- `visibility_class` 不作为阶段 1 的独立索引过滤字段。需要表达可见性时，将其纳入 PostgreSQL 编译出的 `acl_scope_key`，并由候选合并后的 PostgreSQL 权威复核作最终判定。
- 索引保留 `tenant_id`、`knowledge_space_id`、`index_partition_id`、`release_id`、`acl_scope_key`、`embedding_version`、`valid_from`、`valid_to`、`deleted` 以及正文和向量字段。索引不得包含 `acl_subject_ids` 或 `acl_revision`。
- `acl_scope_key` 的编码由应用层统一生成和解析；它是过滤键，不是把主体列表去规范化进索引。

## 依据

PROBE-003 的真实 mapping 已验证上述字段集合、分区隔离、Release Alias、删除/有效期守卫和 `acl_scope_key` 过滤。该探针没有独立的 `data_class` 或 `visibility_class` 字段，因此技术设计样例和 F-25 检查项必须以此冻结 mapping 为准，不能继续维护一套未被实测的平行字段契约。

这项决策不改变 [ADR-0026](0026-acl-scope-key-and-authoritative-recheck.md) 的两段授权不变量：查询前由 PostgreSQL 编译作用域集合做预过滤，候选合并后再以一次批量 PostgreSQL 查询进行权威复核；PostgreSQL 不可用或复核超时时 fail closed。

## 影响与后续

1. 技术设计方案 §7.4、F-25 和 `PROJECT_STATE.md` 统一引用本 ADR 与 PROBE-003 mapping。
2. 若阶段 1 以后确实需要独立按 `visibility_class` 聚合或过滤，必须新增 ADR、更新 OpenSearch mapping 版本并重建受影响分区，不得在旧 Release 上原地增加字段后宣称兼容。
3. 真实业务语料回归仍需验证 `acl_scope_key` 过滤在接近 1024 候选规模时的近似路径和召回衰减；这属于实现集成验证，不改变本字段口径。
