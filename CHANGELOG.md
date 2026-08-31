# Changelog

本项目所有显著变更记录在此。格式参考 Keep a Changelog，版本按票据批次推进。

## [Unreleased]

### Added

- **T1a Manifest/Prisma Core**：领域数据模型首份迁移——租户（`Tenant`）、知识空间
  （`KnowledgeSpace`）、不可变文档版本（`Document`/`DocumentVersion`）、内容寻址
  Manifest（`IngestionManifest`/`RetrievalManifest`/`AnswerManifest`/`PipelineManifest`）、
  索引分区（`IndexPartition`，ADR-0028）与 `ReleaseManifest`（ADR-0036 §4.2 字段口径）。
  迁移 SQL 见 `packages/database/prisma/migrations/`，由 `pnpm run bootstrap` 幂等应用。
- **T1a 契约**：`@rag/contracts` 新增 Manifest 内容契约、规范化 JSON + SHA-256
  contentHash、`compatibilityHashOf` 与兼容矩阵纯函数（Embedding→VectorIndex、
  Pipeline→Release、Ingestion→Release）；`RetrievalManifest.rerankInputSize` 为
  必填字段，开发种子显式写 64（PROBE-005）。
- **T1a API**：`POST /manifests/{ingestion,retrieval,answer}`、
  `POST /manifests/pipelines`（三要素兼容校验）、
  `POST /manifests/{*,pipelines}/:id/approve`、`POST /releases`、`GET /releases/:id`。
  领域命令式端点，不提供通用 PATCH status。
- **DX-T3**：统一 API 错误信封（`code/message/param/doc_url/trace_id` 五字段）与
  NestJS 全局异常过滤器；`trace_id` 优先复用请求头 `traceparent` 的 trace-id，
  缺失时服务端生成，INTERNAL_ERROR 的堆栈只进日志并带同一标识。错误码清单见
  [docs/engineering/error-codes.md](docs/engineering/error-codes.md)。
- **DX-T1**：README 黄金路径一键启动块；API/Worker 入口自动预载仓库根 `.env`
  （不覆盖已存在变量），新终端无需手工 `source .env`。
- **DX-T2**：环境预检脚本 `pnpm run preflight`（node/pnpm/uv/Docker daemon/Compose v2/.env
  缺项友好报错），已并入 `infra:up` 前置。

### Fixed

- **`pnpm --filter @rag/api dev` 下 NestJS 依赖注入失效**（T0 遗留，本批次实测发现）：
  开发入口原用 `tsx`（esbuild）转译，不产出 `emitDecoratorMetadata` 的
  `design:paramtypes`，进程照常启动、路由照常注册，但注入进来的依赖是 `undefined`，
  `/health/live`、`/health/ready` 及全部业务路由都返回 500。改为
  `node --watch -r ts-node/register/transpile-only src/main.ts`
  （ts-node 产出元数据；Node 22 原生 `--watch` 跟踪入口及其导入模块），并以
  `apps/api/test/dev-runtime.test.ts` 钉住这两项。
  编译产物（`pnpm --filter @rag/api start`）一直正常，只影响 dev 入口。

### 首次领域迁移说明

`packages/database/prisma/migrations/<timestamp>_t1a_core_domain/` 是仓库第一份
领域迁移。已有 T0 环境执行 `pnpm run bootstrap`（内部 `prisma migrate deploy`）
即可升级，幂等可重跑；全新环境按 README 黄金路径从零开始。回滚不在阶段 1
范围内——Manifest/Release 是追加式事实表，请勿手工删改。
