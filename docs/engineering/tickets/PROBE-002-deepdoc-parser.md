# PROBE-002：RAGFlow DeepDOC Parser 探针

## 目的

验证固定 RAGFlow 快照包装为独立 Python Parser Service 后，能稳定输出 ParseArtifact，并满足扫描 PDF、双栏、跨页表格和 Markdown 的定位、质量、资源与恢复要求。

## 当前依据

- [ADR-0014](../../adr/0014-parser-service-around-ragflow-deepdoc.md)
- `references/ragflow/deepdoc/`
- 工程评审闭合记录第 7、15 节

## 输入与边界

- 固定 RAGFlow commit 和 Python 依赖锁定信息。
- 最小样本集：普通 Markdown、原生 PDF、扫描 PDF、双栏 PDF、跨页表格 PDF。
- Parser 并发 1，RSS 警戒 8 GiB；不启动正式 Worker 和索引链路。

## 必须验证

1. Parser Service 可重复构建、启动和健康检查。
2. 统一输入能返回 `parserTaskId`，状态查询能覆盖 QUEUED/RUNNING/COMPLETED/FAILED/CANCELED。
3. ParseArtifact 包含规范化内容、结构化块、页码/坐标定位、表格告警、版本和内容哈希。
4. 相同 `tenantId + contentHash + parserVersion` 幂等，不重复生成正式 Artifact。
5. 超时、取消、进程崩溃和响应丢失可恢复，不产生半成品 Artifact。
6. 记录启动耗时、解析耗时、RSS 峰值、CPU、定位成功率和表格告警率。

## 产出

- `probe-002-deepdoc-parser.md`
- `probe-002-deepdoc-parser.json`
- 固定版本和镜像构建记录。
- ParseArtifact 样例、质量报告和资源峰值报告。

## 通过标准

- `PASS`：首批格式契约稳定，资源不超过边界，失败恢复可验证。
- `PASS_WITH_ADJUSTMENT`：需要缩减首批格式、调整 RSS/超时或修订 Artifact 字段，但不改变 Parser Adapter 边界。
- `BLOCKED`：无法稳定产出定位证据、任务状态或原子 Artifact。

## 测试与回滚

- 使用 pytest/HTTP 契约测试和容器故障注入。
- 探针失败只删除 Parser 镜像、临时对象和输出，不修改 RAGFlow 参考快照。

## 第二轮执行记录（2026-08-26）

- 结果：**PASS**，报告见 [`probe-002-deepdoc-parser.md`](../probe-results/probe-002-deepdoc-parser.md)。
- 运行事实：固定 Parser 版本 `ragflow-deepdoc@618c4599/v0.27.0`，真实 `infinity-sdk==0.7.3` tokenizer，补齐 NLTK `punkt_tab`；健康检查返回 `tokenizer_mode=infinity`。
- 四类 PDF 的原文定位率均为 `1.0`；真实 tokenizer 运行峰值 RSS 为 `1111.7 MiB`，低于 12 GiB 临时容器上限，但整体资源结论仍按 PROBE-000 的 23.47 GiB profile 记录。
- Parser Service 的 `parserTaskId` 生命周期、取消、崩溃恢复和 PostgreSQL 幂等注册仍属于服务层集成测试范围，本轮只更新 DeepDOC 解析事实。
