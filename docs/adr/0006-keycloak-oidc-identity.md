---
status: accepted
---

# 使用 Keycloak 作为首期身份提供方

项目从零建设且当前没有企业身份系统，首期使用 Keycloak 提供 OIDC/OAuth2 登录、会话、密码策略、MFA 和基础角色。NestJS API 只验证 Keycloak JWT/JWKS 并建立用户上下文；PostgreSQL 保存业务用户、组织、部门、知识空间成员和文档 ACL，不在业务库重复保存密码。未来接入 LDAP/AD 或企业 SSO 时，通过 Keycloak 联邦身份接入，保持应用侧 OIDC 契约和 ACL 模型不变。

## Consequences

- 开发环境可用 Docker Compose 启动 Keycloak，试点环境在私有 Kubernetes 中部署并使用 Secret。
- 首期需要建设管理员初始化、用户邀请、角色映射、禁用用户、Token 撤销和审计。
- Keycloak 的 realm/client role 只表达粗粒度能力；部门、产品范围、密级、有效期和文档权限必须由 PostgreSQL 策略判断。
