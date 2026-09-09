# HG-01：T14b 统一授权入口与资源策略人工验收

- 状态：ACCEPTED
- 提交验收日期：2026-09-09
- 用户结论日期：2026-09-09
- 验收基线：main 合并提交 `808a48f`（PR #37）

## 1. 范围与结果

本记录覆盖 HG-01 中 T14b 的人工验收范围。T14b 是后端批次，本批次无新增产品 UI，
通过浏览器登录链路、真实 HTTP API、开发数据库和真库集成测试进行核验。

用户已按验收清单逐项执行并确认通过，确认范围包括：

- OIDC 登录回调、会话读取、退出后的 401 语义，以及会话视图不外发 `issuer`/`subject`；
- 受保护 Manifest/Release 路由的未登录拒绝、有权限成功调用和统一错误信封；
- 请求体携带的 `tenantId` 不覆盖服务端身份推导出的租户；
- Manifest 审批与 Release 创建/读取在领域调用前经过统一授权入口；
- 权限撤销后的拒绝语义、非法租户选择和活动租户会话投影；
- 跨租户 ID 隔离、Workspace 知识空间作用域裁剪、撤权后 ACL revision 收窄、候选复核
  与数据等级策略的真库集成验证；
- `authz.capability_allowed`、`authz.capability_denied` 等同步领域审计记录及错误响应
  不泄露内部信息。

## 2. 自动化与 CI 佐证

自动化验证不是人工验收的替代，仅作为本次验收的执行前提与回归佐证：

- `pnpm run verify` 通过；
- 单元测试 37 个文件、441/441 通过；
- 集成测试 51/51 通过；
- `pnpm run build`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run format` 通过；
- `pnpm run check:links`、`pnpm run check:shell`、`pnpm run check:commits` 通过；
- 增量覆盖率为 97.08%；
- 本地 PostgreSQL 已应用 T14b 迁移；
- PR #37 的 GitHub required checks 全部通过，包括 node、quality、python、compose、smoke、
  gitleaks、依赖审查和 CodeQL。

## 3. 当前边界与遗留

本次 `ACCEPTED` 仅表示 HG-01 门禁范围已通过，不扩大 T14b 或 HG-01 的业务边界：

- 删除墓碑、Legal Hold、有效期和复核超时分别等待 T5、T8、T6 的领域模型与调用方；
- 完整多角色浏览器 E2E 与用户主链 UI 归 T16；
- 容器级 Testcontainers、部署环境和真实语料性能基线仍未验证；
- T2 的幂等重放状态码调整仍按 T1a 验收遗留归入 T2。

## 4. 用户结论

用户于 2026-09-09 明确回复：`ACCEPTED`。

根据阶段人工核验门禁，HG-01 通过后解锁下一批次：

```text
T2 Domain State + T10 Worker 基础
  -> T3 MessageBus
  -> T1b Chunk/Index Schema
  -> HG-02 人工核验
```
