# 可信 RAG Monorepo

阶段 1 工程基线：pnpm workspace、TypeScript 应用与共享包、Python Parser、
本地中间件 Compose、幂等初始化和 CI 冻结检查；T1a 起加入领域核心
（租户、知识空间、Manifest、Release 与兼容矩阵）。

## 黄金路径（新终端从零到全绿）

```bash
pnpm install --frozen-lockfile
cp .env.example .env        # 首次
pnpm run infra:up           # 环境预检 + 启动六个 core 中间件并等待 healthy
pnpm run bootstrap          # Keycloak、MinIO、数据库迁移与开发种子（幂等）
pnpm --filter @rag/api dev  # 无需手工 source .env：应用入口自动预载根 .env
```

看到 `GET /health/ready` 返回 200 全绿即成功：

```bash
curl http://localhost:${API_PORT:-3001}/health/ready
```

每个新终端只需第三、四步：`.env` 由应用自动读取（已存在的环境变量优先），
中间件保持运行。环境缺项先跑 `pnpm run preflight`，报错会直接给出修复指引。

## 环境要求

- Node.js `22.23.1`（见 `.nvmrc`）
- pnpm `10.34.5`
- Python `3.12.3`
- uv `0.12.5`
- Docker Engine 与 Compose v2

## 安装与配置

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

`.env` 只用于本地运行，真实密码和模型密钥不得提交。应用入口（API、Worker）
在解析配置前自动预载仓库根 `.env`，且不覆盖已存在的外围环境变量——新终端
不需要再执行 `set -a; source .env; set +a`。也可以使用 direnv、IDE launch
configuration 或 CI secret 注入同一组变量。Compose 命令同样自动读取仓库根
`.env`，且外围环境变量优先。阶段 1 解析链路零云调用（ADR-0038），T0/T1a
不调用任何云模型。

## 本地运行

```bash
pnpm run infra:up       # 启动六个 core 中间件并等待 healthy
pnpm run bootstrap      # 幂等导入 Keycloak、创建 MinIO Bucket、执行数据库迁移
pnpm --filter @rag/api dev       # 应用入口自动预载根 .env
pnpm --filter @rag/web dev
pnpm --filter @rag/worker dev    # 需要显式设置 WORKER_PROFILE
```

Parser 和 evaluation worker 使用显式 profile，不随 core 默认启动：

```bash
pnpm run infra:up:parser
pnpm run build
pnpm run infra:up:evaluation
```

停止或清理本地中间件：

```bash
pnpm run infra:down       # 停止并保留命名卷
pnpm run infra:reset      # 停止并删除本地命名卷，下一次启动会重新初始化
pnpm run db:migrate        # 本地开发迁移（migrate dev）
pnpm run db:migrate:deploy # CI/部署迁移（migrate deploy）
```

## 检查与测试

```bash
pnpm run format
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run db:validate
pnpm run py:sync
pnpm run py:test
pnpm run compose:config
pnpm run verify
```

`verify` 汇总格式、Lint、类型、Vitest、构建、Prisma、Python 和 Compose 配置检查。
CI 使用同样的冻结安装和检查命令，不启动付费模型调用。

## 健康检查

- API：`GET http://localhost:${API_PORT:-3001}/health/live`、`/health/ready`
- Web：`GET http://localhost:${WEB_PORT:-3000}/api/health`
- Worker：`GET http://localhost:${WORKER_HEALTH_PORT:-3002}/health/live`、`/health/ready`
- Parser（启用 parser profile）：`GET http://localhost:${PARSER_PORT:-8100}/health/live`、`/health/ready`

`live` 只表示进程存活；`ready` 会检查所需依赖，依赖不可用时返回 HTTP `503`。
