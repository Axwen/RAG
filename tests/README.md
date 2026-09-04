# 集成测试工作区

`tests/` 是**库层集成测试**：跑在一个已迁移的真 PostgreSQL 上，通过**包名**
（`@rag/database`、`@rag/config`）import，验的是包根导出的那层表面。仓库根的
devDependencies 因此声明了这两个工作区包——这一层是它们的外部消费者。

单元测试仍然放在各包目录内（`packages/*/test/`），跑 `pnpm test`。

## 两层的分界

分界不按「快慢」，按**证据在哪里**：

| 命题 | 层 |
| --- | --- |
| 调用顺序、入参校验、纯计算（结算差额、窗口边界、脱敏） | 单元层，假事务 |
| advisory lock 下的并发预扣、`FOR UPDATE SKIP LOCKED` 的批次挑行、append-only 触发器、状态机触发器、事务回滚把审计与账本一起撤掉 | 集成层，真库 |

假事务能证明「入口按什么顺序调了什么」，证不了「两个连接同时打进来时数据库怎么排队」。
反过来，把纯计算搬到集成层只是让它慢 100 倍。T12 票据的[验证]小节就是按这条线切的。

## 跑之前

集成层要的不是「有 Node」，是「有一个已迁移的 PostgreSQL」，再加一次构建
（走包名 import 就是走 dist）：

```bash
cp .env.example .env          # DATABASE_URL 与 Compose 共用同一份
pnpm run infra:up             # 起 core 容器，--wait 等健康检查
pnpm run bootstrap            # 迁移 + 种子，幂等
pnpm run build                # 集成层 import 的是 dist
pnpm run test:integration
```

缺 dist 时 `vitest.integration.config.ts` 在配置求值阶段就抛，不会让人去读
vite 那句指向 exports 字段的错误；缺 `DATABASE_URL` 时 `tests/setup.ts` 抛，
错误信息里带着上面那两条命令。

## 为什么单独一份 vitest 配置

`vitest.integration.config.ts` 与 `vitest.config.ts` 分开，不是为了整洁：

- **不设覆盖率阈值。** 棘轮量的是单元层能触达多少代码。把真库跑出来的数字并进去，
  阈值会虚高，正好掩盖单元层的空洞。
- **`fileParallelism: false`。** 所有文件共用同一个库，并行会让 A 文件的清理撞上
  B 文件正在跑的窗口求和，而 `SKIP LOCKED` 那条用例要故意长时间持锁。
- **超时 30s。** 并发预扣要真的在 advisory lock 上排队。

混成一条命令的代价是：新克隆的 `pnpm test` 会因为没起容器而红，把「代码错了」和
「环境没起」压成同一个信号。

## 清理是不对称的，这是不变量的结果

`tests/helpers/integration-db.ts` 只删账本行，不删审计行也不删租户：

- **账本行必须删**——`expireBudgetLeases` 不带 `tenantId`（回收是全局任务），残留的
  `RESERVED` 行会混进下一轮批次。删除本身允许：状态机触发器是 `BEFORE UPDATE`。
- **审计行删不掉**——`domain_audit_event_append_only` 对行级 UPDATE/DELETE 抛
  `check_violation`（ADR-0040 决策 5）。迁移里留了 TRUNCATE 通路，但那是清库不是清租户，
  测试不该有应用代码没有的后门。
- **租户跟着删不掉**——审计行到 `tenants` 的外键是 `ON DELETE RESTRICT`。

于是本机的开发库会累积几行两列的残留（名字都带 `integration-` 前缀），只能靠
`pnpm run infra:reset` 清；CI 每次都是全新容器，不受影响。用例前的
`assertNoForeignReservedRows` 管的是另一件事：别人留下的 `RESERVED` 行会污染全局回收批次，
与其让断言偶发失败，不如开跑就说「库不干净」。

容器内的端到端、性能与恢复测试按对应实施 Ticket 加入。
