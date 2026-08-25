# 架构探针阶段计划

> 状态：BLOCKED_ENVIRONMENT（等待 PROBE-000 通过后转为 READY_TO_RUN）  
> 目标：在正式实现 T1a/T1b、T2-T13 前验证六个最高风险外部事实。  
> 原则：探针是可丢弃的验证代码，不形成第二条产品主链。

当前环境门禁：`BLOCKED_ENVIRONMENT`。Node.js、pnpm、Python、curl、jq、Docker CE CLI 和 Docker Compose 已通过；当前 Codex 执行环境访问 `/var/run/docker.sock` 被拒绝，沙箱外执行审批服务返回 503（判定脚本：`scripts/probes/preflight.sh`）。先完成 [PROBE-000 环境门禁](tickets/PROBE-000-environment.md)，再执行 PROBE-001 至 PROBE-006。PROBE-000 是门禁而不是架构假设验证，不计入六个探针，但它 `BLOCKED` 时其余探针一律不启动。

## 1. 结论

现在就应该出 Plan 和 Tickets，但当前先出的不是最终业务开发计划，而是“架构探针计划 + 探针 Tickets”。

原因：T1a/T1b、T2-T13 依赖六个尚未实测的事实：Keycloak 的撤权行为、DeepDOC 的资源和定位质量、OpenSearch 的 Alias/作用域过滤/kNN 参数与查询预算、RabbitMQ 的重试与重放语义、百炼 ModelAdapter 的真实延迟和错误映射、分块参数对 Recall@5 与引用可定位率的影响。如果直接把这些假设写成最终开发票据，探针失败后会反复改 Prisma、队列和模块边界。

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
  plan-eng-review 轻量复审
  将 T1a/T1b、T2-T13 冻结为最终开发 Tickets
  按依赖实现 Prisma Core、状态、消息、解析、检索、回答和删除；Chunk/Index Schema 等待 PROBE-006
```

当前已有的 T1a/T1b、T2-T13 是工程评审产生的“实施候选任务”，不是探针完成前的最终开发票据。

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
- `BLOCKED`：关键契约不成立，不得通过增加临时旁路进入 T1a/T1b、T2-T13；必须更换 Adapter、调整范围或重新决策。

### 3.3 通过门

六个探针全部达到 `PASS` 或 `PASS_WITH_ADJUSTMENT` 后才进入正式实施门。任一 `BLOCKED` 都暂停大规模业务实现，仅允许修复探针或重新评审受影响边界。

## 4. 执行顺序与并行化

```text
门禁：PROBE-000 环境（必须先 PASS）
         │
         ▼
先启动：PROBE-001 Keycloak ─┐
         PROBE-002 DeepDOC  ─┼─ 可并行，资源上限不同
         PROBE-003 OpenSearch┘

随后：PROBE-004 RabbitMQ
      PROBE-005 ModelAdapter
      PROBE-006 Chunking（依赖 PROBE-002 与 PROBE-003）

最后：Probe Decision Gate -> ADR/状态更新 -> plan-eng-review 复审 -> T1a/T1b、T2-T13
```

Keycloak、DeepDOC、OpenSearch 可以分别使用独立容器和端口并行；RabbitMQ、ModelAdapter 和 Chunking 可以在前三个完成后并行。DeepDOC、批量 ModelAdapter 评测和 PROBE-006 的分块重建不得同时占用 24 GiB profile。PROBE-006 复用 PROBE-002 的解析产物，因此 PROBE-002 `BLOCKED` 时 PROBE-006 不具备输入。

## 5. 探针完成后的正式 Plan

探针通过后生成以下正式产物：

1. `docs/engineering/architecture-probe-results-YYYYMMDD.md`：六个探针的汇总和差异。
2. 必要的新增或修订 ADR：只记录实测导致的架构变更。
3. 更新 `PROJECT_STATE.md`：写入真实版本、资源、延迟、费用和调整后的硬边界。
4. 对 `plan-eng-review-closure.md` 做一次增量复审：只检查探针改变的假设，不重新重复完整评审。
5. 将 T1a/T1b、T2-T13 拆成最终开发 Tickets：每张 Ticket 固定文件范围、协议字段、依赖、测试、回滚和 DoD。
6. 冻结 PROBE-003 的 kNN 参数与 PROBE-006 的 `ChunkingManifest` 默认值，写入 Index Schema 与 `IngestionManifest`。

最终开发顺序仍为：

```text
T1a Manifest/Prisma Core + T2 状态命令
                 │
                 ▼
T3 RabbitMQ/Outbox + T4 Parser/ObjectStorage
                 │
                 ▼
T1b Chunk/Index Schema + T5 Release/OpenSearch + T6 RetrievalSnapshot/ACL 检索
                 │
                 ▼
T7 Answer/Citation/Finalizer/SSE
                 │
                 ▼
T8 Deletion/Replay -> T9 Evaluation -> T10/T11/T12 门禁与运维
```

T13 不可信内容与注入检测是横切项，随 T4 解析扫描、T6 候选进入上下文前检查和 T7 输出检查分别落地，不作为独立的最后阶段。T1a 不编码父子 Chunk 关系和最终 Chunk 字段；T1b、T5、T6 的正式索引实现必须等待 PROBE-006 冻结 `ChunkingManifest`。
