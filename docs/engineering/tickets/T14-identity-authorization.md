# T14：Identity、Business User 与 Authorization

## 目的

把已通过 PROBE-001 的 Keycloak 外部事实融入本系统自己的业务用户体系：OIDC 只证明“主体是谁”，本系统负责业务用户、租户成员、Workspace 成员、功能角色和资源授权。不得把 Keycloak 的角色或 Group 当作最终业务权限，也不得让客服、研发、普通员工等角色各自复制一套用户系统。决策依据见 [ADR-0039](../../adr/0039-business-identity-and-unified-authorization.md)。

## 范围

- `apps/api/src/modules/auth/`：Authorization Code + PKCE、JWKS 校验、会话过期与 Keycloak 不可用映射。
- `apps/api/src/modules/authorization/`：业务用户映射、租户/Workspace 成员、角色与功能权限、资源授权、允许作用域编译和批量候选权威复核。
- PostgreSQL 领域模型：以 `(issuer, subject)` 唯一映射 `BusinessUser`；维护租户成员、Workspace、Workspace 成员角色和权限绑定。业务用户不在本系统保存密码。
- `packages/database/prisma/schema.prisma` 与新增迁移目录：本票据的业务身份模型是独立迁移工件，按 T1a 的口径单独计划、单独评审，不与授权代码混在一个提交里。
- 统一授权入口：以 `businessUser + tenant + workspace + capability + resource` 为输入；功能权限码只判断“能否执行操作”，KnowledgeSpace、文档版本、数据等级及其他领域资源仍由资源策略判断。
- `packages/contracts/src/auth/`：服务端身份上下文、授权结果和审计原因码；不暴露 Keycloak 管理模型为领域契约。
- `apps/web/src/features/auth/`：登录、退出、会话失效和身份服务不可用提示；页面实现前遵守 T16 的 Design Review 门槛。
- Keycloak Realm 只由 T0 的可重复配置初始化，不在业务代码中动态创建 Realm 或 Client。

## 最小业务模型

- `BusinessUser`：本系统的业务用户主表，使用 `(issuer, subject)` 映射 Keycloak 身份，保存展示资料、业务状态和审计关联；不保存密码。
- `TenantMembership`：业务用户与租户的成员关系、状态和租户级管理能力。
- `Workspace` / `WorkspaceMembership`：客服、研发、普通员工等角色工作台及其成员关系；同一用户可加入多个 Workspace。
- `Role` / `Permission` / `RolePermission`：租户或 Workspace 范围内的功能角色和稳定能力权限码；阶段 1 以角色绑定为主，不建立无边界的全局用户角色。
- KnowledgeSpace、文档版本等领域资源继续由各自资源策略授权，不强行塞进通用 RBAC 表。

阶段 1 不建表的已识别扩展点（判据：阶段 1 没有任何验证项读它们，`acl_scope_key` 也不从它们推导，建了就是要迁移、要测、要审计但没人读的表）：

- **组织结构（`Organization` / `Department`）**：企业组织树作为业务归属和管理范围有价值，但阶段 1 的授权决策不经过它。未来引入时必须明确它对 `acl_scope_key` 是加法预过滤还是纯展示归属，不得默认继承。
- **临时直接赋权**：见下方不变量。
- **非文档型资源域**：财务记录一类资源不复用文档 ACL，进入时按 ADR-0039 新增资源类型和领域策略。

## 不变量

- Token、角色或 Keycloak Group 不直接等于业务授权；业务授权必须查 PostgreSQL。
- `(issuer, subject)` 是外部身份映射键，不能用可变 email 作为用户主键；用户禁用、撤权和租户/Workspace 成员变更必须由业务库记录并审计。
- 业务用户可以属于多个租户和多个 Workspace，在不同 Workspace 中拥有不同角色；不得设计用户的全局唯一业务角色。
- API 的能力权限码可以通过装饰器声明，菜单/按钮权限只用于界面裁剪；任何后端入口都必须经过统一授权入口，不能由前端显隐代替安全校验。
- 租户上下文必须从已验证的身份和业务成员关系推导，不能信任请求体中的 `tenantId`；T1a 的请求体字段只保留为迁移期开发兼容，本票据完成即移除（退场条件见 DoD）。
- 查询前编译 `acl_scope_key` 集合作为 OpenSearch 预过滤，候选合并后再批量复核；任何依赖不可用或超时均 fail closed。
- 能力权限码只决定“能否执行操作”，不参与 `acl_scope_key` 编译；作用域只由租户/Workspace 成员关系与资源策略推导，不得把角色维度渗进索引预过滤。
- 撤权、删除墓碑、Legal Hold 和有效期优先于缓存和历史 Snapshot。
- 不把 `acl_subject_ids`、`acl_revision` 或主体列表写入 OpenSearch。
- 阶段 1 不实现无边界的用户直接赋权；如未来引入临时直接授权，必须限定租户/Workspace、带有效期、可撤销、可审计，并不绕过资源 ACL。

## 角色扩展策略

- 客服、研发、普通员工不是 Keycloak 中的全局业务角色，而是不同的 Workspace/产品域组合：分别绑定知识空间、数据源、策略、工具和功能权限（ADR-0002）。
- 研发文档查询、制度流程资料等新域复用身份上下文和统一授权入口，但由各自领域实现资源级策略；非文档型资源不强行建模成 KnowledgeSpace 或复用文档 ACL。
- 新域只需增加资源类型、能力权限码和领域策略，不新增登录体系、不复制用户表、不把权限主体写入 OpenSearch。

## 工作量估算

- P1，human: ~8d / CC: ~2d。较 2026-08-27 冻结值 +2d / +0.5d，原因是本票据从「Keycloak 事实落成授权判定」扩为「自有业务身份体系 + 统一授权入口」（ADR-0039）：新增 7 张业务身份表及其迁移，`authorization` 同时承担能力权限与资源策略两层，并新增多角色 E2E。
- 拆分依据：`auth`（PKCE、JWKS 校验与轮换、会话过期、Keycloak 不可用映射）约 1.5d；`business-user`（`issuer + subject` 映射、租户/Workspace 成员和角色绑定、7 张表的迁移与开发种子）约 1.5d；`authorization`（能力权限、资源策略、`acl_scope_key` 集合编译、批量候选权威复核）约 2d；服务端身份上下文契约与同步领域审计原因码约 0.5d；Keycloak 容器集成七类场景（PKCE、JWKS 轮换、过期、禁用、撤权、不可用、恢复）约 1.5d；撤权竞态与复核超时 fail-closed 的 PostgreSQL/OpenSearch 集成约 0.5d；多角色/多 Workspace E2E 约 0.5d。合计 8d。
- 校准：高于 T3/T6（~6d）一档。ADR-0026 的两段授权、任何依赖不可用即 fail closed 和撤权竞态，是阶段 1 最难稳定回归的一组不变量；本票据还额外承担全仓唯一的身份写入口。
- 重叠说明：其中约 2d 原先隐含在 T6 的 ~6d 内（T6 计划文件曾包含 `apps/api/src/modules/authorization/`，验证项曾包含撤权后候选复核竞态），本票据成立后从 T6 转移而来，不是净新增范围。

## 依赖

- T0、T1a。
- T6 检索和所有受保护 Web/API 路由不得在本 Ticket 的服务端身份上下文与授权入口完成前合并。

## 验证

- 单元/契约：`issuer + subject` 映射、同一主体多租户/多 Workspace、跨租户 ID、成员缺失、角色/能力权限、资源策略、数据等级拒绝和作用域编译。
- Keycloak 容器集成：PKCE、JWKS 轮换、过期、禁用、撤权、不可用和恢复。
- PostgreSQL/OpenSearch 集成：撤权竞态、过滤与权威复核一致、复核超时 fail closed，越权证据泄漏为 0。
- Web E2E：登录、会话过期、身份服务不可用和恢复后重新校验。
- 多角色 E2E：同一业务用户在客服/研发/普通员工 Workspace 中权限不同；切换 Workspace 不得继承上一 Workspace 的资源范围。

## 回滚

- 代码回滚不得放宽授权；无法校验身份或授权时保持 fail closed。
- Realm 配置变更必须可重复导入并保留上一个可用版本，禁止在回滚时复用已撤销的业务授权缓存。

## DoD

- F-08、F-18、F-20、F-25 对应安全检查全部有代码和测试证据。
- 授权决策写同步领域审计，Trace/Telemetry 故障不影响拒绝结果。
- 没有业务模块自行解析 Token 或绕过统一授权服务。
- **T1a 迁移期兼容退场**：`tenantId` 从 Manifest/Release 入参 schema 中移除，租户只从服务端身份上下文推导，并有测试钉住「请求体携带 `tenantId` 不生效或被拒绝」。没有这条，迁移期兼容就是永久后门。
- **按 id 查询必须带租户谓词**：所有领域对象的按 id 读取与写入（`approve*`、`GET /releases/:id` 等）都在 WHERE 里带上从身份上下文推导的 `tenantId`，不得以「UUIDv7 不可猜测」当作隔离手段。T1a 代码评审已确认这些路径目前只按裸 id 查询：跨租户 approve 会把对方的 Manifest 永久锁成不可变（数据库不可变触发器），跨租户读 Release 会泄漏 `memberSetUri` 与索引名。每类对象至少一条测试：用租户 A 的身份带租户 B 的 id 请求，得到 `NOT_FOUND` 而不是 `FORBIDDEN`（后者会确认该 id 存在）。
