# /plan-devex-review — 可信 RAG Monorepo 阶段 1 开发体验计划复审

> **落盘说明(2026-08-28)**:本报告由 /plan-devex-review 于 2026-08-28T05:47Z(commit f0a7d6a)产出,当时仅在会话输出中呈现、未写入仓库,`~/.gstack` 只留有 JSONL 摘要(score 5→6、TTHW 3-5min→目标 <2min、mode POLISH)。用户于 2026-08-28 下午提供全文,此处落盘存档。结论与任务已按用户裁决并入 T1a 批次(见 [工程评审闭合记录 §16](plan-eng-review-closure.md))。

## 结论先行

总体 DX 6/10:T0 的开发者反馈回路是真实优势(实测 verify 全链 19.1s、bootstrap 5.1s 幂等),但三个 P1 缺口会在 T1a 起的业务票据上放大——.env 手工注入、无环境预检、API 错误信封无约定。现在修成本最低,拖到 T5/T7/T8 加端点后就是返工。

本复审基于两类证据:实测(安装 0.68s、verify 19.1s 全绿、infra:up 0.88s、bootstrap 5.1s 幂等)+ 文件审读(README/CI/.env.example/各包错误消息/票据 DoD)。

## 决策简报(D1–D13,均按推荐项执行)

- D1 开发者画像:内部全栈/平台工程师,加入团队后需独立跑起本地全栈
- D2 共情叙事:准确,细节见旅程地图
- D3 竞争档位:热环境 3–5 分钟(Competitive 档)已是现实;黄金路径目标 <2 min(Champion 档)
- D4 魔法时刻:infra:up → bootstrap → api dev 后看到 /health/ready 200 全绿;载体为复制即用命令
- D5 模式:DX POLISH——T0 刚落地,范围正确,把每个触点打磨到无摩擦,不加范围
- D6–D12:见各 Pass 决策
- D13 困惑报告:全部采纳 P1 项(#1 .env、#2 预检、#4 API 错误信封)

## 开发者画像卡

```text
TARGET DEVELOPER PERSONA
========================
Who:       内部全栈/平台工程师,刚加入 RAG 团队
Context:   从干净检出开始,独立跑起 API/Web/Worker + 六个中间件
Tolerance: 10-15 分钟;超过即找同事,不读长文档
Expects:   一条命令能起来、health 全绿、错误直接告诉怎么修
```

## 旅程地图与摩擦

```text
STAGE     | 开发者动作                          | 摩擦                        | 状态
----------|-------------------------------------|-----------------------------|---------
1 发现    | 读 README / PROJECT_STATE           | 无快速开始块,需拼命令       | 待修(T1)
2 安装    | pnpm install --frozen-lockfile      | 无;19.5s 冷/0.68s 热        | OK
3 配置    | cp .env.example .env                | 应用不自动读 .env,每终端重复 | 待修(T1)
4 Hello   | infra:up + bootstrap + api dev      | 无 Docker 预检,报错不友好   | 待修(T2)
5 真使用  | 改代码 → verify 19.1s 全链          | 无;反馈回路是最大优势       | OK
6 调试    | LOG_LEVEL=debug + tsx watch         | 无;配置错误已给修复提示     | OK
7 升级    | 依赖/迁移                           | 无 CHANGELOG、无迁移说明    | 待修(T4)
```

首次开发者困惑:T+1:00 遇到 `set -a; source .env; set +a` 不理解为何应用不自己读;T+2:00 Docker 未开时只看到 docker 原始报错;成功后每开新终端都要重做 source。

## 八轮评分

| 维度 | 分 | 关键证据与差距 |
|---|---|---|
| 上手体验 | 7/10 | README 准确、实测快;缺整块黄金路径(F1)、.env 手工注入(F1)、Docker 预检(F2) |
| API/CLI/SDK | 5/10 | 仅 health 端点;18 张票将新增大量端点但无错误信封/幂等键/分页约定 |
| 错误消息 | 6/10 | 配置层已达 Tier 2/3(`profile.ts:28` 问题+修法+允许值);HTTP 层仍 Nest 默认 |
| 文档 | 7/10 | 内部文档密度高(38+ ADR、术语表、票据 DoD);无 API 参考 |
| 升级迁移 | 4/10 | 版本锁定强是加分;无 CHANGELOG,T1a 首个领域迁移无说明章节 |
| 开发环境 | 8/10 | 最强维度:verify 19.1s、CI 同口径、strict TS、uv 管 Python;CI 未真实跑过 |
| 社区生态 | 2/10 | 私有仓库,此项非优先;最小 CONTRIBUTING 上手成本低 |
| DX 度量 | 4/10 | T0 DX 为一次性手工实测,不可复跑;boomerang 需脚本化基线 |

**Overall DX 6/10**(简单均值 5.4 被社区维度拉低;按内部团队权重,开发环境+文档+上手为主体)。TTHW 实测 3-5 min(热),目标 <2 min(Champion 档)。

## 实现任务(原文任务表)

| # | 优先级 | 任务 | 来自 | 工作量 |
|---|---|---|---|---|
| T1 | P1 | README 黄金路径一键启动块 + 应用脚本自动预载根 .env | F1(.env 手工注入) | human ~2h / CC ~20min |
| T2 | P1 | 环境预检脚本(node/pnpm/uv/Docker daemon,缺项友好报错) | F2(无 Docker 预检) | human ~2h / CC ~20min |
| T3 | P1 | 统一 API 错误信封(code/message/param/doc_url)+ 全局异常过滤器,先于 T1a/T5/T7/T8 | Pass2/3 | human ~1d / CC ~1h |
| T4 | P2 | CHANGELOG + 迁移说明章节(T1a 首个领域迁移起维护) | Pass5 | human ~2h / CC ~30min |
| T5 | P2 | 最小 CONTRIBUTING.md(分支/DoD/verify) | Pass7 | human ~2h / CC ~30min |
| T6 | P2 | DX 基线脚本化(scripts/dx-baseline.sh),T1a 后重跑 /devex-review(boomerang) | Pass8 | human ~2h / CC ~30min |
| T7 | P3 | worker dev 单命令口径(默认 profile 读 .env,README 澄清) | F7 | human ~1h / CC ~15min |

裁决(2026-08-28 用户确认):**T1–T3(P1)并入 T1a 批次**;T4/T6 建议随 T1a 顺路或紧随其后(T4 的 CHANGELOG 由 T1a 首个迁移触发、T6 是 boomerang 复测的前提);T5/T7 低优先级自由安排。

## 当时仪表盘与现状更新

当时 VERDICT: NOT CLEARED(无 7 天内 Eng Review)。**现状更新(2026-08-28 下午)**:当日的 /gstack-plan-eng-review(ADR-0038 设计,8 项决议全部落文档)已满足该门,Eng Review = CLEAR (PLAN);T1a 开工前无需再跑一轮。

**完成状态:DONE_WITH_CONCERNS** — 三个 P1 缺口建议在 T1a 开工前随票解决;CI 从未真实运行(无远程),建远程后首次 push 是硬验证点;boomerang 目标黄金路径 <2 min、verify 保持 ~20s 内。
