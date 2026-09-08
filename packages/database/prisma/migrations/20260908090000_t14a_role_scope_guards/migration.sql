-- T14a follow-up: make role membership foreign keys tenant-scoped and enforce RoleScope.
-- The original T14a migration is immutable; all corrections live in this migration.

-- DropForeignKey
ALTER TABLE "tenant_memberships" DROP CONSTRAINT "tenant_memberships_tenantRoleId_fkey";

-- DropForeignKey
ALTER TABLE "workspace_memberships" DROP CONSTRAINT "workspace_memberships_roleId_fkey";

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_role_fkey" FOREIGN KEY ("tenantId", "tenantRoleId") REFERENCES "roles"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_tenant_role_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "roles"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RoleScope 不是普通展示字段：membership 表的角色范围必须由数据库守住，避免
-- 任何绕过 Prisma 的写入把 TENANT 角色挂到 Workspace，或反向挂到租户成员。
CREATE OR REPLACE FUNCTION enforce_tenant_membership_role_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    role_scope "RoleScope";
BEGIN
    IF NEW."tenantRoleId" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT "scope" INTO role_scope
    FROM "roles"
    WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."tenantRoleId";

    IF role_scope IS DISTINCT FROM 'TENANT'::"RoleScope" THEN
        RAISE EXCEPTION 'tenant membership requires a TENANT role'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_memberships_role_scope_guard
BEFORE INSERT OR UPDATE OF "tenantId", "tenantRoleId" ON "tenant_memberships"
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_membership_role_scope();

CREATE OR REPLACE FUNCTION enforce_workspace_membership_role_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    role_scope "RoleScope";
BEGIN
    IF NEW."roleId" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT "scope" INTO role_scope
    FROM "roles"
    WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."roleId";

    IF role_scope IS DISTINCT FROM 'WORKSPACE'::"RoleScope" THEN
        RAISE EXCEPTION 'workspace membership requires a WORKSPACE role'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_memberships_role_scope_guard
BEFORE INSERT OR UPDATE OF "tenantId", "roleId" ON "workspace_memberships"
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_membership_role_scope();

CREATE OR REPLACE FUNCTION prevent_role_scope_change_with_memberships()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."scope" IS NOT DISTINCT FROM OLD."scope" THEN
        RETURN NEW;
    END IF;

    IF NEW."scope" = 'TENANT'::"RoleScope"
       AND EXISTS (
           SELECT 1 FROM "workspace_memberships"
           WHERE "tenantId" = NEW."tenantId" AND "roleId" = NEW."id"
       ) THEN
        RAISE EXCEPTION 'cannot change a role to TENANT while Workspace memberships reference it'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."scope" = 'WORKSPACE'::"RoleScope"
       AND EXISTS (
           SELECT 1 FROM "tenant_memberships"
           WHERE "tenantId" = NEW."tenantId" AND "tenantRoleId" = NEW."id"
       ) THEN
        RAISE EXCEPTION 'cannot change a role to WORKSPACE while tenant memberships reference it'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER roles_scope_change_guard
BEFORE UPDATE OF "scope" ON "roles"
FOR EACH ROW EXECUTE FUNCTION prevent_role_scope_change_with_memberships();
