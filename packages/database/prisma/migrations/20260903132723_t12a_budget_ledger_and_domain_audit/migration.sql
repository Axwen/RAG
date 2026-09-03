-- CreateEnum
CREATE TYPE "BudgetPool" AS ENUM ('INTERACTIVE', 'EVALUATION', 'RESERVE');

-- CreateEnum
CREATE TYPE "BudgetLedgerStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BudgetCostSource" AS ENUM ('PROVIDER', 'ESTIMATED');

-- CreateEnum
CREATE TYPE "BudgetReleaseReason" AS ENUM ('GATED', 'CANCELLED_BEFORE_DISPATCH');

-- CreateEnum
CREATE TYPE "AuditCategory" AS ENUM ('BUDGET', 'AUTHZ', 'MEMBERSHIP', 'DATA_CLASS', 'INJECTION', 'EVIDENCE', 'DELETION');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('BUSINESS_USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('ALLOWED', 'DENIED', 'DEGRADED', 'RECLAIMED');

-- CreateTable
CREATE TABLE "model_budget_ledger" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "pool" "BudgetPool" NOT NULL,
    "status" "BudgetLedgerStatus" NOT NULL DEFAULT 'RESERVED',
    "reservedAmount" DECIMAL(12,6) NOT NULL,
    "actualAmount" DECIMAL(12,6),
    "costSource" "BudgetCostSource",
    "releaseReason" "BudgetReleaseReason",
    "exchangeRate" DECIMAL(10,6) NOT NULL,
    "leaseExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "renewCount" INTEGER NOT NULL DEFAULT 0,
    "answerRunId" UUID,
    "jobId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMPTZ(6),

    CONSTRAINT "model_budget_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_audit_event" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" "AuditCategory" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "outcome" "AuditOutcome" NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" TEXT,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "detail" JSONB,
    "traceId" TEXT,

    CONSTRAINT "domain_audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "model_budget_ledger_tenantId_pool_status_createdAt_idx" ON "model_budget_ledger"("tenantId", "pool", "status", "createdAt");

-- CreateIndex
CREATE INDEX "model_budget_ledger_status_leaseExpiresAt_idx" ON "model_budget_ledger"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "model_budget_ledger_tenantId_answerRunId_idx" ON "model_budget_ledger"("tenantId", "answerRunId");

-- CreateIndex
CREATE UNIQUE INDEX "model_budget_ledger_tenantId_idempotencyKey_key" ON "model_budget_ledger"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "model_budget_ledger_tenantId_id_key" ON "model_budget_ledger"("tenantId", "id");

-- CreateIndex
CREATE INDEX "domain_audit_event_tenantId_occurredAt_idx" ON "domain_audit_event"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "domain_audit_event_tenantId_category_occurredAt_idx" ON "domain_audit_event"("tenantId", "category", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "domain_audit_event_tenantId_id_key" ON "domain_audit_event"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "model_budget_ledger" ADD CONSTRAINT "model_budget_ledger_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_audit_event" ADD CONSTRAINT "domain_audit_event_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── 以下为手写补充：Prisma schema 无法表达的库层不变量 ────────────────
-- 与 20260828130000_manifest_immutability 同一口径：能焊进库里的边界不留给评审。

-- 归属恰好一个。T12「归属：tenantId、answerRunId 或 jobId、幂等键」。
-- 两列暂无外键：AnswerRun 归 T7、job 归 T3，两张表都还不存在；等它们落地后
-- 再补带 tenantId 的复合外键，本约束先把「两个都空」和「两个都填」挡在库外。
ALTER TABLE "model_budget_ledger"
    ADD CONSTRAINT "model_budget_ledger_owner_exactly_one"
    CHECK ((("answerRunId" IS NOT NULL)::int + ("jobId" IS NOT NULL)::int) = 1);

-- 金额与汇率的取值域。汇率为 0 会把所有折算金额抹成 0，等于关掉门禁。
ALTER TABLE "model_budget_ledger"
    ADD CONSTRAINT "model_budget_ledger_amounts_nonnegative"
    CHECK ("reservedAmount" >= 0 AND ("actualAmount" IS NULL OR "actualAmount" >= 0));
ALTER TABLE "model_budget_ledger"
    ADD CONSTRAINT "model_budget_ledger_exchange_rate_positive"
    CHECK ("exchangeRate" > 0);
ALTER TABLE "model_budget_ledger"
    ADD CONSTRAINT "model_budget_ledger_renew_count_nonnegative"
    CHECK ("renewCount" >= 0);

-- 每个状态的字段完备性。ADR-0029 的状态机在库层的一半：
-- RESERVED 还没有结算事实，三个终态各自只允许自己那一组字段非空。
-- 另一半（合法转移）由下面的触发器与事务入口负责。
ALTER TABLE "model_budget_ledger"
    ADD CONSTRAINT "model_budget_ledger_status_fields_consistent"
    CHECK (
        CASE "status"
            WHEN 'RESERVED' THEN "finalizedAt" IS NULL AND "actualAmount" IS NULL
                                 AND "costSource" IS NULL AND "releaseReason" IS NULL
            WHEN 'SETTLED'  THEN "finalizedAt" IS NOT NULL AND "actualAmount" IS NOT NULL
                                 AND "costSource" IS NOT NULL AND "releaseReason" IS NULL
            WHEN 'RELEASED' THEN "finalizedAt" IS NOT NULL AND "actualAmount" IS NULL
                                 AND "costSource" IS NULL AND "releaseReason" IS NOT NULL
            WHEN 'EXPIRED'  THEN "finalizedAt" IS NOT NULL AND "actualAmount" IS NULL
                                 AND "costSource" IS NULL AND "releaseReason" IS NULL
        END
    );

-- 状态机的另一半。RESERVED 之后恰好一次终态转移，终态行没有任何合法后继；
-- 预扣事实（金额、汇率、租户、幂等键、池）在结算时也不得改写——改这些列等于改账。
-- 不写「NEW.status NOT IN (四个值)」那种检查：枚举只有这四个值，那句是死代码。
CREATE OR REPLACE FUNCTION enforce_budget_ledger_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" <> 'RESERVED' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'budget ledger row is final: %', OLD."status"
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."tenantId" <> OLD."tenantId"
        OR NEW."idempotencyKey" <> OLD."idempotencyKey"
        OR NEW."pool" <> OLD."pool"
        OR NEW."reservedAmount" <> OLD."reservedAmount"
        OR NEW."exchangeRate" <> OLD."exchangeRate"
        OR NEW."createdAt" <> OLD."createdAt" THEN
        RAISE EXCEPTION 'budget ledger reservation facts are immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER model_budget_ledger_transition_guard
BEFORE UPDATE ON "model_budget_ledger"
FOR EACH ROW EXECUTE FUNCTION enforce_budget_ledger_transition();

-- reasonCode 的唯一来源是 packages/contracts/src/audit/reason-codes.ts，编译期由
-- satisfies 保证已注册。这条格式 CHECK 只兜住绕过 TS 的写入路径（裸 SQL、psql），
-- 不复制注册表内容：把码表抄进迁移，两处就会各自漂移。
ALTER TABLE "domain_audit_event"
    ADD CONSTRAINT "domain_audit_event_reason_code_namespaced"
    CHECK ("reasonCode" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$');

-- BUSINESS_USER 必须有主体；SYSTEM 的 actorId 记动作名（LEASE_REAPER / RECONCILER）
-- 或留空，所以只单向约束。subjectType/subjectId 要么都有要么都没有。
ALTER TABLE "domain_audit_event"
    ADD CONSTRAINT "domain_audit_event_business_actor_has_id"
    CHECK (NOT ("actorType" = 'BUSINESS_USER' AND "actorId" IS NULL));
ALTER TABLE "domain_audit_event"
    ADD CONSTRAINT "domain_audit_event_subject_pair_complete"
    CHECK (("subjectType" IS NULL) = ("subjectId" IS NULL));

-- 审计行不可变，且不随业务数据删除而删除（ADR-0040 决策 5、扩展点 2）。
-- 只挡行级 UPDATE/DELETE——那是应用代码经 Prisma 唯一能走的路；TRUNCATE 不触发
-- 行级触发器，集成测试的清库路径因此仍然通畅，不用为测试给应用开后门。
CREATE OR REPLACE FUNCTION prevent_domain_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'domain audit event is append-only'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER domain_audit_event_append_only
BEFORE UPDATE OR DELETE ON "domain_audit_event"
FOR EACH ROW EXECUTE FUNCTION prevent_domain_audit_event_mutation();
