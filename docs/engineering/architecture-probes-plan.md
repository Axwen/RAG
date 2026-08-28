# 架构探针阶段计划

> 状态：COMPLETED_WITH_INTEGRATION_FOLLOWUPS（六个架构探针外部事实已完成）
> 目标：在正式实现原候选任务 T1a/T1b、T2-T13 前验证六个最高风险外部事实。探针收尾后已补充 T0、T14-T16。
> 原则：探针是可丢弃的验证代码，不形成第二条产品主链。

环境门禁为 `PASS_WITH_ADJUSTMENT`。用户 WSL 终端已确认 Node.js、pnpm、Python、curl、jq、Docker CE CLI、Docker Engine、Compose 和 Socket 可用；Engine 可见 23.47 GiB，超过日常 22 GiB，略低于 Parser 建议 24 GiB（判定脚本：`scripts/probes/preflight.sh`）。六个探针均已执行；PROBE-002/006 的资源结论按 23.47 GiB profile 记录。

## 1. 结论

本文件记录探针阶段当时的计划；该阶段已经完成，当前正式开发范围与依赖顺序以 [阶段 1 实施 Tickets](stage1-implementation-tickets.md) 为准。

原计划将 T1a/T1b、T2-T13 建立在六个尚未实测的事实之上。该阶段现已完成：PROBE-001 至 PROBE-004 为 `PASS`，PROBE-005 与 PROBE-006 为 `PASS_WITH_ADJUSTMENT`。当前工作转为 T0 骨架、实现集成验证和治理收口；当前任务范围见 [阶段 1 实施 Tickets](stage1-implementation-tickets.md)，探针事实与实现条件见 [Probe Decision Gate](probe-decision-gate.md) 与 [探针结果索引](probe-results/README.md)。

## 2. 两阶段交付模型

```text
阶段 A：架构探针
  Probe-001 Keycloak
  Probe-002 DeepDOC
  Probe-003 OpenSearch
  Probe-004 RabbitMQ
  Probe-005 ModelAdapter
  Probe-006 Chunking
             │
             ▼
      Probe Decision Gate
  PASS / PASS_WITH_ADJUSTMENT / BLOCKED
             │
             ▼
阶段 B：正式实施
  更新 ADR / PROJECT_STATE / 设计方案
  探针收尾提交 -> T0 Monorepo 基线
  DX Review + 实现准备增量 plan-eng-review
  复核 T1a/T1b、T2-T16 的最终批次
  按依赖实现 Prisma Core、状态、消息、解析、检索、回答和删除；Chunk/Index Schema 使用 PROBE-006 冻结的 `wide-1024` 契约
```

当前已有的 T1a/T1b、T2-T13 是工程评审产生的“实施候选任务”；T0、T14-T16 和依赖顺序已在探针收尾后补齐，最终开发范围以 [阶段 1 实施 Tickets](stage1-implementation-tickets.md) 为准。PROBE-006 已完成真实小规模 Recall@5，T1b 不再等待探针重跑，但仍需关闭 Gate 中的完整混合检索和生产过滤集成条件。

## 3. 探针统一规则

### 3.1 运行边界

- 使用合成或严格脱敏样本；不得上传真实客户数据。
- 所有密钥只来自环境变量或本地未跟踪文件，不写入仓库、日志或报告。
- 默认使用 Docker Compose `core` Profile；Parser 和评测按需启动。
- WSL2 日常上限 22 GiB；DeepDOC 单独测试或批量测试才使用 24 GiB Profile。
- 探针只允许写入 `docs/engineering/probe-results/`、临时容器卷和本地日志目录。
- 每个探针必须能重复运行，输入、镜像/代码版本和配置必须形成指纹。

### 3.2 统一结果格式

每个探针产出一份 Markdown 报告和机器可读 JSON：

```yaml
probe_id: PROBE-001
status: PASS | PASS_WITH_ADJUSTMENT | BLOCKED
executed_at: 2026-08-24T00:00:00Z
environment_fingerprint: sha256:...
input_fingerprint: sha256:...
versions: {}
measurements: {}
failures: []
decisions_required: []
recommendation: ""
```

判定含义：

- `PASS`：当前设计和硬边界可以直接进入正式实现。
- `PASS_WITH_ADJUSTMENT`：外部能力可用，但必须先更新配置、ADR、Manifest 或 DoD，再进入实现。
- `BLOCKED`：关键契约不成立，不得通过增加临时旁路进入受影响的 T1a/T1b、T2-T16；必须更换 Adapter、调整范围或重新决策。

### 3.3 通过门

六个探针均达到 `PASS` 或 `PASS_WITH_ADJUSTMENT`，因此可以进入受约束的正式实施。`PASS_WITH_ADJUSTMENT` 的实现前置条件和服务层 SIMULATED 项必须按 [Probe Decision Gate](probe-decision-gate.md) 关闭；任一新探针为 `BLOCKED` 都暂停受影响边界的实现。

## 4. 执行顺序与并行化

```text
门禁：PROBE-000 环境（运行时 PASS，资源允许调整）
         │
         ▼
先启动：PROBE-001 Keycloak ─┐
         PROBE-002 DeepDOC  ─┼─ 建议串行，记录 23.47 GiB 资源峰值
         PROBE-003 OpenSearch┘

随后：PROBE-004 RabbitMQ
      PROBE-005 ModelAdapter
      PROBE-006 Chunking（依赖 PROBE-002 与 PROBE-003）

最后：Probe Decision Gate -> ADR/状态更新 -> 探针收尾提交 -> T0 -> 实现准备 plan-eng-review -> T1a/T1b、T2-T16
```

Keycloak、DeepDOC、OpenSearch 和 RabbitMQ 建议串行，避免中间件与 Parser 同时争用内存；ModelAdapter 按云模型预算单独执行。PROBE-006 复用 PROBE-002 的解析产物，因此 PROBE-002 未完成时它不具备输入。DeepDOC、批量 ModelAdapter 评测和 PROBE-006 的分块重建不得同时占用 23.47 GiB profile。

## 5. 探针完成后的正式 Plan

探针通过后生成或维护以下正式产物；前五项已经完成，第六项在 T0 后执行：

1. [探针结果索引](probe-results/README.md)与 [Probe Decision Gate](probe-decision-gate.md)：六个探针的主结果、历史证据、冻结结论和实现边界。
2. 必要的新增或修订 ADR：只记录实测导致的架构变更。
3. 更新 `PROJECT_STATE.md`：写入真实版本、资源、延迟、费用和调整后的硬边界。
4. 将 T0、T1a/T1b、T2-T16 拆成当前开发 Tickets：每张 Ticket 固定协议、依赖、测试和 DoD。
5. 冻结 PROBE-003 的 kNN 初始参数与 PROBE-006 的 `ChunkingManifest` 默认值；真实业务规模和完整过滤链回归仍作为实现 Gate。
6. T0 建立真实工具链后，对 `plan-eng-review-closure.md` 做一次实现准备增量复审：只检查探针与脚手架改变的假设，不重复完整评审。

最终开发顺序仍为：

```text
  T0 Monorepo 基线 -> DX Review + 实现准备增量工程复审
                 │
                 ▼
  T1a Manifest/Prisma Core + T14 Identity + T11 同步审计 + T12 Ledger 骨架
                 │
                 ▼
  T2 状态命令 + T10 Worker 基础 -> T3 RabbitMQ/Outbox
                 │
                 ▼
  T1b Chunk/Index Schema -> T15 ModelAdapter -> PROBE-007(VLM) -> T4a Parser/ObjectStorage -> T5 Release/OpenSearch
  （T4b VLM/混合解析后端随 ADR-0038 新增，可与 T5/T9 并行，前置为 PROBE-007 与 T15 准入层）
                 │
                 ▼
  T9 Harness/语料 -> T6 Retrieval/拍板 rerank N -> T7 Answer/Citation/Finalizer/SSE
                 │
                 ▼
  T8 Deletion/Replay -> T10/T11/T12 收口 -> T16 Web/Admin 纵向集成
```

T13 不可信内容与注入检测是横切项，随 T4a 解析扫描（T4b 将 VLM 输出接入同一检测链）、T6 候选进入上下文前检查和 T7 输出检查分别落地，不作为独立的最后阶段。T1a 不编码父子 Chunk 关系和最终 Chunk 字段；PROBE-006 已冻结 `ChunkingManifest`，因此 T1b、T5、T6 可进入实现准备，但必须通过 [Probe Decision Gate](probe-decision-gate.md) 中的真实业务回归与集成门槛。
