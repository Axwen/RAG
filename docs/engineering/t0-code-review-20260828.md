# T0 代码评审报告(双轴:标准 / 规格)

- **日期**:2026-08-28
- **评审对象**:`feat/t0-monorepo-foundation` 分支上全部未提交工作区改动(修改的 `.gitignore`、`PROJECT_STATE.md` + 全部未跟踪脚手架文件)vs `main`(`5ac28bb`,分支上无提交)
- **规格来源**:[T0-monorepo-foundation.md](tickets/T0-monorepo-foundation.md)
- **标准来源**:仓库 ADR(docs/adr/)、根 README、票据"已冻结决策"一节。仓库无 `CONTRIBUTING.md`/`CODING_STANDARDS.md`;`docs/agents/issue-tracker.md` 不存在,票据追踪器即本地 `docs/engineering/tickets/` 目录
- **评审方式**:两轴并行独立评审(标准轴 + 规格轴),关键发现已逐条对照源文件复核

## 总体结论

T0 工程骨架在工具链、版本冻结和范围边界上忠实于票据要求——但存在一个直接影响开发入口的问题(`pnpm up` / `pnpm init` 与 pnpm 内置命令冲突,README 里的快速开始命令实际会执行错误操作),以及两个大概率永远无法变为 healthy 的 Compose 健康检查。后者尤其关键:[PROJECT_STATE.md](../../PROJECT_STATE.md) 显示下一步就是真实环境验收,这两个问题会在那时立刻暴露。

> 注：以上为修复前的评审结论，作为问题证据保留；本轮逐项复核、修复后的状态和验证结果见文末“复核与修复结果”。

## 标准轴(Standards)

### 硬性违规(有明文标准)

1. **README 开发入口命令与 pnpm 内置命令冲突** — ✅已复核。`package.json:25` 定义了脚本 `up`,`package.json:31` 定义了 `init`,而 `README.md` 文档写的是 `pnpm up` / `pnpm init`。`up` 是 pnpm `update` 的官方别名,`init` 是内置命令;pnpm 只在脚本名不与真实命令冲突时才允许省略 `run`。所以 `pnpm up` 会执行依赖更新(重写锁文件——违背 README 自己和 `.npmrc` 的冻结纪律),`pnpm init` 会重新生成 `package.json`,而不是启动 Compose / 执行幂等初始化。修复:改名(`infra:up`、`bootstrap`)或在文档中写 `pnpm run up`。同组命令(`up:parser`、`down`、`reset`)不受影响。

### 判断性意见(代码异味基线;仓库明文标准优先)

- **重复代码** — URL 尾斜杠去除 `replace(/\/+$/, '')` 出现三次:`packages/config/src/dependency-endpoints.ts:47`、`apps/api/src/health/health.service.ts:34`、`apps/web/src/app/api/health/route.ts:15`。应提取为 `@rag/config` 里的一个工具函数。
- **重复代码** — `apps/web/tsconfig.json:6-15` 重新声明了 strict 配置块,而不是 `extends: ../../tsconfig.base.json`,副本会与基础配置漂移。
- **冻结决策被削弱** — `tsconfig.test.json:14-15` 设置 `strictPropertyInitialization: false`;票据冻结的是"TypeScript 开启 strict"。仅限测试编译,但这一放宽未在任何地方记录。
- **重复代码** — `infra/compose/init/init-minio.sh` 中完全相同的 `docker run --rm --network … -e MC_HOST_local=…` 调用出现两次;`mc()` 辅助函数应放进 `lib.sh`。
- **凭证复用** — `init-keycloak.sh:14` 将 `DEV_USER_PASSWORD` 默认为 `KEYCLOAK_ADMIN_PASSWORD`;仅限本地,但属于不良的凭证共享示范。
- **无效配置** — ✅已复核 `.gitignore:44` 添加了 `.turbo/`,而冻结决策明确不引入 Turborepo;`/infra/compose/.data/` 也未使用(Compose 用的是命名卷)。
- **命名费解** — `apps/api/src/health/health.service.ts:29` 的 `const e = this.endpoints`。
- **环境变量校验不一致** — `apps/api/src/main.ts:12` 的 `Number(process.env.API_PORT ?? 3001)` 未校验(`NaN` 可通过),而 `loadDependencyEndpoints()` 用了 zod 校验。
- 小问题:`packages/config` 和 `packages/contracts` 缺少其他兄弟包都声明的 `"type": "commonjs"`。(对 `parseResourceLimits` 的"投机通用性"异味已被否决——票据明确只要求建立资源配置 schema。)

### 合规项

全部 7 个镜像显式固定标签且记录选择依据、无 `latest`;使用 `migrate dev`/`migrate deploy`、无 `db push`;`.env.example` 只有占位符;`packageManager`/`engines`/`.nvmrc` 一致(pnpm 10.34.5、Node 22.23.1);两份锁文件齐全;CONTEXT.md 术语使用一致;ADR-0010/0013/0016/0024 的边界在代码结构和注释中得到遵守。

## 规格轴(Spec)

### 已验证无误

各处版本一致(pnpm/Node/uv 0.12.5/Python 3.12.3 贯穿 `package.json`、`.nvmrc`、Parser Dockerfile、CI);探针冻结镜像版本精确复用;新增镜像固定标签并记录依据、无 `latest`;parser/evaluation 使用显式 profile;无固定 `container_name`;`.env.example` 只有无效占位符;无领域 schema/Outbox/业务协议代码。

### (a) 缺失 / 部分实现

1. **开发种子未实现** — 范围第 5 条:"初始化:可重复导入 Keycloak Realm、创建本地 MinIO Bucket、应用数据库迁移并**写入最小开发种子数据**";验收:"数据库迁移与开发种子可以重复执行"。✅已复核 `infra/compose/init/init-database.sh:27` 仅记录"种子为空"——脚本头部明确声明这是 T0 的显式状态、且为 T1a 预留了 `--if-present` 种子钩子,但字面验收标准未满足;该偏离应记录到票据或 PROJECT_STATE,而不是只写在脚本注释里。
2. **仓库无迁移 SQL** — 冻结决策:"迁移 SQL 进入版本库"。`packages/database/prisma/migrations/` 不存在。因 T0 无领域模型,可以勉强辩护,但确实没有任何迁移被版本化。
3. **资源配置 schema 不完整** — ✅已复核:票据资源边界写明 "Parser 并发 1/RSS 警戒 8 GiB" 和 22 GiB 日常 / 24 GiB 显式 profile;`packages/config/src/resource-limits.ts` 只覆盖 worker/预算/检索——无 parser 并发/RSS 字段,整个新目录树中也搜不到 "22 GiB"/"24 GiB"。

### (b) 超出范围(scope creep)

1. `infra/compose/keycloak/realm-rag-local.json:10-15` 出现领域色彩的 RBAC 角色(`knowledge-viewer/editor/reviewer`、`platform-admin`)——属 T14 范围;T0 只要求 Realm *导入*。
2. 日志脱敏内容/密钥字段(`packages/observability/src/redaction.ts`)——ADR-0032 的特性,未被要求。
3. 预算台账与 OpenSearch 检索预算 schema(`packages/config/src/resource-limits.ts:30-43`)超出票据点名的 worker/parser 边界(仅配置层,属边缘情况)。
4. `.env.example:66-76` 的云模型供应商/模型变量——T0 不调用任何模型。

### (c) 已实现但实现方式疑似错误

1. **MinIO 健康检查** — ✅已复核 `infra/compose/compose.yml:124` 对 `RELEASE.2025-09-07T16-13-09Z` 镜像使用 `curl`;2025 年的 MinIO 镜像已移除 `curl`(官方推荐 `["CMD","mc","ready","local"]`)。风险:minio 永远无法 healthy → 违背"六个 core 中间件能达到 healthy"。
2. **Keycloak 健康检查** — ✅已复核 `infra/compose/compose.yml:150` 用 grep 匹配 `'"status": "UP"'`(冒号带空格);SmallRye/Quarkus 健康端点输出的是紧凑 JSON `{"status":"UP"}`——该 grep 可能永远匹配不上。
3. **`infra/compose/init/init-all.sh:13`** — ✅已复核:以 `--status running` 为门条件而非 healthy,与脚本自身头部注释矛盾。

### 外部参考

- [MinIO 健康检查 issue #20159](https://github.com/minio/minio/issues/20159)
- [SmallRye Health JSON 格式](https://github.com/smallrye/smallrye-health)
- [Keycloak 健康端点](https://www.keycloak.org/observability/health)

## 汇总

- **标准轴**:10 项发现(1 项硬性违规 + 9 项判断性意见);最严重:`pnpm up`/`pnpm init` 内置命令冲突,破坏了仓库自己文档化的入口命令。
- **规格轴**:10 项发现(3 项缺失/部分、4 项超范围、3 项疑似实现错误);最严重:MinIO/Keycloak 两个健康检查,会在 PROJECT_STATE.md 已排期的真实环境验收中立刻暴露。

## 修复前建议（已执行）

起草修复批次（重命名脚本并更新 README、校正健康检查、把种子偏离记入票据）——本轮已在真实环境验收前完成对应修复；剩余容器级验证需在可访问 Docker socket 的环境执行。

## 复核与修复结果（2026-08-28）

本节记录对上文发现的逐项复核结果，以及本轮已经落地的修复。原评审证据保留不改；其中部分结论是在补充代码、镜像和项目约定后被确认或纠正。

### 已确认并修复

- **开发入口命令冲突**：根脚本已改为 `infra:up`、`infra:up:parser`、`infra:up:evaluation`、`infra:down`、`infra:reset` 和 `bootstrap`，README、脚本提示及验证命令统一使用 `pnpm run ...`，不再占用 pnpm 的 `up`、`init` 等内置命令。
- **环境变量注入边界**：API、Web、Worker 继续使用标准 `tsx`/`next` 入口，不引入 `--env-file-if-exists`、`next/dist/bin`、`tsx/dist` 或其他 `node_modules` 私有路径。Compose 通过 `--project-directory` 读取仓库根 `.env`，外围环境变量优先；初始化脚本也只把 `.env` 作为本地 fallback，不覆盖外围环境变量。Prisma 配置通过 workspace 标记向上定位根目录，不写死包层级相对路径；README 已明确应用进程需要通过当前 shell、direnv、IDE 或 CI 注入变量。
- **端口校验**：`@rag/config` 新增统一 `parsePort`，API 的 `API_PORT`、Worker 的 `WORKER_HEALTH_PORT` 及 Redis URL 端口均拒绝缺失、非数字、浮点、零、负数和超过 `65535` 的值，并补充了回归测试。
- **TypeScript strict 配置**：移除 API 测试配置中不必要的 `strictPropertyInitialization: false`；Web tsconfig 改为继承根 `tsconfig.base.json`，仅保留 Next.js 必需覆盖项。
- **初始化安全与幂等性**：开发用户口令不再默认复用 Keycloak 管理员口令，`.env.example` 增加独立的 `DEV_USER_NAME`/`DEV_USER_PASSWORD`；`init-all.sh` 逐个确认六个 core 容器同时处于 `running` 与 `healthy`；Keycloak 健康检查匹配紧凑和格式化 JSON；MinIO 初始化中的重复 `docker run` 参数已抽为局部 `mc` 函数。
- **可读性与包配置**：`const e` 改为 `endpoints`；`@rag/config` 与 `@rag/contracts` 显式声明 `"type": "commonjs"`；清理未使用的 `.gitignore` 条目。
- **T0 无领域迁移/种子**：在 T0 票据中明确记录：当前没有领域 Prisma 模型时，迁移与种子允许成功空操作；T1a 首次加入领域模型时再提交第一份迁移 SQL 和最小领域种子，不能为满足 T0 验收凭空造表。

### 经复核不成立或不需要修改

- **MinIO 健康检查“必然失败”**：冻结的 `minio/minio:RELEASE.2025-09-07T16-13-09Z` 官方构建包含静态 `curl`，因此原报告将该镜像与较新的镜像行为混为一谈；现有 HTTP live 探针不因该理由判定为错误。
- **Keycloak 健康检查“永远匹配不到”**：核心风险是对 JSON 空白格式作了过强假设，已通过允许空白的正则修复；不能据此断言端点本身必然返回某一种格式。
- **Parser 资源 schema 缺失**：`services/parser/src/rag_parser/settings.py` 已声明并校验并发固定为 `1` 及 RSS 警戒 `8 GiB`，并有 pytest smoke test 覆盖。`packages/config` 中的资源 schema 只承担 Worker/预算/检索配置边界，未替代 Parser 自身配置。
- **Keycloak Realm 角色越界**：Realm 初始化属于 T0 的明确职责，且 ADR-0006/T14 已约定这些基础角色由初始化导入；不能仅因角色名称带领域色彩就判定为 T0 违规。
- **日志脱敏与云模型变量**：二者分别受 ADR-0032 与既有环境变量边界约束，当前实现没有触发云调用，也没有把真实凭证写入版本库。
- **预算/检索 schema 与 URL 去尾斜杠**：前者是冻结的配置 schema，后者只是三处短小且边界不同的 URL 拼接逻辑；本轮不为消除判断性异味而引入跨包抽象。

### 验证结果与限制

已通过：`pnpm run format`、`pnpm run lint`、`pnpm run typecheck`、`pnpm run build`、`pnpm run db:validate`、`pnpm run compose:config`、`pnpm run py:sync`、`pnpm run py:test`（5 个测试）、所有初始化脚本 `bash -n`、`git diff --check`，以及完整 `pnpm run test`（9 个文件、64 个测试）。外围 `COMPOSE_PROJECT_NAME`/`KEYCLOAK_ADMIN_PASSWORD` 优先级回归也已验证。

在受限沙箱内首次运行完整 Vitest 时，`packages/observability/test/health.test.ts` 的 5 个本地 HTTP/TCP 测试因绑定 `127.0.0.1` 被系统拒绝（`listen EPERM`）而超时；在允许本地监听的验证环境重跑后 64/64 全部通过。当前环境没有 Docker socket 权限，因此六个 core 服务真实 `healthy` 状态及初始化脚本的容器级幂等性仍需在可访问 Docker 的环境补验。

本轮未执行 commit、push、PR、merge 或部署。
