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
| [`codeql.yml`](../../.github/workflows/codeql.yml) | push main / PR / 每周一 / 手动 | 十分钟级 | 跨函数数据流的静态安全分析（TS + Python）。**当前整条 skip**，需仓库变量 `CODE_SCANNING_ENABLED=true`（见 §3.3） |
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
| CodeQL | 不阻断，进 Security 页签 | 先看全（`security-and-quality`），要当门禁再加进 required checks。**private repo 需先有 Code Security（付费）才能开 code scanning**，否则上传 SARIF 必然 403 |

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
   - Secret scanning 与 push protection：公开仓库免费；private repo 属于付费的
     Secret Protection，开不了就靠 `security.yml` 里的 gitleaks 兜底（它已扫全历史）
   - **CodeQL 在当前配置下整条 skip**。private repo 要用 code scanning 必须先有
     GitHub Code Security（原 GHAS，付费）；没有时 `analyze` 上传 SARIF 会以
     `Code scanning is not enabled for this repository` 失败——那会让每次 push 都挂一个
     永远红的检查，比没有更糟。因此 `codeql.yml` 的 job 加了开关：

     ```yaml
     if: vars.CODE_SCANNING_ENABLED == 'true'
     ```

     启用路径二选一，之后在 Settings → Secrets and variables → Actions → Variables
     加 `CODE_SCANNING_ENABLED=true`（工作流文件不用改）：
     - 仓库设为 **public**——公开库的 CodeQL 与 code scanning 免费；
     - 买 **Code Security**，private repo 才能开 code scanning。
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
- **`check:commits` 实际只在 PR 上生效**：它比较 `origin/main..HEAD`（所以 `quality`
  job 要 `fetch-depth: 0`），而 push 到 main 时 `origin/main` 就是 `HEAD`，范围为空、
  直接通过。真正被检查的是 PR 里的提交。顺带确认过 Dependabot 不会被 72 列宽度规则
  卡住：它的 **PR 标题**很长，但**提交主题**是缩写过的（如
  `chore(deps): bump python in /services/parser`，44 列）。

## 6. 首跑记录（2026-09-02）：五条工作流全红，抓到四个真缺陷

第一次真跑的结论值得原样留下——它是这套流水线是否值得存在的唯一证据。四条工作流
全部失败，其中**只有一个是流水线自己的配置错**，另外三个是仓库里真实存在、本地永远
不会复现的缺陷。

| 失败的 job | 直接症状 | 根因 | 修法 |
|---|---|---|---|
| `python` | `Unable to resolve action astral-sh/setup-uv@v10`，连 Set up job 都没过 | 这个 action 自 v8 起不再发浮动大版本标签，`v10` 是 404（只有 `v10.0.1` / `v10.0.0`） | 钉 `@v10.0.1`；`python-version` 从 `3.12.3` 放宽到 `3.12`，与 `requires-python = "==3.12.*"` 同口径 |
| `quality` | `check:links` 报 `PROJECT_STATE.md:214` 两个目标不存在 | 文档用相对链接指向 `references/ragent/`、`references/ragflow/`，而 `/references/` 是 gitignore 的本地工作副本——本地能点开，克隆下来是死链 | 改成上游 URL，并写明它只在本地存在 |
| `deps-audit` | `pnpm install --frozen-lockfile` 失败：`PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL` | 根 `postinstall` 会跑 `prisma generate`，它要求 `DATABASE_URL` 存在；`ci.yml` 的 job 有前置 `cp .env.example .env`，这个 job 没有 | 该 job 改 `--ignore-scripts`：审计只需要依赖图，不需要生成的 Prisma Client |
| `smoke` | `bootstrap` 死在 seed：`Cannot find module '.../@rag/contracts/dist/index.js'` | **README 黄金路径在全新克隆上是坏的**。`seed.ts` import 工作区包的编译产物，而 `pnpm install` 的 postinstall 只跑 `prisma generate`、不构建；本地一直不复现只因为 `dist` 是历次 build 的残留 | `init-database.sh` 在 seed 前 `pnpm --filter "...@rag/database" run build`。让 bootstrap 自给自足，而不是往 README 里加一步——它对外的承诺就是"一条命令、可重复执行" |
| `analyze`（×2） | `Code scanning is not enabled for this repository` | private repo 的 code scanning 需要付费的 Code Security；个人账号 free plan 开不了 | job 加 `if: vars.CODE_SCANNING_ENABLED == 'true'`，skip 是灰色而不是红色（见 §3.3） |

`gitleaks（全历史密钥扫描）`、`node`、`compose` 三个 job 首跑即绿。

两条可以带走的经验：

- **本地全绿证明不了新环境能跑起来。** 那三个真缺陷（死链、缺 `.env`、缺 `dist`）的
  共同点都是"本地有残留状态"。这正是 `integration.yml` 从干净 checkout 起容器的意义，
  也是为什么它值得那十分钟。
- **配置错也是收获。** `setup-uv@v10` 这种"看起来一定存在的浮动大版本"只有真跑一次
  才知道不存在，写文档写得再细也发现不了。

## 7. 明确不做的事（阶段 1）

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
