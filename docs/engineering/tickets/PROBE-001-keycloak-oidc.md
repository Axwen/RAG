# PROBE-001：Keycloak/OIDC 身份与撤权探针

## 目的

验证 Keycloak 单 Realm、OIDC Authorization Code + PKCE、JWT/JWKS 校验、业务用户映射、Token 过期、用户禁用/撤权和 Keycloak 不可用时的 fail-closed 行为。

## 当前依据

- [ADR-0006](../../adr/0006-keycloak-oidc-identity.md)
- [产品与架构边界](../../design/企业级可信RAG基础MVP-产品与架构边界.md) 的身份与授权章节
- 当前没有身份实现代码，因此本探针不修改业务模块。

## 输入与边界

- 一个可重复导入的 Realm 配置。
- 管理员、普通用户、被禁用用户、两个 Workspace 成员关系。
- 一个最小 NestJS 或脚本验证客户端，禁止引入正式业务用户表。
- 所有密码和 Client Secret 通过环境变量提供。

## 必须验证

1. Realm 可重复导入，client、redirect URI 和 PKCE 配置不会漂移。
2. 浏览器能完成 Code + PKCE 登录，API 能通过 JWKS 校验 Token。
3. Keycloak subject 能稳定映射到业务用户，不把 Keycloak role 当作文档 ACL。
4. Access Token 过期后请求被拒绝，刷新/重新登录路径可解释。
5. 用户禁用或 Workspace 成员撤销后，后续查询和引用预览 fail closed；记录撤权传播延迟。
6. Keycloak 暂时不可用时，不能用旧会话扩大权限；恢复后可重新校验。

## 产出

- `probe-001-keycloak-oidc.md`
- `probe-001-keycloak-oidc.json`
- Realm 脱敏导入文件和运行命令。
- Token 过期、撤权和故障恢复的请求/响应证据。

## 通过标准

- `PASS`：上述 6 项均通过，业务授权边界清晰。
- `PASS_WITH_ADJUSTMENT`：OIDC 成立，但需要调整 Token TTL、撤权检查周期、Session 策略或错误 UX，并在 ADR/配置中固化。
- `BLOCKED`：无法稳定完成 OIDC、JWKS 校验或撤权后 fail closed。

## 测试与回滚

- 用脚本/API 测试，不依赖正式前端页面。
- 探针失败只删除探针容器、Realm 和本地凭据，不触碰业务数据。

