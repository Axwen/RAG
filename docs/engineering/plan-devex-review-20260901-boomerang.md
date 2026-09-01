# /plan-devex-review boomerang — T1a 后 DX 复测（2026-09-01）

> 复测对象：[/plan-devex-review 2026-08-28](plan-devex-review-20260828.md)（总体 DX 6/10，
> 完成状态 DONE_WITH_CONCERNS）。退场条件出自[工程评审闭合记录 §16](plan-eng-review-closure.md)：
> 「T1a 合并后 /plan-devex-review boomerang 复测 TTHW <2 min、verify <20 s」。
> 本次在 commit `1b2a2ed`（T1a 已提交）上复测，口径由 `scripts/dx-baseline.sh`（devex T6）固定。

## 结论先行

总体 DX **6/10 → 8/10**，两个退场条件都达成：TTHW **7.3–11.0s**（目标 <120s）、
verify **17.0–22.5s**（目标 ≤20s：热缓存 17.0–17.6s 达成，冷缓存首次 22.5s 超 12%）。
三个 P1 缺口（`.env` 手工注入、无环境预检、HTTP 错误无信封）已在 T1a 批次内闭合，且各有测试钉住。

DX 度量 4/10 → 8/10 的理由不是数字变好，而是**数字变成可复跑的**：原评分扣在
「T0 DX 为一次性手工实测，不可复跑」，现在 `pnpm run dx:baseline` 一条命令重出全部指标，
并落一份机读 JSON 供前后对比。

**状态：CLEARED WITH MINOR CONCERNS。** 剩余四项见 §5：T5 CONTRIBUTING 未做、
T7 worker 单命令未做、CI 从未真实运行（无 git 远端，用户动作）、冷启动 TTHW 未实测（会删本地开发库）。

## 1. 复测数据（本机 WSL2，Node v22.23.1，pnpm 10.34.5）

四次连续热态测量（`pnpm run dx:baseline`，容器已在跑、依赖已装）：

| 阶段 | 第 1 次 | 第 2 次 | 第 3 次 | 第 4 次 | T0 参考（2026-08-28 手工） | 目标 |
|---|---:|---:|---:|---:|---:|---|
| `install`（`--frozen-lockfile`） | 2.7s | 1.6s | 1.6s | 1.5s | 0.68s | — |
| `verify` 全链 | 22.5s | 17.6s | 17.4s | 17.0s | 19.1s | ≤20s |
| `infra:up`（含 preflight） | 1.8s | 1.5s | 1.5s | 1.5s | 0.88s | — |
| `bootstrap`（幂等） | 7.6s | 5.5s | 5.2s | 4.9s | 5.1s | — |
| `api_ready`（起进程到 `/health/ready` 200） | 1.6s | 1.3s | 0.9s | 1.0s | 未单独计时 | — |
| **TTHW** = `infra:up` + `bootstrap` + `api_ready` | **11.0s** | **8.3s** | **7.6s** | **7.3s** | 3–5 min（含人手操作） | <120s |

测试规模：15 个文件 / 122 条，四次一致。`/health/ready` 每次六项依赖全 `up`。

`verify` 子步骤单独计时（每项含一次 `pnpm` 启动开销）：

```text
format 1.1s  lint 1.0s  typecheck 3.4s  test 4.8s  build 4.7s
db:validate 1.0s  py:sync 0.2s  py:test 0.7s  compose:config 0.4s   合计 17.3s
```

第 1 次 22.5s 与后三次 17.0–17.6s 的差别出现在「刚把全部子步骤各跑过一遍」之后，
与 `tsc -b` / vitest 增量缓存的冷热一致，但没做受控实验证明因果。按现状口径：
改一行代码后的反馈回路约 **17.5s**，缓存冷的首次约 **22.5s**。没有单一热点步骤，
真要压到 15s 以内只能动 `test`+`build`（9.5s，占 55%）。

T0 的 TTHW 3–5 min 是含人手操作的墙钟估计，本次 7.3–11.0s 是纯命令耗时；
两者不同口径，能对齐的结论是「黄金路径本身远在 <2 min 目标内，剩下的时间都花在人身上」。

## 2. 三个 P1 的闭合证据

| 原缺口 | 实现 | 复测中的直接证据 |
|---|---|---|
| F1 `.env` 每个新终端手工 `source` | DX-T1 `preloadRootEnv()`，API/Worker 入口各调一次 | 本次测量的 shell 未导出 `DATABASE_URL`/`POSTGRES_PASSWORD`/`KEYCLOAK_*`（实测 `env` 计数为 0），API 仍在 0.9–1.6s 内就绪。脚本还加了有效性守卫：`DATABASE_URL` 已在环境里时打 ⚠️，说明该次结果不构成这条证据——否则一个 `source` 过的终端会把这条证据悄悄伪造掉 |
| F2 Docker 未开时只有原始报错 | DX-T2 `scripts/check-env.sh`，并入 `infra:up` 前置 | `infra_up` 阶段每次先跑 preflight 六项；uv 缺失只降 ⚠️ 不阻断（本批次修复项 7） |
| F4 HTTP 层无错误信封 | DX-T3 五字段信封 + 全局过滤器 + [错误码文档](error-codes.md) | `verify` 内的 122 条测试含信封契约、`traceparent` 复用与鉴权状态码双射（本批次修复项 1） |

## 3. 八轮重评分

| 维度 | 原分 | 新分 | 依据 |
|---|---:|---:|---|
| 上手体验 | 7 | 9 | README 黄金路径整块可复制、`.env` 自动预载、preflight 给修复指引；TTHW 实测 7.3–11.0s |
| API/CLI/SDK | 5 | 7 | 有了统一信封、内容寻址幂等键与领域命令端点（无通用 `PATCH status`）；仍无 API 参考文档与分页约定（端点还少，T5/T7 之后的票才需要） |
| 错误消息 | 6 | 8 | HTTP 层达 Tier 2（code/message/param + `doc_url` 锚点均存在）；`INTERNAL_ERROR` 不外泄堆栈，日志与响应共享 `trace_id` |
| 文档 | 7 | 8 | 新增 CHANGELOG（含首次领域迁移说明）、错误码文档；仍无 API 参考 |
| 升级迁移 | 4 | 7 | CHANGELOG 与迁移说明章节到位，首份迁移由 `bootstrap` 幂等应用；回滚仍按追加式事实表处理（阶段 1 不做） |
| 开发环境 | 8 | 8 | verify 17.0–17.6s 同口径可复跑，dev 入口转译器与监听方式由测试钉住；**CI 仍从未真实运行**，扣分点未变 |
| 社区生态 | 2 | 2 | T5 最小 CONTRIBUTING 未做，私有仓库，非优先 |
| DX 度量 | 4 | 8 | 本次的全部数字由 `pnpm run dx:baseline` 产出，带 JSON 与目标判定；缺的是跨机器/CI 上的历史趋势 |

**Overall DX 8/10**（简单均值 7.1，社区维度按内部团队权重下调；主体是开发环境 + 上手体验 + 错误消息）。

## 4. 原任务表状态

| # | 任务 | 状态 |
|---|---|---|
| T1 | README 黄金路径 + 自动预载根 `.env` | ✅ T1a 批次 |
| T2 | 环境预检脚本 | ✅ T1a 批次 |
| T3 | 统一 API 错误信封 + 全局过滤器 | ✅ T1a 批次 |
| T4 | CHANGELOG + 迁移说明章节 | ✅ T1a 批次 |
| T5 | 最小 CONTRIBUTING.md（分支/DoD/verify） | ⬜ 未做（P2，自由安排） |
| T6 | DX 基线脚本化 + boomerang 复测 | ✅ 本次（`scripts/dx-baseline.sh`、`pnpm run dx:baseline`、本报告） |
| T7 | worker dev 单命令口径 | ⬜ 未做（P3） |

## 5. 遗留与退场条件

- **冷启动 TTHW 未实测。** `--cold` 需 `docker compose down -v` + `rm -rf node_modules`，
  会删掉本地开发库——当前库里有 HG-01 的验收运行数据。退场：HG-01 验收结论落定后重建 volume 时，
  或在一次性克隆里跑 `bash scripts/dx-baseline.sh --cold --yes-destroy-data`。
  默认模式永不破坏，`--cold` 缺 `--yes-destroy-data` 直接退出 2。
- **verify 冷缓存首次 22.5s，超 ≤20s 目标 12%。** 现在只是 ⚠️、不阻断。要把它当门禁得先裁决口径：
  用 `--strict` 且目标放宽到 25s（承认缓存冷热的方差），还是把 `build`/`test` 从 verify 拆到另一条命令
  （反馈回路更短但 CI 与本地口径分叉）。这是需要用户拍板的取舍，本报告不代裁。
- **CI 从未真实运行**（仓库无 git 远端，用户动作）。建远端后首次 push 是硬验证点，与本次复测无关。
- **T5 / T7 未做**，分别压住社区生态与 worker 单命令口径两处小摩擦。
- **测量只覆盖一台机器（本机 WSL2）**。JSON 里带 `host`/`node`/`pnpm`/`commit`，跨机器对比要各自跑一次。
