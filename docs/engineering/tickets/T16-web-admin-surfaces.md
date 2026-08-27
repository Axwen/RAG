# T16：Web 主链与管理控制台

## 目的

为阶段 1 的单一客服纵向闭环提供可人工验证的 Web 表面，并交付删除、评测和运维三个硬 DoD 控制台。T16 不复制后端领域状态，UI 直接消费各模块的权威 API 和快照。

## 范围

- `/login`：OIDC 登录、过期和不可用恢复。
- `/knowledge`、`/knowledge/upload`、`/knowledge/:id`：知识空间、上传、版本、隔离和发布状态。
- `/review`、`/ingestion`、`/ingestion/:jobId`：审核、Candidate Release、任务、取消、重试、DLQ/Replay。
- `/chat`：提问、SSE、停止/续读、风险状态、句级引用和复制草稿。
- `/admin/users`：用户与 Workspace 成员。
- `/admin/deletions`：Target 状态、Legal Hold、墓碑和删除证明。
- `/admin/evaluations`：黄金集、门禁报告、Manifest/模型版本和成本。
- `/admin/operations`：Worker Profile、队列积压、预算熔断、阻断和恢复演练。

## 原则

- 页面不重新建立与服务端重复的业务状态机；展示状态由 API 响应和快照派生。
- 高风险回答验证前不渲染事实正文；`WEAK`、`CONFLICT`、`EXPIRED` 和拒答必须有明确视觉语义。
- 引用点击、预览、下载每次重新鉴权，不信任历史快照权限。
- 删除、预算和恢复操作需要明确确认、结果证明和可追踪审计，不能只做“成功 Toast”。

## 工作量估算

- P1，human: ~10d / CC: ~2.5d。按执行顺序拆为两批，不作为单一批次估算：
  - T16a 用户主链（`/login`、`/knowledge`、`/knowledge/upload`、`/knowledge/:id`、`/review`、`/ingestion`、`/ingestion/:jobId`、`/chat`）：human: ~6d / CC: ~1.5d。
  - T16b 管理控制台（`/admin/users`、`/admin/deletions`、`/admin/evaluations`、`/admin/operations`）：human: ~4d / CC: ~1d。
- 拆分依据：12 条路由的页面结构与状态表达约 5d；SSE 停止/续读、句级引用回跳与高风险缓冲的前端语义约 1.5d；三个控制台的删除证明、门禁报告、预算熔断展示与二次确认约 2d；Playwright 八条关键浏览器链路及无障碍、错误恢复、加载/空状态验收约 1.5d。
- 校准：两批各自与 T6/T7（~6d）、T11/T12（~4d）同档。T16 是阶段 1 唯一横跨整条时间线的票据，合并成单一数字会掩盖它必须纵向跟随后端 Ticket 交付这一约束。
- 重叠说明：其中约 1d 原先隐含在 T7 的 ~6d 内（T7 计划文件包含 `apps/web/src/features/chat/`），约 0.5d 隐含在 T8/T9/T12 的删除证明与报告 DoD 内。
- 本估算不含 Design Review 本身的工作量；Design Review 未关闭前不开工 `/chat` 与三个 `/admin/*` 控制台。

## 依赖与时点

- 页面实现开始前执行 Design Review，最迟不晚于 `/chat` 和三个 `/admin/*` 控制台开工。
- 身份页面依赖 T14；知识/入库依赖 T4/T5；Chat 依赖 T6/T7；管理控制台分别依赖 T8/T9/T10-T12。
- 按后端 Ticket 纵向交付，不等待所有后端完成后一次性搭空壳页面。

## 验证

- Playwright 覆盖登录、上传到发布、Chat/SSE/续读、撤权后引用回跳、高风险缓冲、删除证明、评测门禁和预算熔断。
- API/容器测试负责状态机和故障注入，浏览器测试只验证真实用户行为与信息表达。
- 无障碍、错误恢复、加载/空状态和操作确认按 Design Review 结果验收。

## 回滚

- 前端回滚不得隐藏后端阻断、删除未完成或预算熔断事实。
- 新页面不可用时可以回滚路由，但不得通过旧页面绕过当前授权和确认要求。

## DoD

- 工程评审测试计划中的受影响页面和关键浏览器路径全部可重复执行。
- 三个管理控制台能人工验证删除证明、评测门禁、预算熔断和恢复演练。
- Design Review 已完成且没有未关闭的阻断项。
