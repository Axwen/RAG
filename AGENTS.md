# AGENTS.md — 交给任何 AI Agent 之前请先读完这一页

这份文件是**唯一入口**。它不重复设计文档，只写「不知道就会返工或让 CI 变红」的那部分。
读完约 5 分钟，能省掉一整轮 PR 往返。

## 0. 这是什么

企业级可信 RAG 基础 MVP，不是「向量化文档 + 聊天」的 Demo。共享基座 + 客服单一纵向闭环，
正式覆盖身份、权限、不可变文档版本、异步解析与索引、版本化 Release、混合检索、句级引用、
删除、恢复、审计和评测。

pnpm monorepo（Node ≥ 22.23.1，pnpm 10.34.5，锁定版本）+ 一个 Python 子服务
（`services/parser`，uv 管理，Python 3.12）。

## 1. 事实源层级（冲突时按这个顺序裁决）

```
PROJECT_STATE.md          ← 当前进度与全局不变量，先读它
  > docs/adr/NNNN-*.md    ← 已批准的架构决策，改它必须新增 ADR 并显式 supersede
  > docs/engineering/tickets/T*.md   ← 实施票据，怎么做
  > docs/engineering/acceptance/*.md ← 人工验收记录，用户的原话
```

`docs/engineering/plan-eng-review-closure.md`（工程评审闭合记录）**低于 ADR**：ADR 可以细化
它的某一行，反过来不行。

不要动 `docs/engineering/tasks-eng-review-20260824.jsonl`——那是设计复审前的旧快照，
不是当前任务清单。当前范围看
[`docs/engineering/stage1-implementation-tickets.md`](docs/engineering/stage1-implementation-tickets.md)。

## 2. 会让 CI 变红的九条硬纪律

main 上有 **6 条 required checks**，全绿才能合。逐条对应本地命令见第 3 节。

1. **不能直推 main。** 开分支 → PR。分支名用 `feat/…`、`fix/…`、`docs/…`、`chore/…`。
2. **提交信息必须是 Conventional Commits。** `<type>[(scope)][!]: <subject>`，
   type ∈ `feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert`，
   主题行 ≤ 72 字符（**CJK 按显示宽度算 2**）。校验器是 `scripts/check-commits.sh`，
   本地与 CI 同一份，不装 commitlint。
3. **增量覆盖率棘轮 80%。** `scripts/check-diff-coverage.sh` 的 `MIN=80`：**本次 diff 新增的
   每一行 `.ts`/`.tsx` 里，被插桩的部分必须 80% 被测试覆盖**。全局阈值（`vitest.config.ts`
   的 86/81/82/87）拦不住「这次新增的没测」，所以有这条独立门禁。写新代码就写测试，
   否则 `quality` job 必红。
4. **Markdown 链接必须可解析，包括 `#anchor`。** `scripts/check-links.sh` 扫全仓 112+ 个
   文件。**新建一个票据/ADR 文件而不挂链接，等于孤儿文件**——见第 5 节的挂链规则。
5. **密钥零容忍。** `.env`、`.env.*`、`*.env` 已 gitignore（`!.env.example` 例外）。真实密码
   和模型 API key 永不进库；数据库连接串只从运行时环境或未跟踪的 `.env` 来，
   **不写进代码、不写进 `schema.prisma`**。`gitleaks` 扫全历史，一旦进过历史就洗不掉。
6. **CI 不读仓库 secrets，也不触发付费模型调用。** LIVE 供应商调用只在本地手工探针里跑。
7. **迁移单独提交、单独评审。** `packages/database/prisma/migrations/` 的新增迁移不与业务
   代码混在一个提交里（T1a 定的口径，T11/T12/T14 三张票据都复述了）。
8. **错误信封不泄漏内部信息。** `INTERNAL_ERROR` 不带 stack trace、不带供应商原文，
   细节只进日志并用同一个 `trace_id` 串起来。`trace_id` 只接受严格校验过的 W3C
   `traceparent`，不回显任意客户端头。
9. **`ERROR_STATUS` 是双射**（`packages/contracts/src/errors.ts`）：一个错误码占一个 HTTP
   状态码。**新增一个映射到已被占用状态码的错误码会打破双射**，要复用已有码 + `doc_url` 区分。

## 3. 本地验证（提 PR 前跑这些）

一条命令跑全部：

```bash
pnpm run verify
```

它串起 `format`(prettier --check) → `lint` → `check:shell` → `check:workflows` →
`check:secrets` → `check:links` → `typecheck` → `test` → `build` → `db:validate` →
`py:sync` → `py:test` → `compose:config`。

分开跑时的对应关系：

| 本地命令 | 对应的 required check |
|---|---|
| `pnpm run lint` `typecheck` `test` `build` `db:validate` | `node（lint / typecheck / test / prisma / build）` |
| `check:shell` `check:workflows` `check:links` `check:commits` `check:diff-coverage` | `quality（shell / YAML / 链接 / 提交信息 / 覆盖率）` |
| `pnpm run py:sync` `py:test` | `python（parser uv / pytest）` |
| `pnpm run compose:config` `check:parser-image` | `compose（配置解析 / parser 镜像构建与启动）` |
| `pnpm run infra:up` `bootstrap` `smoke:api` | `smoke（六容器 + bootstrap + 进程级 HTTP/日志断言）` |
| `pnpm run check:secrets` | `gitleaks（全历史密钥扫描）` |

两个已知的本地限制，不是你的错：

- `check:workflows --strict` 要下载钉死版本的 actionlint 二进制，网络受限时跑不了，CI 会跑。
- `check:secrets` 需要本机装了 gitleaks；没装就跳过，靠 CI 兜。

起本地环境：`pnpm run preflight`（环境预检）→ `pnpm run infra:up` → `pnpm run bootstrap`。
Parser 与 evaluation 是**按需 Compose Profile**，默认不启动（`infra:up:parser` /
`infra:up:evaluation`）。

## 4. 代码约定

**Prisma（新建表必须照抄）**

```prisma
model SomeThing {
  id        String   @id @default(uuid(7)) @db.Uuid
  tenantId  String   @db.Uuid
  createdAt DateTime @default(now()) @db.Timestamptz(6)

  @@unique([tenantId, id])   // 让租户级外键能用 references: [tenantId, id]，把租户谓词焊进外键
  @@map("some_thing")
}
```

枚举写在文件顶部，并在注释里注明它出自哪个 ADR。现成的两个迁移可以照抄目录与命名：
`20260828104247_t1a_core_domain`、`20260828130000_manifest_immutability`。

**包边界（ADR-0040 定的，不是风格偏好）**

- `packages/contracts/` — 类型、错误码、审计原因码注册表。不含实现。
- `packages/database/` — Prisma + 事务入口。**领域审计的写入口只在这里**。
- `packages/observability/` — 结构化日志、指标、Trace。**不得导出审计写入口**。
- `packages/config/` — 启动时解析并 fail-fast 的配置。运行时不从环境变量热改。

审计与遥测这条分界要用依赖断言或 lint 规则钉住——它会在某次「顺手复用一下 logger」里
悄悄消失。

## 5. 新增文档的挂链规则

**新建一个票据或 ADR 文件而不挂链接，`check:links` 不会报错，但那个文件是孤儿——
下一个人读不到它。** 所以：

- 新 ADR：在 [`docs/adr/README.md`](docs/adr/README.md) 末尾追加一行索引。
- 新票据：① 在
  [`docs/engineering/stage1-implementation-tickets.md`](docs/engineering/stage1-implementation-tickets.md)
  的 Ticket 地图表里把 T 号改成链接；② 在
  [`docs/engineering/plan-eng-review-closure.md`](docs/engineering/plan-eng-review-closure.md)
  第 16 节该票据条目下加一条「范围补充：」，正文是一个指向 `tickets/Txx-….md` 的 Markdown
  链接，**位置在「计划文件」之后、「验证」之前**（T0/T12/T14/T15/T16 都是这个位置）。
- 批次（a/b）**不新建文件**：写在同一个票据的 `## 批次划分` 一节里，锚点是
  `tickets/Txx-….md#批次划分`。

## 6. 人工验收门禁 ≠ Git 授权

两件事互相独立，不要混：

- [`docs/engineering/manual-acceptance-gate.md`](docs/engineering/manual-acceptance-gate.md)
  的 HG-0x 门禁是**用户对功能的验收**。自动化测试全绿只代表可以「提交人工验收」，
  不代表验收通过。用户没明确给 `ACCEPTED` 或 `ACCEPTED_WITH_ACTIONS` 之前，下一批次保持暂停。
- **验收通过不等于授权 commit / push / merge / 部署。** merge 和对外发布（GHCR 包、
  GitHub Release）始终是用户的动作。
- 临时门禁也要登记进那张表并带 `（临时）` 标记，只写在 `PROJECT_STATE.md` 里等于没写。

## 7. 明确挂起的事（不要主动提议）

- **不打 `v*` 版本标签、不发版**（用户 2026-09-03 决定）。`.github/workflows/release.yml`
  145 行、0 次运行，首次验证无限期挂起。`CHANGELOG.md` 只有 `## [Unreleased]` 小节
  **是正常状态**，不是缺口。详见 `docs/engineering/ci-cd.md` 第 6.4 节末尾。
- 阶段 1 `parent_child=false`，不实现父子字段或父子展开。
- 审计外发 SIEM、防篡改哈希链、租户自助审计检索：ADR-0040 已列为扩展点，阶段 1 不实现。

## 8. 现在做到哪了

看 [`PROJECT_STATE.md`](PROJECT_STATE.md) 的「当前状态」段是权威口径。截至 2026-09-03：

- T0 Monorepo 基线、T1a Manifest/Prisma Core 已验收（T1a 是 `ACCEPTED_WITH_ACTIONS`）。
- **HG-01 门禁未通过**，还差 T12a（预算账本与配置骨架）、T11a（同步审计骨架）、
  T14a/T14b（身份与授权），四项代码均未开始，前置文档已补齐。
- 顺序：T12a → T11a → T14a → HG-01a（临时门禁）→ T14b → HG-01。
- `packages/database/src` 现在只有 `client.ts`/`index.ts`/`env.ts`/`health.ts`——
  **没有 repository 或 service 层的先例**。所以两个白地入口的签名已经在票据里定死，
  照签名实现，不要自创形状：
  - 预算五条事务入口 → [T12 票据·事务入口契约](docs/engineering/tickets/T12-performance-budget.md#事务入口契约)
    （T15 每次模型调用都建在它上面），预扣估值的单价与汇率见同一票据的
    [预扣估值价格表与汇率](docs/engineering/tickets/T12-performance-budget.md#预扣估值价格表与汇率)，
    标注为初始值可校准。
  - 唯一的审计写入口 → [T11 票据·审计写入口契约](docs/engineering/tickets/T11-audit-telemetry.md#审计写入口契约)
    （预算四类审计、授权决策、注入命中都调它，且必须与业务写在同一个 `tx` 上）。
