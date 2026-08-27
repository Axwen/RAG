# T14：Identity 与 Authorization

## 目的

把已通过 PROBE-001 的 Keycloak 外部事实落成业务身份和授权边界：OIDC 只证明主体身份，Workspace 成员、KnowledgeSpace 绑定、数据等级和 ACL 仍由 PostgreSQL 权威判定。

## 范围

- `apps/api/src/modules/auth/`：Authorization Code + PKCE、JWKS 校验、会话过期与 Keycloak 不可用映射。
- `apps/api/src/modules/authorization/`：用户映射、Workspace 成员、允许作用域编译和批量候选权威复核。
- `packages/contracts/src/auth/`：服务端身份上下文、授权结果和审计原因码；不暴露 Keycloak 管理模型为领域契约。
- `apps/web/src/features/auth/`：登录、退出、会话失效和身份服务不可用提示；页面实现前遵守 T16 的 Design Review 门槛。
- Keycloak Realm 只由 T0 的可重复配置初始化，不在业务代码中动态创建 Realm 或 Client。

## 不变量

- Token、角色或 Keycloak Group 不直接等于业务授权；业务授权必须查 PostgreSQL。
- 查询前编译 `acl_scope_key` 集合作为 OpenSearch 预过滤，候选合并后再批量复核；任何依赖不可用或超时均 fail closed。
- 撤权、删除墓碑、Legal Hold 和有效期优先于缓存和历史 Snapshot。
- 不把 `acl_subject_ids`、`acl_revision` 或主体列表写入 OpenSearch。

## 工作量估算

- P1，human: ~6d / CC: ~1.5d。
- 拆分依据：`auth`（PKCE、JWKS 校验与轮换、会话过期、Keycloak 不可用映射）约 1.5d；`authorization`（用户映射、Workspace 成员、`acl_scope_key` 集合编译、批量候选权威复核）约 2d；服务端身份上下文契约与同步领域审计原因码约 0.5d；Keycloak 容器集成七类场景（PKCE、JWKS 轮换、过期、禁用、撤权、不可用、恢复）约 1.5d；撤权竞态与复核超时 fail-closed 的 PostgreSQL/OpenSearch 集成约 0.5d。
- 校准：与 T3/T6 同档（~6d）。ADR-0026 的两段授权、任何依赖不可用即 fail closed 和撤权竞态，是阶段 1 最难稳定回归的一组不变量。
- 重叠说明：其中约 2d 原先隐含在 T6 的 ~6d 内（T6 计划文件曾包含 `apps/api/src/modules/authorization/`，验证项曾包含撤权后候选复核竞态），本票据成立后从 T6 转移而来，不是净新增范围。

## 依赖

- T0、T1a。
- T6 检索和所有受保护 Web/API 路由不得在本 Ticket 的服务端身份上下文与授权入口完成前合并。

## 验证

- 单元/契约：Token claim 映射、跨租户 ID、成员缺失、数据等级拒绝和作用域编译。
- Keycloak 容器集成：PKCE、JWKS 轮换、过期、禁用、撤权、不可用和恢复。
- PostgreSQL/OpenSearch 集成：撤权竞态、过滤与权威复核一致、复核超时 fail closed，越权证据泄漏为 0。
- Web E2E：登录、会话过期、身份服务不可用和恢复后重新校验。

## 回滚

- 代码回滚不得放宽授权；无法校验身份或授权时保持 fail closed。
- Realm 配置变更必须可重复导入并保留上一个可用版本，禁止在回滚时复用已撤销的业务授权缓存。

## DoD

- F-08、F-18、F-20、F-25 对应安全检查全部有代码和测试证据。
- 授权决策写同步领域审计，Trace/Telemetry 故障不影响拒绝结果。
- 没有业务模块自行解析 Token 或绕过统一授权服务。
