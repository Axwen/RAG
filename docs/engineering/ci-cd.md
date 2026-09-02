# CI/CD、质量检测与日志检测

> 本文件描述仓库当前**真实存在**的流水线。没做的事在第 7 节明确列出，不写成"计划中"
> 混在能力清单里。

- 建立日期：2026-09-01
- 远端：`https://github.com/Axwen/myRAG.git`
- 适用范围：阶段 1（T0–T16）。生产部署编排等有目标环境与 ADR 后再加。

## 1. 五条工作流的分工

| 工作流 | 触发 | 时长量级 | 管什么 |
|---|---|---|---|
| [`ci.yml`](../../.github/workflows/ci.yml) | push main / PR / 手动 | 分钟级 | 静态检查（含工作流 YAML 自身）、单测、覆盖率与增量覆盖率、构建、Compose 配置解析、Parser 镜像构建并真起一次 |
| [`integration.yml`](../../.github/workflows/integration.yml) | push main / PR / 每周一 / 手动 | 十分钟级 | 真起六个 core 容器 → bootstrap → 编译产物起进程 → HTTP 契约与日志断言 |
| [`security.yml`](../../.github/workflows/security.yml) | push main / PR / 每周一 / 手动 | 分钟级 | 全历史密钥扫描、依赖漏洞、PR 依赖变更与许可证 |
| [`codeql.yml`](../../.github/workflows/codeql.yml) | push main / PR / 每周一 / 手动 | 十分钟级 | 跨函数数据流的静态安全分析（TS + Python）。**当前整条 skip**，需仓库变量 `ADVANCED_SECURITY_ENABLED=true`（见 §3.3） |
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
| 工作流 YAML | `pnpm run check:workflows` | 是 | 两层：基线（YAML 可解析 / `needs` 与 `steps.<id>` 引用 / `uses` 必须钉 40 位 SHA / 跑 `check:secrets`、`check:commits`、`verify` 的 job 必须写 `fetch-depth: 0`，只用 PyYAML，永远跑）+ actionlint（表达式、上下文、`run:` 块交 shellcheck；本地缺则警告，CI 用 `--strict` 下载钉死版本并校验 sha256） |
| 密钥 | `pnpm run check:secrets` | 是 | gitleaks 扫 HEAD 的全部祖先提交。本地缺 gitleaks 只警告，CI 用 `--strict` 下载钉死版本（v8.30.1）并校验 sha256。详见 §2.3 |
| Markdown 链接 | `pnpm run check:links` | 是 | 相对链接与 `#锚点` 是否存在。文档是本项目的事实源，断链等于事实源失效 |
| 提交信息 | `pnpm run check:commits` | 是 | Conventional Commits + 主题行显示宽度 ≤72（中文按双宽算）。CI 在 push 上显式传 `${{ github.event.before }}..${{ github.sha }}`——不传就是空区间（§6.4） |
| 类型 | `pnpm run typecheck` | 是 | 含 `prisma/seed.ts`（它曾长期落在所有 tsconfig 之外） |
| 单测 | `pnpm run test` | 是 | 16 文件 / 129 测试（2026-09-01） |
| 覆盖率 | `pnpm run test:coverage` | 是 | 全局阈值见 [`vitest.config.ts`](../../vitest.config.ts) |
| 增量覆盖率 | `pnpm run check:diff-coverage` | 是 | 本次改动新增的、被插桩的行 ≥80%。全局阈值拦整体退化，拦不住"这次新增的没测"——仓库越大，一个全新未测文件对整体的拉低越小 |
| 构建 | `pnpm run build` | 是 | 构建后 `git diff --exit-code`，确认没有回写被跟踪文件 |
| Prisma | `pnpm run db:validate` | 是 | schema 校验 |
| Python | `uv lock --check` + `uv sync --frozen` + `pytest -q` | 是 | 锁文件与 pyproject 必须一致 |
| Compose | `pnpm run compose:config` | 是 | 含 parser / evaluation profile 的配置解析 |
| Parser 镜像 | `pnpm run check:parser-image <ref>` | 是 | 构建完真 `docker run` 一次：等 HEALTHCHECK 变 healthy，再从宿主机打 `/health/live`。构建成功只证明依赖装得上 |

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
| gitleaks（HEAD 全部祖先提交） | 任何命中 | `.env` 被 gitignore 与"从没被提交过"是两件事，只有扫全历史能确认。**2026-09-02 起才真的在扫全历史**——此前用的 `gitleaks/gitleaks-action` 按事件名自行收窄范围，见 §6.5 |
| `pnpm audit` | critical 阻断，high 只报告 | 没有修复版本的传递依赖告警会把所有 PR 堵死，那样的门禁最终一定被绕过 |
| dependency-review（仅 PR） | high；拒绝 AGPL / SSPL | 供应链的入口在引入那一刻，不在事后。**当前 skip**：private repo 上这个 action 同样要 Code Security，见 §3.3 |
| CodeQL | 不阻断，进 Security 页签 | 先看全（`security-and-quality`），要当门禁再加进 required checks。**private repo 需先有 Code Security 才能开 code scanning**，否则上传 SARIF 必然失败，见 §3.3 |

密钥扫描的命令收在 [`scripts/check-secrets.sh`](../../scripts/check-secrets.sh)，本地与 CI
同一条（`pnpm run check:secrets`，CI 加 `--strict`）。它明确**不**扫工作区（不加
`--no-git`）：那样会扫到被 gitignore 的真 `.env`，而本机有一份带真口令的 `.env` 是正常
状态、不是缺陷，让 `verify` 因此变红只会训练人忽略这条门禁。git 忽略的文件进不了仓库，
本就不在这条门禁的射程内；"提交之前拦一次"属于 pre-commit 钩子的职责。

放行清单在 [`.gitleaks.toml`](../../.gitleaks.toml)，判据只有一条：值本身是刻意无效的
占位符或测试夹具，泄漏它没有后果。

## 3. 需要在 GitHub 页面上手工做的配置

工作流文件进仓库就会跑，但下面这些是仓库设置，只能在网页上点：

1. **分支保护**（Settings → Branches → Add rule，Branch name pattern `main`）
   - Require a pull request before merging（勾 Require approvals = 1；单人项目可留 0，
     但保留 PR 流程，让每次改动都有 CI 记录）
   - Require status checks to pass，把这些加为 required（搜索框里按 job 名找，
     列表要等这些 job 至少跑过一次才会出现——**六个都已于 2026-09-02 第三轮全绿**，
     其中 `quality` 与 `compose` 在第四轮（§6.4）**改过名**，改名后的名字要等这一轮
     跑完才会出现在选择器里，老名字要手动去掉）：
     - `node（lint / typecheck / test / prisma / build）`
     - `quality（shell / YAML / 链接 / 提交信息 / 覆盖率）`
     - `python（parser uv / pytest）`
     - `compose（配置解析 / parser 镜像构建与启动）`
     - `smoke（六容器 + bootstrap + 进程级 HTTP/日志断言）`
     - `gitleaks（全历史密钥扫描）`

     剩下三个都不设为 required，各有各的理由：`pnpm audit` 按设计对 high 只报告
     （critical 才阻断，它自己会红）；`dependency-review` 与 CodeQL 在本仓库整条 skip，
     把 skip 设成 required 只是给自己一个假的安全感（见 §3.3）。
   - Require branches to be up to date before merging
   - Require conversation resolution before merging
   - 不要勾 Allow force pushes / Allow deletions
2. **Actions 权限**（Settings → Actions → General）
   - Workflow permissions 选 **Read repository contents and packages permissions**
     （各工作流已按需在 job 级声明 `packages: write` / `security-events: write`，
     不需要默认给写权限）
   - 勾 Allow GitHub Actions to create and approve pull requests：**不要勾**
3. **Code scanning 与 dependency review**（Settings → Code security）
   - 打开 Dependabot alerts 与 Dependabot security updates
   - Secret scanning 与 push protection：公开仓库免费；private repo 属于付费的
     Secret Protection，开不了就靠 `security.yml` 里的 gitleaks 兜底——注意这句话在
     2026-09-02 之前是**不成立**的：当时那个 job 只扫本次推送的提交（§6.5）。现在它扫
     HEAD 的全部祖先提交，兜底才真的成立
   - **`analyze`（CodeQL）与 `dependency-review` 当前都是 skip。** 两者卡在同一件事上：
     private repo 上它们都要求 Code Security / Advanced Security。没有时的实测报错分别是

     ```text
     Code scanning is not enabled for this repository
     Dependency review is not supported on this repository
     ```

     真让它们跑就会各挂一个永远红的检查——CodeQL 挂在每次 push 上，dependency-review
     挂在每个 PR 上（首批三个 Dependabot PR 全是这样红的，而 PR 恰恰是人真会去看红叉
     的地方）。永远红的门禁只会训练人忽略红叉，比没有更糟，所以两个 job 都用同一个
     仓库变量当开关：

     ```yaml
     # codeql.yml
     if: vars.ADVANCED_SECURITY_ENABLED == 'true'
     # security.yml
     if: github.event_name == 'pull_request' && vars.ADVANCED_SECURITY_ENABLED == 'true'
     ```

     变量按"根因"命名而不是按功能各起一个：它们要的是同一件东西，分成两个开关只会
     让人以为可以单独打开其中一个。

     启用路径：在 Settings → Secrets and variables → Actions → Variables 加
     `ADVANCED_SECURITY_ENABLED=true`（工作流文件不用改），前提是先满足下面之一——
     - 仓库设为 **public**：公开库的 CodeQL、code scanning 与 dependency review 都免费，
       这是个人账号下唯一确定可行的路；
     - 让仓库归属一个开了 **Code Security / Advanced Security** 的 organization。该产品
       面向组织与企业销售，个人账号下的 private repo 买不到——所以在当前归属下，
       "掏钱开启"并不是一个真实选项。
4. **Actions secrets**：**当前一个都不需要**。所有工作流只用 `.env.example` 的占位值和
   自动注入的 `GITHUB_TOKEN`。哪天要加，先回答"CI 为什么需要真实凭证"。

## 4. 本地怎么跑同一批检查

```bash
pnpm run verify              # format + lint + shell + 工作流 + 密钥 + links + typecheck + test + build + prisma + python + compose
pnpm run test:coverage       # 全局覆盖率与阈值
pnpm run check:diff-coverage # 增量覆盖率（要先跑过 test:coverage，它读 coverage/lcov.info）
pnpm run check:commits       # 提交信息（默认 origin/main..HEAD，可显式传区间）
pnpm run check:workflows     # 工作流基线；加 --strict 才下载 actionlint
pnpm run check:secrets       # 密钥扫描；加 --strict 才下载 gitleaks
pnpm run infra:up && pnpm run bootstrap && pnpm run build
pnpm run smoke:api           # HTTP 契约 + 日志结构 + 日志泄漏（需中间件已起）
docker build -t rag-parser:ci services/parser && pnpm run check:parser-image rag-parser:ci
pnpm run dx:baseline         # DX 耗时基线
```

`verify` 里的 `check:workflows` 不带 `--strict`：本机没装 actionlint 时只跑基线那一层
（YAML 可解析、引用一致、`uses` 钉 SHA），不会为了一次本地检查去联网下载二进制。
CI 里带 `--strict`，两层都跑。

单独跑 `pnpm test` / `pnpm test:coverage` 前要先 `pnpm run build`——跨包 import 解析到
`dist`，全新克隆里没有它就有 6 个测试文件加载不起来（§6.2）。`verify` 不受影响：它的
`typecheck` 步骤就是 `tsc -b`，会顺手 emit。真忘了也不会踩坑，`vitest.config.ts` 会先
报出缺哪些产物。

`pnpm audit` 在本地常因 registry 指向 npmmirror 而报 `AUDIT_ENDPOINT_NOT_EXISTS`；
CI 里显式带 `--registry https://registry.npmjs.org`。

## 5. 已知的运维注意点

- **gitleaks 已不再依赖 `gitleaks-action`**（2026-09-02，§6.5）。原因不是许可证——它的日志
  明确写 `[Axwen] is an individual user. No license key is required.`，个人账号确实免费——
  而是那个 action 按事件名自行决定扫描范围。现在走
  [`scripts/check-secrets.sh`](../../scripts/check-secrets.sh)，版本（v8.30.1）与三个平台的
  sha256 写死在脚本顶部，升级时同改；顺带也就不会在迁到 organization 时被
  `GITLEAKS_LICENSE` 卡住。子命令用 `git` 而不是 `detect`：后者自 v8.19.0 起已废弃
  （仍能跑，但从 `--help` 里隐掉了）。
- **actionlint 的版本与校验和写死在脚本里**（`scripts/check-workflows.sh` 顶部），
  gitleaks 同理（`scripts/check-secrets.sh`）。升级时同改版本号与三个平台的 sha256；
  校验和不从同一个来源运行时拉取，这样上游资产被替换会当场失败而不是静默通过。
  这条纪律对检查工具自己和对 action 一视同仁。
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
- **`check:commits` 在 push 上曾是空转**（已修，见 §6.4）：它默认比 `origin/main..HEAD`，
  而 `actions/checkout` 在 push 到 main 时会把本地 `main` 指到 `origin/main`，区间恒为空。
  现在 CI 在 push 上显式传 `${{ github.event.before }}..${{ github.sha }}`，脚本本身也不再
  允许"自动区间为空"当作通过。顺带确认过 Dependabot 不会被 72 列宽度规则卡住：它的
  **PR 标题**很长，但**提交主题**是缩写过的（如
  `chore(deps): bump python in /services/parser`，44 列）。

## 6. 真跑记录（2026-09-02）：三轮修到全绿，两轮主动审计

### 6.1 第一轮：五条工作流全红

第一次真跑的结论值得原样留下——它是这套流水线是否值得存在的唯一证据。四条工作流
全部失败，其中**只有一个是流水线自己的配置错**，另外三个是仓库里真实存在、本地永远
不会复现的缺陷。

| 失败的 job | 直接症状 | 根因 | 修法 |
|---|---|---|---|
| `python` | `Unable to resolve action astral-sh/setup-uv@v10`，连 Set up job 都没过 | 这个 action 自 v8 起不再发浮动大版本标签，`v10` 是 404（只有 `v10.0.1` / `v10.0.0`） | 钉 `@v10.0.1`；`python-version` 从 `3.12.3` 放宽到 `3.12`，与 `requires-python = "==3.12.*"` 同口径 |
| `quality` | `check:links` 报 `PROJECT_STATE.md:214` 两个目标不存在 | 文档用相对链接指向 `references/ragent/`、`references/ragflow/`，而 `/references/` 是 gitignore 的本地工作副本——本地能点开，克隆下来是死链 | 改成上游 URL，并写明它只在本地存在 |
| `deps-audit` | `pnpm install --frozen-lockfile` 失败：`PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL` | 根 `postinstall` 会跑 `prisma generate`，它要求 `DATABASE_URL` 存在；`ci.yml` 的 job 有前置 `cp .env.example .env`，这个 job 没有 | 该 job 改 `--ignore-scripts`：审计只需要依赖图，不需要生成的 Prisma Client |
| `smoke` | `bootstrap` 死在 seed：`Cannot find module '.../@rag/contracts/dist/index.js'` | **README 黄金路径在全新克隆上是坏的**。`seed.ts` import 工作区包的编译产物，而 `pnpm install` 的 postinstall 只跑 `prisma generate`、不构建；本地一直不复现只因为 `dist` 是历次 build 的残留 | `init-database.sh` 在 seed 前 `pnpm --filter "...@rag/database" run build`。让 bootstrap 自给自足，而不是往 README 里加一步——它对外的承诺就是"一条命令、可重复执行" |
| `analyze`（×2） | `Code scanning is not enabled for this repository` | private repo 的 code scanning 需要付费的 Code Security；个人账号 free plan 开不了 | job 加 `if: vars.ADVANCED_SECURITY_ENABLED == 'true'`（当时叫 `CODE_SCANNING_ENABLED`，§6.3 改名），skip 是灰色而不是红色（见 §3.3） |

`gitleaks（全历史密钥扫描）`、`node`、`compose` 三个 job 首跑即绿。其中 gitleaks 那个绿
在第五轮被证明是**廉价的绿**：它当时只扫了本次推送的提交，见 §6.5。

### 6.2 第二轮：quality 仍红——单测依赖未构建的工作区包

修完上表推第二次，`Integration`、`Security` 转绿，`CodeQL` 如期变灰，`CI` 里 `node` /
`python` / `compose` 也绿了，只剩 `quality` 红在覆盖率那一步：6 个测试文件加载失败，

```
Failed to resolve entry for package "@rag/config".
The package may have incorrect main/module/exports specified in its package.json.
```

报错把人指向 `package.json` 的 `exports` 字段，真正缺的却只是一次构建。跨包 import 由
vite 按 Node 规则解析到该包 `main`（`dist/index.js`），只有**当前**包的源文件才由 vitest
现场转译；`packages/*/dist` 不存在时这些 import 就断了。危险的地方在于它是**静默变少**
而不是明确报错的那 6 个文件：129 个测试只剩 80 个跑过。

为什么第一轮没看到：`quality` job 在 `check:links` 就退出了，根本没走到覆盖率。而
`node` job 一直是绿的——它的 `Typecheck` 步骤跑的是 `pnpm run typecheck`，而每个包的
`typecheck` **就是 `tsc -b`**（会 emit），顺手把 `dist` 造了出来。也就是说"测试需要先
构建"这条依赖被一个名字叫 typecheck 的步骤悄悄满足了。

两处一起修：

- `quality` job 在覆盖率前加一步 `pnpm --filter "./packages/*" run build`（冷启约 2s）。
  只构建 `packages/*`——`apps/*` 的测试 import 的是各自 `src`，不需要其 `dist`，也不必在
  这个 job 里跑 `next build`。
- `vitest.config.ts` 加载时先校验这些入口存在，不存在就抛一条能照着做的错误
  （列出缺哪些文件 + "先跑 `pnpm run build`"）。这条对本地同样有效：全新克隆里直接
  `pnpm test` 会命中它，而不是去查 `exports` 字段。

这是第一轮那三个真缺陷的第四个同源实例：**本地长期有历次构建的残留，掩盖了真实依赖。**

### 6.3 顺带查清：`dependency-review` 也永远不可能绿

三个 Dependabot PR 上 `dependency-review` 全是红的。查日志不是许可证或漏洞命中，而是

```text
Dependency review is not supported on this repository.
Please ensure that Dependency graph is enabled along with GitHub Advanced Security
```

和 CodeQL 同一个前置：private repo 要 Code Security / Advanced Security。已按同一个
仓库变量 `ADVANCED_SECURITY_ENABLED` 一起关掉（§3.3），顺手把原先只管 CodeQL 的
`CODE_SCANNING_ENABLED` 改成这个名字——两者要的是同一件东西，分成两个开关只会让人
以为能单独打开其中一个。这个变量还没被设过，改名零成本。

值得单独记一句的是**红在哪里**比红本身更要紧：CodeQL 挂在 push 上，dependency-review
挂在每个 PR 上——PR 恰恰是人真会盯着红叉看的地方，放一个永远红的检查在那儿，代价比
push 上的大。

三条可以带走的经验：

- **本地全绿证明不了新环境能跑起来。** 那三个真缺陷（死链、缺 `.env`、缺 `dist`）的
  共同点都是"本地有残留状态"。这正是 `integration.yml` 从干净 checkout 起容器的意义，
  也是为什么它值得那十分钟。
- **配置错也是收获。** `setup-uv@v10` 这种"看起来一定存在的浮动大版本"只有真跑一次
  才知道不存在，写文档写得再细也发现不了。
- **"修完了"要靠下一次真跑证明。** 第一轮的失败会把后面的步骤挡在门外，所以一轮全绿
  之前，"还剩几个问题"是不可知的——第二轮那个缺陷从一开始就在，只是排在死链后面。

### 6.4 第四轮（2026-09-02）：全绿之后主动审计，两个"还没机会红"的 P0

三轮修到全绿只证明**跑过的那些步骤是对的**，不证明该跑的都跑了，更不证明从没执行过的
工作流是对的。所以在全绿之后又做了一轮审计，找的正是这两类盲区。九项改动，两个 P0。

**P0-1：`check:commits` 十次运行一条提交都没检查。** 日志原文：

```text
✅ 提交信息检查通过（范围 origin/main..HEAD 内无非 merge 提交）
```

`actions/checkout` 在 push 到 main 时做的是 `git checkout -B main refs/remotes/origin/main`，
于是 `origin/main == HEAD`，`origin/main..HEAD` 恒为空——脚本按"没有可检查的提交"宣布
通过。一个自称在管提交规范的门禁，十次运行里检查了 0 条提交。这类缺陷比红叉危险：
红叉会被看见，空转不会。两处一起修——CI 在 push 上显式传
`${{ github.event.before }}..${{ github.sha }}`（PR 上仍走默认，那时区间就是 PR 的提交集），
脚本本身也不再允许"自动推导出的区间为空"当作通过，只有**显式传入**的空区间才算通过
（那是 CI 传来的真实情况：这次推送里只有 merge）。端点不可解析时（`main` 被 force push
过，`before` 已不可达）退化为检查最近一条并给出警告，而不是崩掉。

**P0-2：`release.yml` 的 guard 第一次跑就会死在 `uv: command not found`。** `verify` 链
第 9、10 环是 `py:sync` / `py:test`，两者都要 uv，而 `ubuntu-24.04` runner 镜像不预装它
（Package Management 段只有 cpan / Miniconda / Pip / Pipx / Yarn）。`ci.yml` 的 python job
有 `astral-sh/setup-uv`，release 的 guard 没有。这条到今天才被审出来的唯一原因是
**`release.yml` 从来没执行过**：0 个标签、0 次运行、145 行 YAML 没有一行跑过。

**P0-3（同一个文件）：手动派发会检出错的 ref。** `workflow_dispatch` 时 `github.ref` 是
默认分支而不是要发布的标签，三个 job 的 checkout 都没显式指定 ref——那样 guard 验的是
main、镜像从 main 构建、notes 从 main 的 CHANGELOG 抽，而 Release 挂在标签上。发出去的
产物和标签指向的代码不是一回事，比直接失败更糟。三处都改成
`ref: ${{ inputs.tag || github.ref }}`。

其余六项：

| 项 | 问题 | 修法 |
|---|---|---|
| 供应链 | 17 处 `uses:` 全是浮动 tag。tag 是可变引用，同一个 `@v7` 明天可以指向别的代码，而这些 action 在 CI 里拿得到 `GITHUB_TOKEN` | 全部钉 40 位 commit SHA，尾部保留 `# vX` 注释（Dependabot 认这个形式，会继续跟更新）。基线检查把"必须钉 SHA"变成硬门禁，Dependabot 的分组 PR 若换回浮动 tag 会当场红 |
| 定时扫 | `security.yml` / `codeql.yml` 的 concurrency group 不含事件名，周一定时扫和同时段推 main 落进同一组，`cancel-in-progress` 让 push 把定时扫取消掉——而定时扫的全部意义就是"代码不动也要重扫" | group 加 `-${{ github.event_name }}` |
| 定时扫 | `integration.yml` 没有周扫。它是全套里最 flaky 的一条（六个镜像、健康检查、内核参数），偏偏只有它完全靠"恰好有人提交" | 加每周一 03:41 UTC，与另两条错开时刻，不抢 runner |
| 镜像 | 构建成功不等于起得来。缺模块入口、非 root 用户读不到 `/opt/venv`、端口没人监听，全都能构建通过再在第一次 `docker run` 时失败 | 新增 [`check-parser-image.sh`](../../scripts/check-parser-image.sh)：等 HEALTHCHECK 变 healthy（预算 90s，镜像有 `--start-period=20s`），再从宿主机打一次 `/health/live`；容器提前退出就立刻报 exit code 并 dump 日志。`ci.yml` 对本地构建的镜像跑，`release.yml` 对**推送后的摘要**跑 |
| 工作流自身 | 仓库里 23 个 shell 脚本过 shellcheck，740 行工作流 YAML 一个检查都没有——而它偏偏最容易写错、最难在本地复现（`setup-uv@v10` 就是推上去才知道不存在） | 新增 [`check-workflows.sh`](../../scripts/check-workflows.sh)，两层，见下 |
| 覆盖率 | 全局阈值拦整体退化，拦不住"这次新增的没测"：仓库越大，一个全新未测文件对整体的拉低越小 | 新增 [`check-diff-coverage.sh`](../../scripts/check-diff-coverage.sh)，取 `git diff` 新增行 ∩ lcov 插桩行，阈值 80%，报未覆盖的具体行号 |

**工作流检查为什么分两层，以及它当场抓到了什么。** 第一版只有 actionlint，本地没装就
整段跳过——等于本地零检查，跟改之前没区别。于是补了一层只用 PyYAML 的基线检查，永远
跑：YAML 可解析、`needs` 指向存在的 job、`${{ steps.<id>.… }}` 引用存在的 step、`uses`
钉 40 位 SHA。这一层写完第一次跑，就抓到本批改动自己的一个错——`ci.yml` 里有个步骤名
写成（下面这行是错的示范，`run:` 后面跟了空格）：

```text
- name: 工作流 YAML 静态检查（actionlint + run: 块的 shellcheck）
```

名字里的 `run:` 加空格被 YAML 当成映射键，整个 `ci.yml` 不可解析。GitHub 上的表现是
Invalid workflow file，**四个 job 一个都不会跑**——而这批改动的其余部分正是为了让门禁
更严。修法是给整个字符串加引号。这件事本身就是这一层存在的理由：本地跳过、推上去才
报错，正是它要消除的那种反馈延迟。

actionlint 那一层在 CI 用 `--strict`：自行下载钉死版本（v1.7.12）的二进制并校验 sha256，
不执行上游的 install 脚本、也不接受浮动版本。"钉死上游"这条纪律不能只对 action 生效，
对检查工具自己也一样。

**明确不改的一项：`node` 的 `test` 与 `quality` 的 `test:coverage` 重复跑同 129 个测试。**
两个 job 并行，墙钟成本为零；合并会把测试结果耦合到 lint 门禁上，为省约 20s 计算换来
反馈独立性的退化，不值。

**仍然未验证的最大一块：`release.yml`。** 上面三个 P0 里有两个在它身上，说明"从没跑过
的代码就是没写对的代码"这条在这里已经应验一次。要真验证它，得推一个一次性的
`v0.0.1-rc.1` 预发布（`release-notes.sh` 要求 CHANGELOG 里有对应的 `## [版本]` 小节，
目前只有 `## [Unreleased]`），并且它会对外产出——GHCR 上的包和一个 GitHub Release。
这是需要单独决定的动作，不在本轮里顺手做。

### 6.5 第五轮（2026-09-02）：`gitleaks` 这个 required check 一直只扫两条提交

第四轮修完推上去，四条工作流全绿。接着去清理 GitHub 上那三个 Dependabot PR，顺手翻了
一眼它们为什么全红——**在这里撞到了本轮最严重的一个缺陷，而它不在任何计划里。**

`gitleaks（全历史密钥扫描）` 这个 job 在每个 PR 上都是红的，日志不是命中凭证，而是

```text
RequestError [HttpError]: Resource not accessible by integration
    at async Object.ScanPullRequest (.../gitleaks-action/v2/dist/index.js:129568:17)
```

`gitleaks/gitleaks-action` 在 `pull_request` 事件下改走 `ScanPullRequest`，要通过 API 读
PR 的提交列表；而工作流按最小权限只声明了 `contents: read`，默认 token 没有
`pull-requests` 权限，于是这一步直接抛异常。**它是 required check**——也就是说每个 PR
上都挂着一个不可能变绿的必需门禁，这已经是这套流水线里第三个"永远红"（前两个是 CodeQL
与 dependency-review，§3.3）。

顺着去看它在 main 上为什么反而是绿的，问题比 PR 那个更严重。同一天最后一次成功运行的
日志里，这个 action 自己拼出来的命令是：

```text
gitleaks cmd: gitleaks detect --redact -v --exit-code=2 --report-format=sarif
  --report-path=results.sarif --log-level=debug
  --log-opts=--no-merges --first-parent d16d56c^..bf2057f
INF 2 commits scanned.
```

**`2 commits scanned.`** 一个名字叫「全历史密钥扫描」的 job，实际只扫了本次推送里的
两条提交。checkout 那步的 `fetch-depth: 0` 确实把整个历史拉了下来（注释还写着"只扫当前
树等于假设'以前没提交过凭证'"），范围却被 action 自己的 `--log-opts` 收窄回去了。
也就是说：**从建立这条流水线到今天，仓库的全历史一次都没有被扫过**——而这个 job 存在的
全部理由，§2.3 里写得很清楚：「`.env` 被 gitignore」与「从没被提交过」是两件事，只有扫
全历史能确认。§3.3 里那句"private repo 开不了 Secret Protection，就靠 gitleaks 兜底
（它已扫全历史）"在当时是假的。

这和 §6.4 的 P0-1（`check:commits` 空转）是同一类缺陷，而且更隐蔽：那条至少在日志里
写明了"范围内无非 merge 提交"，这条在日志里写的是 `no leaks found`——一句完全正常的话。
**门禁的名字和它的实际行为之间没有任何东西在做校验。** 这一类只能靠读日志抓，抓不到的
唯一代价是"以为扫过了"。

修法是把 action 换成直接调二进制（[`scripts/check-secrets.sh`](../../scripts/check-secrets.sh)）：

- **不传 `--log-opts`**，遍历 HEAD 的全部祖先提交，三种触发事件下跑的是同一条命令；
- 用 `gitleaks git .` 而不是 `gitleaks detect`——后者自 v8.19.0 起废弃（仍能跑，但已从
  `--help` 隐掉），支持的三种模式是 `git` / `dir` / `stdin`；
- 版本（v8.30.1）与三个平台的 sha256 钉在脚本顶部，`--strict` 下才下载，与
  `check-workflows.sh` 对 actionlint 的处理完全一致；
- 不需要任何 token，所以 PR 上那个权限问题从根上消失，`permissions: contents: read`
  不用放宽；
- 顺带脱离了这个 action 的许可证策略。它的日志明确写
  `[Axwen] is an individual user. No license key is required.`——个人账号免费是真的，
  但迁到 organization 下就要 `GITLEAKS_LICENSE`，§5 里原先记的"届时再改"现在已经不需要了。

**明确不做工作区扫描**（不加 `--no-git`）。那样会扫到被 gitignore 的真 `.env`，而本机
有一份带真口令的 `.env` 是正常状态、不是缺陷；让 `verify` 因此变红，就是又造一个"永远红
所以被忽略"的门禁。git 忽略的文件进不了仓库，本就不在这条门禁的射程内。

**换之前先用 git 自己确认了一遍历史是干净的**，免得把一个从没扫过的历史直接交给 CI 去
判：46 条提交里出现过的 `.env` 类文件只有 `.env.example`；七个口令/密钥变量名的每一次
出现都在 `.env.example`、`compose.yml`、探针脚本或文档里（是变量名，不是值）；
`sk-or-v1-` / `sk-ant-` / `ghp_` / `github_pat_` / `AKIA` / `BEGIN * PRIVATE KEY` /
`xoxb-` / `AIza` 八类前缀在全历史里零命中。这只是抽样，不能替代 gitleaks 的 170 多条
规则——所以这一轮走 PR 而不是直推 main：让第一次真正的全历史扫描在 PR 上出结果，
main 的绿不受影响，同时正好验证了 PR 这条路径（那恰恰是原先必红的地方）。

**修的过程中又踩到第三个同类缺陷：新脚本被 `.gitignore` 静默吞了。** `.gitignore` 的机密
段里有一条刻意宽的 `*secret*`（连同 `credentials*`、`*.key`、`*.pem`），它把
`scripts/check-secrets.sh` 一起忽略掉了。两个后果，都不会在本地报错：

- `git add` 静默无效，推上去 CI 红在 `bash: scripts/check-secrets.sh: No such file or directory`；
- 更隐蔽的是 `check-shell.sh` 用 `git ls-files -- '*.sh'` 枚举脚本——**被忽略的文件它看不见**。
  加例外之前 `git ls-files -- '*.sh' | wc -l` 是 26，加之后是 27。也就是说本轮之前所有
  "shellcheck 通过（26 个脚本）"的绿，都不包含这个新脚本；shellcheck 从没读过它。

已在 `*secret*` 之后加 `!scripts/check-secrets.sh`（gitignore 里后写的规则胜出）并注明理由。
这条与前两条是同一个形状：**枚举式的门禁只对它枚举到的东西负责，而"枚举到了什么"从不打印
在日志里。** 27 和 26 的差别，日志里两次都只写"通过"。

**第四个：把 `check:secrets` 串进 `verify`，顺手在 `release.yml` 里埋了一颗新雷。**
`release.yml` 的 guard 重跑全量 `verify`，而它的 checkout 没写 `fetch-depth`——默认是 1，
浅克隆。`check-secrets.sh` 第一件事就是判浅克隆并失败，于是**第一次推 `v*` 标签仍然会死在
guard 上**，只是死因从 §6.4 的 `uv: command not found` 换成了"当前是浅克隆"。同一个 job、
同一个原因：它从没执行过。

这次没有靠"想起来"：把这条不变量加进了基线层——**任何 job 只要 `run:` 里出现
`check:secrets` / `check:commits` / `pnpm run verify`，它的每个 `actions/checkout` 就必须
显式写 `fetch-depth: 0`**（`scripts/lib/lint-workflows.py` 第 5 条规则）。加完当场报出
`release.yml job guard: 跑了 ['pnpm run verify']（需要全历史），但 checkout 的
fetch-depth 是 None`，并且临时删掉修复再跑一遍确认它真的会红。这是这一轮里唯一一条
**在被写成文档之前就先被写成检查**的结论。

一条要带走的经验，和 §6.3 那三条并列：

- **绿也要看是怎么绿的。** 一个门禁报绿有两种可能——它检查了并且通过，或者它其实没检查。
  这两者在日志里长得一模一样，区别只在那些没人读的细节行里（`2 commits scanned.`、
  `范围 origin/main..HEAD 内无非 merge 提交`）。两轮审计里最严重的三个问题全属于这一类，
  没有一个是靠"看红叉"发现的。



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
