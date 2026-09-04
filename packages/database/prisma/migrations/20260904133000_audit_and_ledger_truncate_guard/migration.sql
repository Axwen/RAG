-- 阻断 `domain_audit_event` 与 `model_budget_ledger` 的 TRUNCATE。
--
-- 上一条迁移（20260903132723）只挡行级 UPDATE/DELETE，并在注释里刻意给 TRUNCATE 留了路：
-- 「TRUNCATE 不触发行级触发器，集成测试的清库路径因此仍然通畅」。这条推理有一个洞——
-- TRUNCATE 走的不是应用要不要用它，而是应用**能不能**用它：`domain_audit_event` 的不可变
-- 承诺（ADR-0040 决策 5：审计行不可变，且不随业务数据删除而删除）在同一个连接上就能被
-- 一条 `TRUNCATE domain_audit_event` 整表抹掉，「删不掉」于是只对逐行删除成立。
-- `model_budget_ledger` 同理更重：它是余额的唯一事实源（ADR-0029），清表等于把全部已花额度
-- 归零，而 Redis 里的缓存值反而还在。
--
-- 语句级触发器是 PostgreSQL 里唯一能挡 TRUNCATE 的触发器形态（行级触发器对它不触发）。
-- 它在 `TRUNCATE ... CASCADE` 级联到的每张表上同样触发，所以 `TRUNCATE tenants CASCADE`
-- （最容易手抖的那条：目标看着是租户表，实际会把这两张事实表一起清空）也被挡住。
-- 集成测试 `tests/budget-audit-atomicity.test.ts` 把直接与级联两条路径都钉住了。
--
-- 这条边界的诚实说明：表的 owner 可以 `DROP TRIGGER` 再 TRUNCATE，所以这不是对
-- 「拿到了 owner 连接的人」的防线，而是把**误清**（清库脚本、复制粘贴的 psql、某个
-- 「reset 一下」的测试 helper）从静默成功变成一条 `check_violation`，并让任何绕过都必须写
-- 一条显式 DDL、在审阅与迁移历史里留痕。真正的硬边界是角色分离——应用连接不是表 owner、
-- 不持有 TRUNCATE 权限，迁移用另一个角色——那是部署期的事（T14 / 部署清单），不是这里能做完的。
--
-- 集成测试不受影响：清理路径从来没用过 TRUNCATE（`tests/helpers/integration-db.ts` 删账本行 +
-- 删没写过审计的租户），清库靠 `pnpm run infra:reset` 重建卷。

-- 一个函数服务两张表，用 `TG_TABLE_NAME` 报出是哪张。措辞不写 append-only：账本不是
-- append-only（它有合法的 RESERVED -> 终态 UPDATE），它和审计表共同的性质是「事实不得被批量抹掉」。
CREATE OR REPLACE FUNCTION prevent_fact_table_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'TRUNCATE on % is not allowed: budget and audit facts must not be erasable in bulk', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER domain_audit_event_no_truncate
BEFORE TRUNCATE ON "domain_audit_event"
FOR EACH STATEMENT EXECUTE FUNCTION prevent_fact_table_truncate();

CREATE TRIGGER model_budget_ledger_no_truncate
BEFORE TRUNCATE ON "model_budget_ledger"
FOR EACH STATEMENT EXECUTE FUNCTION prevent_fact_table_truncate();
