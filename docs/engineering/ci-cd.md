# CI/CD、质量检测与日志检测

> 本文件描述仓库当前**真实存在**的流水线。没做的事在第 6 节明确列出，不写成"计划中"
> 混在能力清单里。

- 建立日期：2026-09-01
- 远端：`https://github.com/Axwen/myRAG.git`
- 适用范围：阶段 1（T0–T16）。生产部署编排等有目标环境与 ADR 后再加。

## 1. 五条工作流的分工

| 工作流 | 触发 | 时长量级 | 管什么 |
|---|---|---|---|
| [`ci.yml`](../../.github/workflows/ci.yml) | push main / PR / 手动 | 分钟级 | 静态检查、单测、覆盖率、构建、Compose 配置解析 |
| [`integration.yml`](../../.github/workflows/integration.yml) | push main / PR / 手动 | 十分钟级 | 真起六个 core 容器 → bootstrap → 编译产物起进程 → HTTP 契约与日志断言 |
| [`security.yml`](../../.github/workflows/security.yml) | push main / PR / 每周一 / 手动 | 分钟级 | 全历史密钥扫描、依赖漏洞、PR 依赖变更与许可证 |
| [`codeql.yml`](../../.github/workflows/codeql.yml) | push main / PR / 每周一 / 手动 | 十分钟级 | 跨函数数据流的静态安全分析（TS + Python） |
| [`release.yml`](../../.github/workflows/release.yml) | 推 `v*` 标签 / 手动 | 十分钟级 | 发布前重跑 verify、Parser 镜像进 GHCR、SBOM、GitHub Release |

为什么分成五条而不是一条：失败信号要能直接指向原因。"编译不过"和"跑起来不对"是两
类问题，混在一个 job 里只会得到一个红点；中间件拉起来要几分钟，把它和 lint 绑在一起
会让最快的反馈也变慢。

## 2. 三类检测分别覆盖什么

### 2.1 质量检测

| 检查 | 命令（本地同一条） | 阻断 | 说明 |
|---|---|---|---|
| 格式 | `pnpm run format` | 是 | Prettier `--check`，不自动改 |
| Lint | `pnpm run lint` | 是 | ESLint，含 `no-console`（业务代码零 `console.*`） |
| Shell | `pnpm run check:shell` | 是 | shellcheck，阈值 `warning`。CI 用 `--strict`：未安装即失败，不许静默跳过 |
| Markdown 链接 | `pnpm run check:links` | 是 | 相对链接与 `#锚点` 是否存在。文档是本项目的事实源，断链等于事实源失效 |
| 提交信息 | `pnpm run check:commits` | 是 | Conventional Commits + 主题行显示宽度 ≤72（中文按双宽算） |
| 类型 | `pnpm run typecheck` | 是 | 含 `prisma/seed.ts`（它曾长期落在所有 tsconfig 之外） |
| 单测 | `pnpm run test` | 是 | 16 文件 / 129 测试（2026-09-01） |
| 覆盖率 | `pnpm run test:coverage` | 是 | 阈值见 [`vitest.config.ts`](../../vitest.config.ts) |
| 构建 | `pnpm run build` | 是 | 构建后 `git diff --exit-code`，确认没有回写被跟踪文件 |
| Prisma | `pnpm run db:validate` | 是 | schema 校验 |
| Python | `uv lock --check` + `uv sync --frozen` + `pytest -q` | 是 | 锁文件与 pyproject 必须一致 |
| Compose | `pnpm run compose:config` | 是 | 含 parser / evaluation profile 的配置解析 |

覆盖率阈值是**棘轮**：取实测值下取整一档，只往上调，不往下让。当前基线（已排除
Prisma 生成产物、`apps/web`、种子脚本）：statements 87.15 / branches 82.43 /
functions 83.16 / lines 87.83，阈值设 86 / 81 / 82 / 86。它拦的是"新增未测代码把
整体拉下来"，不是一个漂亮数字——所以不要为了过阈值去写断言恒真的测试。

### 2.2 日志检测

日志检测由 [`scripts/smoke-api.sh`](../../scripts/smoke-api.sh) 在 `integration.yml`
里执行，对真实进程的 stdout 做三类断言：

1. **结构**：每一行都是 JSON，且带 `level` / `time` / `service=api`。唯一例外是 Node
   运行时自身的告警（写 stderr、不经应用 logger），且例外模式在脚本里显式列出。
2. **框架日志覆盖**：至少存在带 `nest:true` 的行。这是一条防回归断言——
   `app.useLogger(new NestPinoLogger(logger))` 一旦被移除，NestJS 会退回
   `ConsoleLogger` 的彩色纯文本，那条通路**完全绕过 `redaction.ts` 的脱敏配置**，
   框架级异常栈（可能含连接串、鉴权头）会原样进 stdout。
3. **泄漏**：`.env` 里的 `POSTGRES_PASSWORD`、`RABBITMQ_PASSWORD`、
   `MINIO_ROOT_PASSWORD`、`KEYCLOAK_ADMIN_PASSWORD`、`DEV_USER_PASSWORD`、
   `OPENROUTER_API_KEY`、`FLUXIONAI_API_KEY` 以及 `DATABASE_URL` 里的口令，
   都不得出现在进程输出里。脚本逐个变量从 `.env` 取值，不 `source`、不打印值本身。

"错误响应的 `trace_id` 能反查到日志行"这一条不在冒烟里，而在
[`apps/api/test/global-exception-filter.test.ts`](../../apps/api/test/global-exception-filter.test.ts)：
要在冒烟里触发 `INTERNAL_ERROR` 就得往生产代码里加故障注入路由，代价大于收益。
该单测把 logger 注入内存流，断言响应体的 `trace_id` 与日志行的 `traceId` 相同、
且堆栈只在日志侧；同时断言 4xx **不写**错误日志（鉴权拒绝不该污染错误日志）。

### 2.3 安全检测

| 检查 | 阻断阈值 | 为什么这样定 |
|---|---|---|
| gitleaks（全历史） | 任何命中 | `.env` 被 gitignore 与"从没被提交过"是两件事，只有扫全历史能确认 |
| `pnpm audit` | critical 阻断，high 只报告 | 没有修复版本的传递依赖告警会把所有 PR 堵死，那样的门禁最终一定被绕过 |
| dependency-review（仅 PR） | high；拒绝 AGPL / SSPL | 供应链的入口在引入那一刻，不在事后 |
| CodeQL | 不阻断，进 Security 页签 | 先看全（`security-and-quality`），要当门禁再加进 required checks |

放行清单在 [`.gitleaks.toml`](../../.gitleaks.toml)，判据只有一条：值本身是刻意无效的
占位符或测试夹具，泄漏它没有后果。

## 3. 需要在 GitHub 页面上手工做的配置

工作流文件进仓库就会跑，但下面这些是仓库设置，只能在网页上点：

1. **分支保护**（Settings → Branches → Add rule，Branch name pattern `main`）
   - Require a pull request before merging（勾 Require approvals = 1；单人项目可留 0，
     但保留 PR 流程，让每次改动都有 CI 记录）
   - Require status checks to pass，把这些加为 required（搜索框里按 job 名找，
     列表要等这些 job 至少跑过一次才会出现）：
     - `node（lint / typecheck / test / prisma / build）`
     - `quality（shell / 链接 / 提交信息 / 覆盖率）`
     - `python（parser uv / pytest）`
     - `compose（配置解析 / parser 镜像构建）`
     - `smoke（六容器 + bootstrap + 进程级 HTTP/日志断言）`
     - `gitleaks（全历史密钥扫描）`

     `pnpm audit`、`dependency-review` 与 CodeQL 暂不设为 required：前两者按设计对
     high 只报告，CodeQL 首轮结果还没人看过，先观察一段再决定。
   - Require branches to be up to date before merging
   - Require conversation resolution before merging
   - 不要勾 Allow force pushes / Allow deletions
2. **Actions 权限**（Settings → Actions → General）
   - Workflow permissions 选 **Read repository contents and packages permissions**
     （各工作流已按需在 job 级声明 `packages: write` / `security-events: write`，
     不需要默认给写权限）
   - 勾 Allow GitHub Actions to create and approve pull requests：**不要勾**
3. **Code scanning**（Settings → Code security）
   - 打开 Dependabot alerts 与 Dependabot security updates
   - Secret scanning 与 push protection 打开（公开仓库免费）
4. **Actions secrets**：**当前一个都不需要**。所有工作流只用 `.env.example` 的占位值和
   自动注入的 `GITHUB_TOKEN`。哪天要加，先回答"CI 为什么需要真实凭证"。

## 4. 本地怎么跑同一批检查

```bash
pnpm run verify          # format + lint + shell + links + typecheck + test + build + prisma + python + compose
pnpm run test:coverage   # 覆盖率与阈值
pnpm run check:commits   # 提交信息（默认比 origin/main..HEAD）
pnpm run infra:up && pnpm run bootstrap && pnpm run build
pnpm run smoke:api       # HTTP 契约 + 日志结构 + 日志泄漏（需中间件已起）
pnpm run dx:baseline     # DX 耗时基线
```

`pnpm audit` 在本地常因 registry 指向 npmmirror 而报 `AUDIT_ENDPOINT_NOT_EXISTS`；
CI 里显式带 `--registry https://registry.npmjs.org`。

## 5. 已知的运维注意点

- **gitleaks-action 的许可证**：个人账号仓库免费。一旦仓库迁到 organization 下，
  该 action 会要求 `GITLEAKS_LICENSE`。届时改为直接下载 gitleaks 二进制运行
  （`gitleaks detect --config .gitleaks.toml --redact`），不引入付费依赖。
- **Dependabot 的 uv 生态已验证可用**（2026-09-02，PR #2 同时改了 `pyproject.toml`
  与 `uv.lock`），无需回退到 `pip`。
- **基础镜像的 Python 小版本必须人工升**：`pyproject.toml` 与 `uv.lock` 都写死
  `requires-python = "==3.12.*"`，镜像跳到 3.13/3.14 会让容器内 `uv sync --frozen`
  直接拒绝解析；PROBE-002 的 DeepDOC 依赖链也是按 3.12 实测的。`dependabot.yml` 已
  忽略 python 镜像的 major/minor（首个此类 PR 正是 3.12.3 → 3.14.7），补丁位仍自动跟。
  真要升：改 `requires-python` → 重跑 `uv lock` → 复测 PROBE-002。
- **`integration.yml` 的资源**：runner 16 GiB，工作流把 `OPENSEARCH_JAVA_OPTS` 降到
  `-Xms1g -Xmx1g`。这条冒烟不做规模检索，够用；真实性能基线永远在本机 23.47 GiB
  profile 上测，不看 CI 数字。
- **首次运行**：`ci.yml` 的 `quality` job 需要完整历史（`fetch-depth: 0`）才能比较
  `origin/main..HEAD`；仓库首次推送时 `origin/main` 尚不存在，脚本会退化为
  `HEAD~1..HEAD`。

## 6. 明确不做的事（阶段 1）

写在这里是为了避免把"没做"读成"漏了"：

- **不部署**。生产 Kubernetes 不在阶段 1 范围（见 PROJECT_STATE.md「核心架构不变量」）。
  没有目标环境、Secret 管理方案与回滚演练记录之前，不写部署步骤。CD 目前只到
  "产物可被拉取"。
- **api / web / worker 不出镜像**。仓库里只有 `services/parser/Dockerfile` 和探针用的
  deepdoc 镜像，三个 Node 应用没有 Dockerfile，因此无从构建——不放"看起来在发布"的
  空步骤。需要时按 T15/T16 补，届时这条流水线加 job。
- **不跑 evals、不做云模型调用**。付费调用不进 CI；解析链路本身零云调用（ADR-0038）。
- **无 E2E**。Playwright 要等 T16a 起有页面（`apps/web` 目前只有 T0 健康页），
  届时接入并把 `apps/web` 计回覆盖率。
- **无 Testcontainers**。容器级集成测试仍是未验证项；`integration.yml` 用 Compose 起真
  容器覆盖了一部分，但不等于 Testcontainers 那套按测试隔离的能力。
- **无性能门禁**。`Recall@5 0.92`、`P50 1.2s`、`verify ≤20s` 都是候选目标而非门禁
  （见 PROJECT_STATE.md「质量指标口径」）。verify 的阈值等 CI 有真实分布后再定。
