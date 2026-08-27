# T0：Monorepo 与本地开发基线

## 目的

在任何领域实现进入仓库前，建立可安装、可构建、可测试、可启动的最小工程骨架。T0 只解决工具链、包边界、本地依赖和 CI 入口，不提前实现 Manifest、状态机、消息、检索或回答业务。

## 已冻结决策

- 包管理使用 pnpm workspace；初期不引入 Turborepo，根脚本与 `pnpm --recursive` 足以覆盖当前规模。
- Node.js 基线为 `22.23.1`，pnpm 为 `10.34.5`，Python 为 `3.12.3`；根 `package.json` 必须声明 `packageManager` 和 `engines`。
- TypeScript 开启 `strict`；使用 ESLint、Vitest。Parser 使用 uv、pytest，并提交 `pyproject.toml` 与 `uv.lock`。
- Workspace 目录为 `apps/{api,web,worker}`、`packages/{contracts,database,rag-core,config,observability}`、`services/parser`、`infra/compose`、`evals`、`tests`。不得只提交空目录；每个纳入 workspace 的项目必须有最小入口、包清单或用途说明。
- 本地 Compose 复用已经实测的 Keycloak `26.2.5`、OpenSearch `2.19.1`、RabbitMQ `3.13-management`。PostgreSQL、Redis、MinIO 没有探针冻结版本，T0 实现时必须从官方稳定镜像中选择明确标签、记录选择依据并通过健康检查，不得使用 `latest`。
- Prisma 使用 Prisma Migrate：本地开发使用 `migrate dev`，CI/部署使用 `migrate deploy`；迁移 SQL 进入版本库，不用 `db push` 代替正式迁移。自定义索引或数据库特性按 ADR-0013 使用受控 SQL migration。
- `.env.example` 只含无敏感默认值和变量说明；真实 Token、密码和模型密钥只来自未跟踪 env 或运行环境。

## 范围

1. 根工作区：`package.json`、`pnpm-workspace.yaml`、锁文件、共享 TypeScript/ESLint/Vitest 配置和统一脚本。
2. 应用与包：为 API、Web、Worker 和共享包提供能通过 typecheck/build 的最小入口，不加入业务占位实现。
3. Python：为 Parser 建立 uv 项目、锁文件、pytest smoke test 和容器构建入口；探针 Dockerfile 仍保留为可丢弃证据，不直接充当生产 Parser 镜像。
4. Compose：PostgreSQL、OpenSearch、RabbitMQ、Redis、MinIO、Keycloak 的明确版本、健康检查、持久化卷和可配置端口；Parser 与 evaluation 使用显式 profile，不随日常 core 默认启动。
5. 初始化：可重复导入 Keycloak Realm、创建本地 MinIO Bucket、应用数据库迁移并写入最小开发种子数据。
6. CI：冻结依赖安装、lint、typecheck、单元 smoke test、Prisma validate、Python uv/pytest、Compose 配置校验和构建检查。真实付费模型调用不得进入普通 CI。
7. 开发入口：文档化安装、启动、停止、重置、迁移、测试和健康检查命令；Compose 不固定 `container_name`，允许 CI 和不同工作区并行运行。

## 资源边界

- 默认本地 profile 以 WSL2 22 GiB 日常上限为目标；DeepDOC 或批量评测使用显式 24 GiB profile。
- T0 只建立并校验资源配置 schema。`worker:ingestion` 并发 4/in-flight 8、`worker:evaluation` 并发 1/in-flight 1、Parser 并发 1/RSS 警戒 8 GiB 的运行时强制与并行压测由 T10 分阶段关闭。

## 验收

- 从干净检出可以使用仓库文档中的命令完成 pnpm 与 uv 冻结安装。
- 根 lint、typecheck、Vitest、pytest、构建和 Prisma validate 全部通过。
- Compose 配置可解析，六个 core 中间件能达到 healthy；重复启动和停止不要求手工清理固定容器名。
- Keycloak Realm、MinIO Bucket、数据库迁移与开发种子可以重复执行且不产生重复副作用。
- API、Web、Worker、Parser 提供最小健康入口；关闭任一中间件时错误明确，不伪装为可用。
- CI 执行与本地相同的冻结检查，且不会读取仓库外凭证或触发付费云模型调用。

## 不在范围

- 领域 Prisma schema、Manifest、Release、状态机和审计事实。
- RabbitMQ Outbox/Attempt/Generation 行为。
- Parser 业务协议、ModelAdapter、检索、回答、删除和 UI 产品功能。
- 生产 Kubernetes、部署、PR 或远程仓库配置。

## 依赖与后续

- 依赖：探针收尾提交完成，工作区干净。
- T0 完成后先执行 DX Review 和一次实现准备增量工程复审，再冻结实际周期与后续 Ticket 的最终批次。
- 相关事实源：[PROJECT_STATE.md](../../../PROJECT_STATE.md)、[工程评审闭合记录](../plan-eng-review-closure.md)、[Probe Decision Gate](../probe-decision-gate.md)。
