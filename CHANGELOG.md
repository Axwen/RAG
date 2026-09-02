# Changelog

本项目所有显著变更记录在此。格式参考 Keep a Changelog，版本按票据批次推进。

## [Unreleased]

### Added

- **CI/CD 与质量·日志检测流水线**（五条工作流，见
  [docs/engineering/ci-cd.md](docs/engineering/ci-cd.md)）：
  - `ci.yml` 扩为四个 job——`node`（lint/typecheck/test/prisma/build）、
    新增 `quality`（shellcheck `--strict`、Markdown 链接、提交信息规范、覆盖率并上传报告）、
    `python`、`compose`。
  - `integration.yml`（新）：真起六个 core 容器 → `bootstrap` **跑两遍**验证幂等 →
    `build` → `smoke:api`；失败时按 `::group::` 打包 `.smoke/api.log`、`compose ps`
    与容器日志尾部，`infra:down` 在 `always()`。
  - `security.yml`（新）：gitleaks 密钥扫描（配置 `.gitleaks.toml`；**2026-09-02 起**
    才真的扫全历史，见下方 Fixed）、
    `pnpm audit`（critical 阻断 / high 只报告，避免无修复版本的传递告警堵死所有 PR）、
    PR 依赖变更审查（high 阻断，拒绝 AGPL/SSPL）。
  - `codeql.yml`（新）：TS + Python 双语言 `security-and-quality`，每周定时；
    暂不设为 required check。
  - `release.yml`（新）：推 `v*` 标签触发，先重跑全量 `verify` 与标签↔CHANGELOG 对齐
    校验，再把 Parser 镜像推 GHCR（provenance + SBOM）并建 GitHub Release。
    **不含部署**，也不构建 api/web/worker 镜像（三者尚无 Dockerfile）。
  - 配套：`.github/dependabot.yml`（npm 分组 / uv / actions / docker，其中
    `xgboost >=3.1` 按 PROBE-002 的二进制模型显式忽略）、`CODEOWNERS`、PR 模板。
- **进程级冒烟与日志检测** `pnpm run smoke:api`（`scripts/smoke-api.sh`）：用编译产物真起
  进程打真实 HTTP，断言 31 项——T1a 端点状态码与五字段信封、内容寻址幂等、
  未定义路由与畸形 JSON 走信封、`traceparent` 严格校验、响应体不含堆栈；再对进程
  stdout 断言"每行都是带 `level/time/service` 的 JSON"、存在 `nest:true` 行，
  以及 `.env` 中七个口令/密钥与 `DATABASE_URL` 口令均未出现在输出里。
  单测直接 `new` 领域服务、绕过 NestJS DI，抓不到"进程起来了但每个请求都 500"这类回归。
- **`pnpm run check:shell`**（`scripts/check-shell.sh`）：对 `git ls-files` 里的 18 个
  shell 脚本与 Compose init 脚本跑 shellcheck（`--severity=warning --external-sources`）；
  本地缺 shellcheck 只警告，CI 的 `--strict` 视为硬失败。
- **`pnpm run check:commits`**、**`pnpm run test:coverage`**、
  **`scripts/release-notes.sh`**（从 CHANGELOG 抽取指定版本段落，标签与 CHANGELOG
  不对齐即失败）。
- **覆盖率阈值**（`vitest.config.ts`）：statements 86 / branches 81 / functions 82 /
  lines 86。取自 2026-09-01 实测（87.15 / 82.43 / 83.16 / 87.83，已排除 Prisma 生成
  产物、`apps/web`、种子脚本）。这是棘轮值而非理想值，只上调。
- **三条新增门禁**（第四轮审计产出，见 ci-cd.md §6.4）：
  - **`pnpm run check:workflows`**（`scripts/check-workflows.sh` + `scripts/lib/lint-workflows.py`）：
    工作流 YAML 的静态检查，两层。基线层只用 PyYAML、永远跑——YAML 可解析、`needs` 指向
    存在的 job、`${{ steps.<id>.… }}` 引用存在的 step、`uses` 必须钉 40 位 SHA、跑
    `check:secrets` / `check:commits` / `verify` 的 job 必须显式写 `fetch-depth: 0`
    （第 5 条规则是第五轮补的，见下方 Fixed）；
    actionlint 层本地缺则警告，CI 用 `--strict` 下载钉死版本（v1.7.12）并校验 sha256。
    仓库里 23 个 shell 脚本一直过 shellcheck，而 740 行工作流此前零检查。
  - **`pnpm run check:diff-coverage`**（`scripts/check-diff-coverage.sh`）：增量覆盖率，
    取 `git diff` 新增行 ∩ `coverage/lcov.info` 插桩行，阈值 80%，失败时直接给未覆盖的
    行号。全局阈值拦整体退化，拦不住"这次新增的没测"。
  - **`pnpm run check:parser-image`**（`scripts/check-parser-image.sh`）：构建完真
    `docker run` 一次——等 HEALTHCHECK 变 healthy（预算 90s），再从宿主机打
    `/health/live`；容器提前退出立刻报 exit code 并 dump 日志与 `State`。
    `ci.yml` 对本地镜像跑，`release.yml` 对推送后的摘要跑。
- **`pnpm run check:secrets`**（`scripts/check-secrets.sh`，第五轮审计产出，见 ci-cd.md
  §6.5）：gitleaks 扫所有引用可达的提交（它默认走 `--all`），本地与 CI 同一条命令。取代
  `gitleaks/gitleaks-action`——后者按事件名自行收窄范围。用 `gitleaks git`（`detect` 自
  v8.19.0 起废弃），版本 v8.30.1 与三个平台 sha256 钉在脚本顶部，本地缺则警告、
  CI 用 `--strict` 下载并校验。明确**不**扫工作区：那样会命中被 gitignore 的真 `.env`，
  而本机有一份带真口令的 `.env` 是正常状态。脚本打印的条数用 gitleaks 自己那组默认参数数
  （`--name-only` 代替 `-p`），与它的 `N commits scanned.` 严格一致——中间打错过两次，
  先少算（漏 `--all`：47 vs 49）后多算（`pull_request` 的 `refs/pull/<n>/merge` 是合并提交，
  `git log -p` 不给补丁所以 gitleaks 不计：54 vs 53）。已知盲点也一并记在 ci-cd.md §2.3：
  **只在冲突解决里引入的凭证扫不到**（合并提交无补丁，而加 `--log-opts -m` 会把 `--all`
  连带丢掉）；main 走 rebase 保持线性，实际风险很小。
- **`integration.yml` 每周一 03:41 UTC 定时全量**：它是全套里最 flaky 的一条（六个镜像、
  健康检查、内核参数），此前是唯一没有周扫、完全靠"恰好有人提交"的工作流。

——租户（`Tenant`）、知识空间
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
- **DX-T6**：DX 基线测量脚本 `pnpm run dx:baseline`（`scripts/dx-baseline.sh`）——量
  `install`/`verify`/`infra:up`/`bootstrap` 与「起 API 到 `/health/ready` 200」的耗时，
  给出目标判定（verify ≤20s、TTHW <120s）并把结果写成 `.dx-baseline/latest.json`
  供前后对比。默认热态非破坏；阶段失败才退出非 0，超目标只 ⚠️（`--strict` 可当门禁）；
  `--cold`（删数据卷与 `node_modules`）必须再加 `--yes-destroy-data`。
  据此跑完 /plan-devex-review boomerang 复测：
  [报告](docs/engineering/plan-devex-review-20260901-boomerang.md)，DX 6/10 → 8/10。

### Fixed

- **第五轮审计（2026-09-02）：`gitleaks（全历史密钥扫描）` 从建立起就只扫两条提交**
  （完整记录见 [docs/engineering/ci-cd.md](docs/engineering/ci-cd.md) §6.5）。这条门禁（§3
  清单里列为 required——实际因分支保护开不了而从未生效，见下）有两个独立缺陷，起因都是 `gitleaks/gitleaks-action` **按事件名自行决定扫描范围**：
  - **push 上名不副实**：它拼出 `--log-opts=--no-merges --first-parent <before>^..<sha>`，
    日志原文 `INF 2 commits scanned.`——`checkout` 的 `fetch-depth: 0` 把历史拉全了，范围
    又被收窄回去。于是 ci-cd.md §3.3 里"Secret Protection 开不了就靠 gitleaks 兜底"这句话
    在此之前**并不成立**：全历史一次都没被扫过，`.env` 有没有进过历史无从确认。
  - **PR 上永远红**：同一个 action 在 `pull_request` 改走 `ScanPullRequest`，要读 PR 的提交
    列表，而工作流只给 `contents: read`，直接
    `RequestError [HttpError]: Resource not accessible by integration`。三个 Dependabot PR
    上的红叉即此——继 CodeQL、dependency-review 之后第三个"永远红"的门禁。
  改为 `scripts/check-secrets.sh` 直接调二进制：**不传 `--log-opts`**——gitleaks 默认跑
  `git log -p -U0 --full-history --all --diff-filter=tuxdb`，传了 `--log-opts` 这三个默认
  遍历参数就被整个丢掉（`sources/git.go`），action 走的正是后者。不传于是遍历所有引用可达
  的提交，三种事件下同一条命令；浅克隆显式报错（`git rev-parse --is-shallow-repository`）；
  `--exit-code 2` 把"检出凭证"与"工具自身失败"分开；`--redact` 保证命中值不进公开日志。
  同时修掉 `security.yml` 里那个"全历史 + 工作区"的步骤名——工作区扫描是刻意不做的。
  - **附带修掉第三个同类缺陷**：`.gitignore` 里刻意宽的 `*secret*` 把新脚本
    `scripts/check-secrets.sh` 一起忽略了。除了 CI 会红在 `No such file or directory`，
    更隐蔽的是 `check-shell.sh` 用 `git ls-files -- '*.sh'` 枚举脚本，**被忽略的文件它
    看不见**——加例外前是 26 个，加后 27 个，此前所有"shellcheck 通过"的绿都不含这个脚本。
    已加 `!scripts/check-secrets.sh` 例外。
  - **`release.yml` 的 guard 会死在浅克隆上**：把 `check:secrets` 串进 `verify` 之后，
    guard 重跑全量 `verify` 而它的 checkout 没写 `fetch-depth`（默认 1），
    `check-secrets.sh` 判浅克隆即失败——第一次推 `v*` 标签仍然会死在 guard，只是死因从
    上一轮的 `uv: command not found` 换成"当前是浅克隆"。已补 `fetch-depth: 0`，并把这条
    不变量加进工作流基线层：**任何 job 只要 `run:` 里出现 `check:secrets` /
    `check:commits` / `pnpm run verify`，它的每个 `actions/checkout` 都必须显式写
    `fetch-depth: 0`**（`scripts/lib/lint-workflows.py` 第 5 条规则，加完当场报出这处
    并用负例验证过会红）。
  - **文档里的第一条手工配置根本做不到**：ci-cd.md §3 第 1 条一直写着"设分支保护 +
    把六个 job 设为 required check"，实测
    `gh api repos/Axwen/myRAG/branches/main/protection` 返回
    `403 Upgrade to GitHub Pro or make this repository public to enable this feature.`
    ——个人账号的 private repo 开不了分支保护。也就是说 main 上没有任何保护、required
    checks 一条都没生效，而文档的写法容易让人以为已经配好了。已把那一节明确标成
    **目标态而非现状**，写清两条真实出路（改公开 / 升级个人 Pro），并说明在此之前只能
    靠"走分支 + PR"的纪律代替——纪律拦不住手误直推。与本轮其余各项同一个模式：
    **写下来的门禁和生效的门禁是两件事。**

- **CI 全绿之后的第四轮主动审计（2026-09-02）：两个"还没机会红"的 P0**（完整记录见
  [docs/engineering/ci-cd.md](docs/engineering/ci-cd.md) §6.4）：
  - **`check:commits` 在十次 CI 运行里检查了 0 条提交**。日志原文
    `✅ 提交信息检查通过（范围 origin/main..HEAD 内无非 merge 提交）`——`actions/checkout`
    在 push 到 main 时做 `git checkout -B main refs/remotes/origin/main`，于是
    `origin/main == HEAD`，区间恒为空，脚本按"没有可检查的提交"宣布通过。空转比红叉
    危险：红叉会被看见。现在 CI 在 push 上显式传
    `${{ github.event.before }}..${{ github.sha }}`（PR 上仍走默认），脚本也不再允许
    **自动推导**出的空区间当作通过，只有显式传入的空区间才算（那是"这次推送里只有
    merge"的真实情况）；区间端点不可解析时（`main` 被 force push，`before` 已不可达）
    退化为检查最近一条并警告，而不是崩掉。
  - **`release.yml` 第一次推标签就会死在 `uv: command not found`**：guard 重跑全量
    `verify`，其第 9、10 环 `py:sync` / `py:test` 都要 uv，而 `ubuntu-24.04` runner
    不预装（Package Management 段只有 cpan/Miniconda/Pip/Pipx/Yarn）。已补
    `astral-sh/setup-uv`，版本与 `ci.yml` 的 python job 一致。这条到今天才发现的唯一
    原因是**该工作流从未执行过**：0 个标签、0 次运行、145 行 YAML 没有一行跑过。
  - **`release.yml` 手动派发会检出错的 ref**：`workflow_dispatch` 时 `github.ref` 是默认
    分支而非要发布的标签，三个 job 的 checkout 都没指定 ref——guard 验 main、镜像从 main
    构建、notes 从 main 的 CHANGELOG 抽，而 Release 挂在标签上。产物与标签指向的代码
    不是一回事，比直接失败更糟。三处改为 `ref: ${{ inputs.tag || github.ref }}`。
  - **17 处 `uses:` 全部由浮动 tag 改为 40 位 commit SHA**（尾部保留 `# vX`，Dependabot
    认这个形式）。tag 是可变引用，而这些 action 在 CI 里拿得到 `GITHUB_TOKEN`。
    "必须钉 SHA"同时成为 `check:workflows` 基线层的硬门禁。
  - **周一定时扫会被同时段的 push 取消**：`security.yml` / `codeql.yml` 的 concurrency
    group 不含事件名，两者落进同一组后 `cancel-in-progress` 取消掉定时扫——而定时扫的
    全部意义就是"代码不动也要重扫"。group 加 `-${{ github.event_name }}`。
  - **`ci.yml` 差点整个文件不可解析**：新加的步骤名里有裸的 `run:` 加空格，YAML 会把它
    当成映射键，GitHub 上表现为 Invalid workflow file、四个 job 一个都不跑。这个错是新
    加的基线检查自己抓到的（本地当场，而不是推上去之后），也正是它存在的理由。
  - **`check-parser-image.sh` 的诊断顺序**：容器退出时 HEALTHCHECK 也会被记成 unhealthy，
    先判健康状态就会把"进程压根没起来"报成"健康检查失败"，指向完全不同的排查方向。
    改为先看 `.State.Running`。

- **CI 首跑（2026-09-02）抓到的五个真缺陷**（两轮修完，完整记录见
  [docs/engineering/ci-cd.md](docs/engineering/ci-cd.md) §6）：
  - **README 黄金路径在全新克隆上是坏的**：`bootstrap` 的 seed 步骤跑 `tsx prisma/seed.ts`，
    而 `seed.ts` import 的是 `@rag/contracts` 的**编译产物**；`pnpm install` 的 postinstall
    只跑 `prisma generate`、不构建，于是干净 checkout 上必然 `Cannot find module
    '.../@rag/contracts/dist/index.js'`。本地一直不复现只因为 `packages/*/dist` 是历次
    build 的残留。`init-database.sh` 现在在 seed 前跑
    `pnpm --filter "...@rag/database" run build`（前置 `...` 选中该包及其工作区依赖，
    三个包，不碰 `apps/web`；`tsc -b` 增量，二次执行 6s）。修的是 bootstrap 而不是 README：
    它对外的承诺就是"一条命令、可重复执行"，把前置条件推给读者等于把坑留给下一个新人。
  - **`PROJECT_STATE.md` 的参考仓库链接是死链**：指向 `references/ragent/`、
    `references/ragflow/`，而 `/references/` 是 gitignore 的本地工作副本——本地能点开，
    克隆下来打不开。改为上游 URL 并写明只在本地存在。`check:links` 首跑即命中。
  - **`security.yml` 的 audit job 装不上依赖**：根 `postinstall` 的 `prisma generate` 要求
    `DATABASE_URL`（`PrismaConfigEnvError`），而该 job 没有 `ci.yml` 里那步
    `cp .env.example .env`。改用 `--frozen-lockfile --ignore-scripts`——审计读 lockfile，
    不需要生成出来的 Prisma Client。
  - **`astral-sh/setup-uv@v10` 不存在**：这个 action 自 v8 起不再发布浮动大版本标签
    （只有 `v10.0.1` / `v10.0.0`），`python` job 连 Set up job 都没过。已钉
    `@v10.0.1`；`python-version` 从 `3.12.3` 放宽到 `3.12`，与
    `requires-python = "==3.12.*"` 同口径，不再和 Dockerfile 的补丁位互相牵制。
  - **`pnpm test` 在全新克隆上少跑 49 个测试**（第二轮抓到，与 seed 那条同源）：跨包
    import 由 vite 解析到该包 `main`（`dist/index.js`），只有当前包的源文件才由 vitest
    现场转译，所以 `packages/*/dist` 不存在时 6 个测试文件直接加载失败——129 个测试静默
    只剩 80 个，而报错写的是"`package.json` 的 exports 可能不对"。`quality` job 首轮死在
    `check:links`、没走到覆盖率，`node` job 则一直是绿的：它的 `Typecheck` 步骤跑
    `tsc -b`（会 emit），把"测试需要先构建"这条依赖悄悄满足了。现在 `quality` job 在
    覆盖率前加 `pnpm --filter "./packages/*" run build`（冷启约 2s，`apps/*` 的测试
    import 各自 `src`、不需其 `dist`），并由 `vitest.config.ts` 在加载时校验这些入口
    存在、缺失即报出"先跑 `pnpm run build`"——本地全新克隆同样受这条保护。
- **CodeQL 与 dependency-review 在 private repo 上必然红**：两者都要求
  Code Security / Advanced Security，实测报错分别是 `Code scanning is not enabled for
  this repository` 与 `Dependency review is not supported on this repository`（后者是
  三个 Dependabot PR 上一起红的那条）。永远红的检查只会训练人忽略红叉，而
  dependency-review 挂的位置更糟——PR 恰恰是人真会盯着红叉看的地方。两个 job 现在共用
  一个仓库变量 `if: vars.ADVANCED_SECURITY_ENABLED == 'true'`，未开启时 skip（灰色）
  而不是失败；按"根因"命名而不是各起一个开关，因为它们要的是同一件东西。个人账号下的
  private repo 买不到该产品（面向组织与企业），唯一确定可行的启用路径是把仓库设为
  public，见 ci-cd.md §3.3。

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

- **NestJS 框架日志绕过脱敏**（写冒烟断言时发现）：应用日志走 `@rag/observability` 的
  pino（带不可关闭的 redact），但框架自身的日志走 `ConsoleLogger` 的彩色纯文本，
  既不经过 redact——框架级异常栈可能含连接串或鉴权头——也破坏了「进程输出每行都是
  结构化 JSON」这条日志契约。现在 `main.ts` 装 `NestPinoLogger`
  （`apps/api/src/common/nest-logger.ts`）把六个级别映射到 pino，并带 `nest: true` 标记。
  非字符串消息放进 `payload` 字段而不是 `JSON.stringify` 进 `msg`：redact 只作用于
  对象字段，拼成字符串就永久绕过脱敏（`apps/api/test/nest-logger.test.ts` 用真实密钥
  形态的对象断言这一点）。冒烟同时断言存在 `nest:true` 行，`useLogger` 被移除即失败。
- **`trace_id` 与日志行的关联此前只是声明**：`INTERNAL_ERROR` 契约里「细节不外泄、
  用户手里只剩一个能反查日志的标识」有一半无法从响应体自证。`GlobalExceptionFilter`
  现允许注入 logger（仅为可测，生产不传参），测试把日志写进内存流并断言：响应体
  `message` 不含连接串、同一次异常只产生一行错误日志、该行 `traceId` 等于信封的
  `trace_id`、原始文本在 `err` 字段里；另断言 4xx **不写**错误日志（鉴权拒绝不该污染
  错误日志）。
- **六个探针脚本的 shellcheck 指令无效**：`# shellcheck source=/dev/null` 写在
  `set -a; . "$ENV_FILE"; set +a` 这行复合命令之上时只绑定到 `set -a`，SC1090 仍然报。
  已拆成四行，指令直接贴在 `.` 之上。

### 首次领域迁移说明

`packages/database/prisma/migrations/<timestamp>_t1a_core_domain/` 是仓库第一份
领域迁移。已有 T0 环境执行 `pnpm run bootstrap`（内部 `prisma migrate deploy`）
即可升级，幂等可重跑；全新环境按 README 黄金路径从零开始。回滚不在阶段 1
范围内——Manifest/Release 是追加式事实表，请勿手工删改。
