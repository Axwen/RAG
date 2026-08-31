---
status: accepted
date: 2026-08-31
decision-basis: T1a landing review and T14 scope revision
---

# 业务身份体系与统一授权入口

## 决策

Keycloak/OIDC 只负责认证，本系统维护自己的业务身份与授权事实。四条不变量：

1. **外部身份与业务用户分离。** Keycloak 只产出稳定的 `(issuer, subject)`；`BusinessUser` 是本系统的业务主体主表，以 `(issuer, subject)` 唯一映射外部身份。业务库不保存密码，不把 Keycloak 的 Role/Group 当作业务授权事实，也不把 Keycloak 管理模型暴露为领域契约。可变的 email 不得作为映射键或用户主键。
2. **能力权限与资源策略分两层。** 统一授权入口的输入是 `businessUser + tenant + workspace + capability + resource`。功能权限码只回答“能否执行这个操作”；KnowledgeSpace、文档版本、数据等级等领域资源的可见性仍由资源策略回答。**能力权限码不参与 `acl_scope_key` 编译**：作用域只由租户/Workspace 成员关系与资源策略推导，角色维度不得渗进 OpenSearch 预过滤。
3. **业务主体可以多租户、多 Workspace、多角色。** 同一 `BusinessUser` 可加入多个租户与多个 Workspace，在不同 Workspace 中承担不同角色；不存在用户的全局唯一业务角色。切换 Workspace 不得继承上一个 Workspace 的资源范围。
4. **租户上下文只从已验证身份推导。** 不得信任请求体、查询参数或任何客户端输入中的 `tenantId`。T1a 的请求体 `tenantId` 是迁移期开发兼容，T14 完成即移除并由测试钉住。

阶段 1 的最小业务模型为 7 张表：`BusinessUser`、`TenantMembership`、`Workspace`、`WorkspaceMembership`、`Role`、`Permission`、`RolePermission`。

## 依据

PROBE-001 只验证了外部身份事实（PKCE、JWKS 轮换、过期、禁用、撤权、不可用与恢复），没有验证业务用户映射、Workspace 成员和作用域编译——这三项此前没有票据归属，T14 因此从「把 Keycloak 事实落成授权判定」扩为「自有业务身份体系 + 统一授权入口」。

把这件事定成 ADR 而不是只写在票据里，有两个具体原因：

- **它是全仓唯一的身份写入口。** 客服、研发、普通员工三个角色工作台复用同一基座（[ADR-0002](0002-shared-core-role-workspaces.md)），一旦某个域自建用户表或自解析 Token，越权证据泄漏为 0 的硬门禁就失去单点可验证性。
- **T1a 已经打开了一个洞。** T1a 的 Manifest/Release 端点从请求体读 `tenantId`，任何调用方都能声明任意租户。没有一个带退场条件的书面决策，这种“迁移期兼容”会变成永久后门。

能力权限与资源策略分层，是为了保住 [ADR-0026](0026-acl-scope-key-and-authoritative-recheck.md) 的两段授权：预过滤键一旦混入角色维度，索引就会重新变成主体列表的去规范化副本，而 [ADR-0037](0037-stage1-index-field-alignment.md) 明确禁止索引保存 `acl_subject_ids`/`acl_revision`。

## 已识别扩展点（阶段 1 不实现）

判据一致：阶段 1 没有任何验证项读它们，`acl_scope_key` 也不从它们推导。建表就是要迁移、要测、要审计但没人读的表。处理方式与 [ADR-0036](0036-stage1-protocol-clarifications.md) 对逐文档正向授权的处理一致——写成扩展点，不进 schema。

1. **组织结构（`Organization` / `Department`）。** 企业组织树作为业务归属和管理范围有价值，但阶段 1 的授权决策不经过它。未来引入时必须先明确它对 `acl_scope_key` 是加法预过滤还是纯展示归属，不得默认继承。
2. **临时直接赋权。** 若引入，必须限定租户/Workspace、带有效期、可撤销、可审计，且只能进预过滤，不绕过资源权威复核。
3. **非文档型资源域。** 财务记录一类资源不复用文档 ACL、不建模成 KnowledgeSpace；进入时新增资源类型与领域策略，复用身份上下文和统一授权入口。此类新域属于产品范围决策，须先修订[产品与架构边界](../design/企业级可信RAG基础MVP-产品与架构边界.md)，不能由票据顺带引入。

## 影响与后续

1. [T14 Ticket](../engineering/tickets/T14-identity-authorization.md) 与[工程评审闭合记录](../engineering/plan-eng-review-closure.md)第 16 节按本 ADR 更新范围；T14 估算由 human ~6d / CC ~1.5d 上调为 ~8d / ~2d，十八张票据合计随之为 86.5d / 21.1d，2026-08-27 的估算冻结到此结束。
2. `PROJECT_STATE.md`「核心架构不变量」新增一条复述决策 1 与决策 4；发生冲突时以本 ADR 为准。
3. T16b `/admin/users` 必须消费 T14 的业务用户与统一授权 API，不得直接读写 Keycloak 管理模型。
4. T14 的验证必须包含多角色 E2E：同一业务用户在三个角色工作台权限不同，切换 Workspace 不继承上一 Workspace 的资源范围。
5. 本 ADR 不改变 ADR-0026 的两段授权、ADR-0036 的纯作用域型授权模型和 ADR-0037 的索引字段口径；若未来需要让角色参与索引预过滤，必须新增 ADR 并重建受影响分区。
6. T1a 代码评审（2026-08-31）确认：现有 `approve*` 与 `GET /releases/:id` 只按裸 id 查询，没有租户谓词——这是决策 4「租户上下文只从已验证身份推导」在 T1a 期间尚未生效的直接后果。T1a 阶段不补租户谓词，因为唯一可用的 `tenantId` 来自请求体，加上它只是把越权入口从 id 挪到请求体；退场条件已写入 T14 的 DoD，并记入 [HG-01 验收记录](../engineering/acceptance/hg-01-t1a-manifest-core.md)的已知风险。
