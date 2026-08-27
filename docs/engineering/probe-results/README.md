# 架构探针结果索引

本目录保存可复跑的探针证据。每个探针只有一组“当前主结果”；供应商横向实验、重复运行和被后续结论替代的记录保留为历史证据，不得覆盖主结果。运行日志不是正式结果，`probe-002-container.log` 已被 Git 忽略。

| 探针 | 当前状态 | 当前主结果 | 已冻结结论 | 未闭合项 / 适用边界 |
|---|---|---|---|---|
| PROBE-001 | PASS | [OIDC](probe-001-keycloak-oidc.md) | Keycloak PKCE、撤权和不可用 fail closed 可用 | 应用集成时仍验证会话和权限投影 |
| PROBE-002 | PASS | [DeepDOC](probe-002-deepdoc-parser.md) | 5 类合成样本解析和定位可用 | Parser Service 生命周期、取消、崩溃恢复和 PostgreSQL 幂等为集成测试项 |
| PROBE-003 | PASS | [OpenSearch](probe-003-opensearch-release.md) | lucene/hnsw `m=16`、`ef_c=128`、`ef_s=512`；Alias 与 `acl_scope_key` 路径成立 | 1500 条合成向量；真实 Embedding、接近 1024 候选和过滤近似路径仍须回归 |
| PROBE-004 | PASS | [RabbitMQ](probe-004-rabbitmq-task-bus.md) | TTL+DLX、DLQ、取消、重放与 quarantine 语义成立 | Publisher Confirm、prefetch 与生产重试阶梯须由真实 Worker/AMQP 客户端复验 |
| PROBE-005 | PASS_WITH_ADJUSTMENT | [Embedding](probe-005-model-adapter.md)、[Chat](probe-005-model-adapter-responses-fluxionai.md)、[Reranker](probe-005-model-adapter-rerank-openrouter.md) | Embedding=OpenRouter、Chat=fluxionai Responses、Reranker=OpenRouter；ADR-0017 为准 | `rerankInputSize` 待定；数据分级门禁、预算账本和模型身份/留存治理未闭合 |
| PROBE-006 | PASS_WITH_ADJUSTMENT | [Chunking](probe-006-chunking-citation-locating.md) | `wide-1024`，不启用 parent-child | 5 份 ParseArtifact、6 题黄金子集、最小 kNN mapping；非完整混合检索或生产 ACL 链路基线 |

## PROBE-005 历史证据

下列文件保留供应商取舍和方法勘误证据，不是当前 MVP 基线：

- [`archive/probe-005-supplier-evaluations/`](archive/probe-005-supplier-evaluations/)：agentrouter 供应商不适配反证，以及 StepFun 候选、重复运行、A/B 与冷却实验；最终结论为不替换 fluxionai 基线。

每次新增或重跑探针时，先更新本索引的主结果、输入/环境指纹与适用边界，再写 `PROJECT_STATE.md`；历史证据只在结论被替代或需要解释选择过程时引用。

PROBE-001 至 PROBE-005 的现有 JSON 属统一指纹规则落地前的历史格式；不伪造缺失指纹。PROBE-006 已根据持久化输入和原报告环境字段回填指纹并注明依据，后续所有重跑由探针脚本在执行时直接生成。
