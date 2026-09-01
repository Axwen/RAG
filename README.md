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
pnpm run verify          # 一条命令跑完下面全部
pnpm run format          # Prettier --check（不自动改）
pnpm run lint            # ESLint
pnpm run check:shell     # shellcheck（未装 shellcheck 只警告；CI 用 --strict 硬失败）
pnpm run check:links     # Markdown 相对链接与锚点
pnpm run typecheck       # 含 prisma/seed.ts
pnpm run test
pnpm run build
pnpm run db:validate
pnpm run py:sync
pnpm run py:test
pnpm run compose:config
```

不在 `verify` 里的三条（各有前置条件）：

```bash
pnpm run test:coverage   # 覆盖率与阈值（棘轮，见 vitest.config.ts）
pnpm run check:commits   # 提交信息规范，需要 git 历史
pnpm run smoke:api       # 真起编译产物：HTTP 契约 + 日志结构 + 日志泄漏
                         # 前置：infra:up && bootstrap && build
```

CI 跑的是同一批命令，不启动付费模型调用。流水线全貌、需要在 GitHub 页面手工点的分支
保护设置，以及明确不做的事，见 [CI/CD 与质量·日志检测](docs/engineering/ci-cd.md)。

### DX 基线

```bash
pnpm run dx:baseline          # 量 install / verify / infra:up / bootstrap / API 就绪耗时
```

默认热态、非破坏，把结果写到 `.dx-baseline/latest.json`（不进版本库）并打印对照表：
`verify` 目标 ≤20s，TTHW（`infra:up` + `bootstrap` + `/health/ready` 200）目标 <120s。
阶段失败才退出非 0；只是超目标退 0 加 ⚠️，需要当门禁时加 `--strict`。
冷启动测量（`--cold`）会删数据卷与 `node_modules`，必须再加 `--yes-destroy-data`。

## 健康检查

- API：`GET http://localhost:${API_PORT:-3001}/health/live`、`/health/ready`
- Web：`GET http://localhost:${WEB_PORT:-3000}/api/health`
- Worker：`GET http://localhost:${WORKER_HEALTH_PORT:-3002}/health/live`、`/health/ready`
- Parser（启用 parser profile）：`GET http://localhost:${PARSER_PORT:-8100}/health/live`、`/health/ready`

`live` 只表示进程存活；`ready` 会检查所需依赖，依赖不可用时返回 HTTP `503`。
