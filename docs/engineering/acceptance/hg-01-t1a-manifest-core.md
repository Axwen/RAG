# HG-01（T1a 切片）：Manifest/Prisma Core + devex P1 人工验收

- 状态：READY_FOR_HUMAN
- 提交验收日期：2026-08-28
- 用户结论日期：待定

> HG-01 的完整范围是 T1a + T14 + T11(同步审计) + T12(Ledger 骨架)。本记录只覆盖
> 其中的 T1a 切片与并入的 devex P1 三项，按用户要求先行提交核验；T14/T11/T12 未开始。

## 1. 范围与结果

已完成：

- **T1a 领域模型与首份迁移**：`Tenant`、`KnowledgeSpace`、`Document`、`DocumentVersion`、
  `IngestionManifest`、`RetrievalManifest`、`AnswerManifest`、`PipelineManifest`、
  `IndexPartition`、`ReleaseManifest` 共 10 个模型 + 3 个枚举；除 `Tenant` 外全部带
  `tenantId`（§4.1 最高隔离域），Manifest 与 `DocumentVersion` 带 `(tenantId, contentHash)`
  唯一约束。迁移 `20260828104247_t1a_core_domain` 已在本地 PostgreSQL 应用。
- **内容寻址与兼容矩阵契约**（`@rag/contracts`）：规范化 JSON（递归键排序）+ SHA-256
  `contentHash`、`compatibilityHashOf`，以及四条纯函数校验（Pipeline 三要素、
  Embedding→VectorIndex、Pipeline→Release、Ingestion→Release，§4.3）。
- **T1a API**：`POST /manifests/{ingestion,retrieval,answer}`（201）、
  `POST /manifests/pipelines`（201，先做三要素兼容校验）、
  `POST /manifests/{ingestion,retrieval,answer,pipelines}/:id/approve`（200）、
  `POST /releases`（201）、`GET /releases/:id`。只有领域命令，没有通用 PATCH status。
- **DX-T1**：`preloadRootEnv()` 预载仓库根 `.env`（不覆盖已存在变量），API/Worker 入口
  各调用一次；新终端不再需要手工 `source .env`。README 黄金路径块同步更新。
- **DX-T2**：`pnpm run preflight`（`scripts/check-env.sh`）逐项检查 node/pnpm/uv/Docker
  daemon/Compose v2/`.env` 并给修复指引，已并入 `infra:up` 前置。
- **DX-T3**：五字段错误信封 + 全局异常过滤器 + [错误码文档](../error-codes.md)。
- **P2 顺带项**：`CHANGELOG.md`、`docs/engineering/error-codes.md`。

不在本切片范围：T14 身份与授权（`tenantId` 暂由请求体携带）、T11 同步审计、
T12 预算 Ledger 骨架、T1b 分块、Release 状态迁移（`BUILDING` 及之后属 T5）、
任何产品 UI。

**本批次无新增产品 UI**：`apps/web` 未改动，用户可见界面仍是 T0 的健康页。
产品 UI 从 T16a 起出现。以下第 2 节用真实 HTTP 调用替代界面演示。

## 2. UI / API / CLI 操作说明

从零到可用（全新终端，未手工 `source .env`）：

```bash
pnpm install --frozen-lockfile
cp .env.example .env      # 首次
pnpm run infra:up         # 含 preflight
pnpm run bootstrap        # Keycloak realm + MinIO bucket + 迁移 + 种子
pnpm --filter @rag/api dev
```

实测结果（2026-08-28，本机 WSL2）：

| 调用 | 结果 |
|---|---|
| `GET /health/ready` | 200，postgres/opensearch/rabbitmq/redis/minio/keycloak 六项全 `up` |
| `POST /releases`（种子 Ingestion + 种子分区） | 201，`status=CREATED`，`indexSchemaVersion`/`embeddingVersion` 取自分区 |
| 同 body 重放 `POST /releases` | 201 且 `id` 与首次相同（按 `(tenantId, contentHash)` 幂等） |
| `POST /manifests/pipelines`（种子三要素） | 201 且返回种子 pipeline `018f…0033`——证明种子与服务端 contentHash 口径一致 |
| `POST /manifests/ingestion` + `/approve` | 201 / 200，`status` DRAFT→APPROVED，`approvedAt` 落库 |
| `POST /releases`（Ingestion `embeddingRef=bge-m3@2.0.0` vs 分区 `@1.0.0`） | 422 `COMPATIBILITY_VIOLATION`，message 指出两侧具体版本 |
| `POST /manifests/retrieval`（`candidateBudget=2048`） | 400 `VALIDATION_ERROR`，`param=candidateBudget` |
| `GET /releases/<不存在>` | 404 `NOT_FOUND`，`param=id` |
| 未定义路由 | 404 信封（不是 Nest 默认 HTML/JSON） |
| 带 `traceparent` 的错误请求 | `trace_id` 复用其 trace-id；无该头时服务端生成 UUID |

## 3. 代码导览

跟踪文件 20 个（+755/−66），新增未跟踪文件 28 个（约 2797 行）。按阅读顺序：

| 位置 | 作用 |
|---|---|
| `packages/database/prisma/schema.prisma` | 10 模型 + 3 枚举；`datasource` 无 `url`，连接串只经运行时环境 |
| `packages/database/prisma/migrations/20260828104247_t1a_core_domain/` | 仓库首份领域迁移 SQL |
| `packages/database/prisma/seed.ts` | 开发种子：固定 UUID upsert，可重复执行 |
| `packages/database/src/client.ts` | `@prisma/adapter-pg` 建连（`DATABASE_URL`） |
| `packages/contracts/src/manifests/content.ts` | 四类 Manifest 内容契约（zod） |
| `packages/contracts/src/manifests/hash.ts` | 规范化 JSON（递归键排序）+ SHA-256 `contentHash`、`compatibilityHashOf` |
| `packages/contracts/src/manifests/compatibility.ts` | 四条兼容矩阵纯函数（§4.3） |
| `packages/contracts/src/errors.ts` | 错误码枚举与五字段信封类型 |
| `apps/api/src/manifests/manifests.{controller,service,schemas}.ts` | 领域命令端点 / 幂等写入与兼容校验 / 入参 schema |
| `apps/api/src/common/{api-error.exception,global-exception.filter}.ts` | 领域错误抛出点与全局信封化（DX-T3） |
| `apps/api/src/database/prisma.{module,service}.ts` | Prisma 生命周期接入 Nest DI |
| `packages/config/src/env-preload.ts` | `preloadRootEnv()`（DX-T1） |
| `scripts/check-env.sh` | `pnpm run preflight`（DX-T2） |

关键设计点，供核验时重点看：

- **领域命令而非通用写接口**：`approve` 是独立端点，没有 `PATCH /manifests/:id {status}`，
  状态机不能被任意 body 绕过；`createRelease` 完全不写 `status`，初始态 `CREATED`
  由数据库默认值提供。
- **幂等按内容寻址**：写入撞 `(tenantId, contentHash)` 唯一约束（P2002）时返回既有行，
  不是新建也不是报错。重放同一份 body 拿到同一个 `id`。
- **兼容校验前置于落库**：`POST /manifests/pipelines` 与 `POST /releases` 先跑纯函数矩阵，
  不通过则 422，不产生半成品行。
- **错误信封不外泄内部信息**：`INTERNAL_ERROR` 的堆栈只进日志，日志行与响应体共享
  同一 `trace_id`；`trace_id` 只接受 W3C `traceparent`（严格校验 32 位小写十六进制），
  不回显任何其他客户端自定义头。

## 4. 自动化与真实环境验证

自动化（`pnpm run verify` = typecheck + lint + test + format:check）：

```
EXIT=0    Test Files 15 passed (15)    Tests 106 passed (106)
```

新增测试覆盖：contentHash 规范化与稳定性、四条兼容矩阵、错误信封与全局过滤器
（含 `traceparent` 复用与非法值回退）、Manifest 服务的幂等与版本派生、`preloadRootEnv`
不覆盖既有变量、schema 边界（无 `url =`、无内联凭证、`rerankInputSize` 必填）。

真实环境（本机 WSL2，全新终端）：

1. `pnpm run infra:up` — preflight 六项通过，6 个容器 healthy。
2. `pnpm run bootstrap` — Keycloak realm / MinIO bucket 幂等；`prisma migrate deploy`
   报 No pending migrations；T1a 种子写入成功。
3. `pnpm --filter @rag/api dev` — `/health/live` 200、`/health/ready` 200 六项全 `up`，
   全程未手工 `source .env`。
4. 第 2 节表格中的全部 HTTP 调用逐条实测通过。

**本批次实测发现并修复的 T0 遗留缺陷**：`pnpm --filter @rag/api dev` 原用 `tsx`
（esbuild）转译，不产出 `emitDecoratorMetadata` 的 `design:paramtypes`，NestJS 注入
进来的依赖是 `undefined`——进程照常启动、路由照常注册，但所有请求 500。单测直接
`new` 服务、绕过 DI，抓不到这类回归。已改为
`node --watch -r ts-node/register/transpile-only src/main.ts`
（Node 22 原生 `--watch` 跟踪入口及其导入模块），
并以 `apps/api/test/dev-runtime.test.ts` 钉住转译器与监听方式。编译产物
（`pnpm --filter @rag/api start`）一直正常，只影响 dev 入口。

## 5. 已知风险与遗留

- **幂等重放仍返回 201**：语义上更贴切的是 200，但需要 `@Res()` 或拦截器改写状态码，
  T1a 不做。响应体的 `id` 已足以判别是否新建。
- **`tenantId` 由请求体携带**：T14 身份与授权落地前，任何调用方都能声明任意租户。
  当前只在本地开发环境使用，未对外暴露；T14 改为服务端身份上下文注入，契约不变。
- **本机开发库有验收残留行**：一条额外 Release 与一条 ingestion v2
  （`embeddingRef=bge-m3@2.0.0`，APPROVED，`01a04822-6c60-750e-9325-1f20b8b050dc`）。
  对开发无影响，种子仍幂等；需要干净库时重建 volume 即可。
- **`rerankInputSize` 目前只有种子值 64**（PROBE-005）：真实取值待 T6 检索链路实测标定。
- **CI 首次真实运行需要 git remote**：工作流已就位，但仓库尚无远端，需用户操作。
- **回滚不在阶段 1 范围**：Manifest/Release 是追加式事实表，请勿手工删改。

## 6. 用户验收结论

- 结论：待用户填写（通过 / 有条件通过 / 不通过）
- 意见：

> 按 [人工验收闸门](../manual-acceptance-gate.md)，人工验收与 Git/发布授权相互独立：
> 验收通过不自动授权 commit、push、PR、merge 或部署。本批次改动尚未提交。
