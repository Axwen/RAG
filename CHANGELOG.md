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
  `nodemon --watch src --ext ts --exec "node -r ts-node/register/transpile-only src/main.ts"`
  （ts-node 产出元数据；nodemon 按目录监听），并以
  `apps/api/test/dev-runtime.test.ts` 钉住这两项。
  编译产物（`pnpm --filter @rag/api start`）一直正常，只影响 dev 入口。
- **dev 热重载在第一次原子保存后失效**：曾短暂改用 `node --watch`，它在 Linux 上按
  解析后的文件路径注册 watcher，编辑器的原子保存（写临时文件 + rename）换掉 inode 后
  watcher 失效。实测 Node v22.23.1 连续 4 次原子保存只重启 1 次，之后旧进程继续服务
  已被改掉的代码（本批次曾因此在改完 `resolveTraceId` 后仍收到 `ReferenceError`）。
  `--watch-path` 只在 macOS/Windows 可用，故改回 nodemon 目录监听。
- **改 `packages/*` 后 dev 不重载**（上一条修复引入的回归）：`node --watch` 跟踪整个
  解析后的模块图，覆盖了四个工作区包的 `dist`，而 nodemon 的目录监听不会。dev 脚本
  现逐个写明 `packages/<name>/dist`——实测 nodemon 的 `--watch` 不支持 shell 通配符
  （`--watch '../../packages/*/dist'` 只启动一次、无重载，字面目录则正常），因此不能
  用一条通配符代替，并由 `dev-runtime.test.ts` 按 `packages/` 目录清单钉住。
- **鉴权类状态码会变成 500**：错误码表原先没有 `UNAUTHORIZED`/`FORBIDDEN`/
  `METHOD_NOT_ALLOWED`/`PAYLOAD_TOO_LARGE`/`UNSUPPORTED_MEDIA_TYPE`，过滤器的
  状态码映射也没有对应分支，T14 的 guard 抛出的 401/403 会落成 `INTERNAL_ERROR`：
  客户端拿到「服务端故障、请重试」而非「重新登录」，且每次鉴权拒绝都带堆栈按未处理
  异常写进错误日志。现在 `ERROR_STATUS` 是唯一事实源，反查表由它派生（附双射测试，
  两处不可能再各自漂移），未列入映射的 4xx 兜底为 `VALIDATION_ERROR` 而不是 500；
  带 `status` 的库层错误（如 body-parser 的畸形 JSON）按其状态码归一，`expose` 非
  true 时不外泄原文。
- **并发 approve 返回 500**：`approve()` 原为先读后写，两个并发请求都读到 DRAFT 时，
  后一个的 UPDATE 撞上 APPROVED 不可变触发器抛 `check_violation`——一条 Prisma 未映射
  的裸库错误。状态判定已下推为 `UPDATE ... WHERE status='DRAFT'`，受影响 0 行只可能是
  「已是 APPROVED」（id 不存在已由前置检查排除），按幂等返回既有行。
- **`checkPipelineToRelease` 是死代码**：`createRelease` 在查询里就过滤了
  `status='APPROVED'`，那条规则因此恒真，而开发者只会看到「没有已批准的兼容
  Pipeline」，看不到「存在但还是 DRAFT」。查询改为只按
  `(tenantId, ingestionManifestId)` 取候选，状态判定交回规则。
- **`ParseBackend` 被窄化为单个字面量**：`(typeof PARSE_BACKENDS)[0]` → `[number]`。
- **非对象向量通道触发 500**：`readVectorChannels` 原样断言元素形状，畸形
  `vectorPolicy.channels` 会抛 TypeError；现映射为具名兼容违例（422）。
- **种子的 contentHash 不可复现**：contentHash 覆盖 `parseBackend`，而
  IngestionManifest 的 create payload 依赖列默认值省略了它；已显式写入。
- **`prisma/seed.ts` 从不被类型检查**：它落在所有 tsconfig 的 `include` 之外，改一个
  契约字段名后 build 与 typecheck 全绿，而 `bootstrap` 里的 `db:seed` 在新克隆上运行时
  才炸。新增 `packages/database/tsconfig.seed.json`（`noEmit`）并接入该包的 `typecheck`。
- **`preflight` 误把 uv 当阻断项**：脚本判 `fail=1`，文案却说「可跳过」，而它已实际
  拦住 `pnpm run infra:up`；uv 降为警告并计入警告数。同时补 `.nvmrc` 存在性守卫——
  `set -Eeuo pipefail` 下缺文件会直接杀掉脚本。

### 首次领域迁移说明

`packages/database/prisma/migrations/<timestamp>_t1a_core_domain/` 是仓库第一份
领域迁移。已有 T0 环境执行 `pnpm run bootstrap`（内部 `prisma migrate deploy`）
即可升级，幂等可重跑；全新环境按 README 黄金路径从零开始。回滚不在阶段 1
范围内——Manifest/Release 是追加式事实表，请勿手工删改。
