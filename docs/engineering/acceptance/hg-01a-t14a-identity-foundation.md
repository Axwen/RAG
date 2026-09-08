# HG-01a（临时）：T14a 身份接入与业务身份模型人工验收

- 状态：ACCEPTED
- 提交验收日期：2026-09-08
- 用户结论日期：2026-09-08

> HG-01a 是 T14a 与 T14b 之间的临时门禁（门禁表见
> [manual-acceptance-gate.md](../manual-acceptance-gate.md)）：身份接入是后续所有
> 受保护路由的地基，7 张表在 HG-01 内还没有业务数据，此时改结构只是改迁移；等 T14b
> 的授权判定与受保护路由压上去之后再改，代价完全不同。验收对象是「知道你是谁」；
> 「你能做什么」与 `tenantId` 退场归 T14b。

## 1. 范围与结果

验收基于 main `afdcc3c`（PR #35 合入，含 2026-09-08 的四条评审修复提交：
角色范围守卫迁移、会话密钥加固、Keycloak 端点统一、`loadIdentityContext` 自持事务）。

已验证：

- **登录链路（浏览器）**：`/auth/login` → 302 到 Keycloak 登录页（`localhost:8081`）→
  `devuser` 登录 → 回调 `/auth/callback` 返回会话视图 JSON；`/auth/session` 复读一致。
  投影包含租户管理员（`tenant-admin`）与三个 Workspace 角色（`agent` / `engineer` /
  `staff`），**不含 `issuer` / `subject`**（服务端映射键不随会话响应外发）。
- **退出语义**：`POST /auth/logout` 返回 `{status:"ok"}`，之后 `GET /auth/session`
  返回 401 五字段错误信封（`code: UNAUTHORIZED`、`doc_url` 指向正确锚点、带 `trace_id`）。
- **7 张表结构**：`business_users`（`(issuer, subject)` 唯一索引，无 tenantId——主体可
  多租户的唯一例外）、`tenant_memberships`、`workspaces`、`workspace_memberships`、
  `roles`、`permissions`（跨租户权限字典）、`role_permissions`；除两张跨租户表外全部
  带 tenantId 谓词。
- **租户级复合外键与守卫触发器**：`workspace_memberships.(tenantId, roleId) →
  roles(tenantId, id)` 已确认；`tenant_memberships_role_scope_guard` /
  `workspace_memberships_role_scope_guard` / `roles_scope_change_guard` 三个触发器
  在位（TENANT 角色挂不进 Workspace、反向同理、有成员的角色不可改 scope）。
- **种子与映射对齐**：Keycloak dev 用户（partialImport 固定 UUID
  `018f0000-…-00000000a001`）与 `business_users.subject` 同源对齐；issuer 从
  `KEYCLOAK_BASE_URL`/`KEYCLOAK_REALM` 推导（本机 8081）。

自动化佐证（非验收依据，仅记录）：372 单测 + 35 集成全绿；覆盖率
92.58/89.07/92.67/94.12（余量 ≥1.07pp）；main 上 CI 全绿。

不在本门禁范围（归 T14b）：能力权限判定、资源策略、`acl_scope_key` 编译、
`manifests` 端点请求体 `tenantId` 退场、租户谓词补齐。登录页 UI 归 T16a
（Design Review 门槛前置）。

## 2. 用户结论

用户逐项走完浏览器登录链路、logout 401 语义、表结构核验与触发器确认，
未提出行动项。结论 `ACCEPTED`，T14b 解锁。

## 3. 遗留

- 会话为 HMAC 自包含 cookie：TTL 内成员关系变更不生效（T14b 授权入口每次查库，
  不依赖会话快照，授权侧不受影响）；多实例部署需共享 `AUTH_SESSION_SECRET` 或
  换集中存储（届时先补票据再动结构）。
- 生产环境部署时必须显式配置 `AUTH_SESSION_SECRET`（缺失即 fail-fast，已实现）。
- `AUTH_API_BASE_URL` 与回调地址当前指向 `localhost:3001`，生产部署前按实际域名调整。
