-- APPROVED Manifest 是内容寻址且不可变对象。
-- 触发器覆盖直接 SQL/Prisma 更新，避免只依赖 API 没有 PATCH 路由。
CREATE OR REPLACE FUNCTION prevent_approved_manifest_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" = 'APPROVED' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'approved manifest is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER ingestion_manifests_approved_immutable
BEFORE UPDATE ON "ingestion_manifests"
FOR EACH ROW EXECUTE FUNCTION prevent_approved_manifest_update();

CREATE TRIGGER retrieval_manifests_approved_immutable
BEFORE UPDATE ON "retrieval_manifests"
FOR EACH ROW EXECUTE FUNCTION prevent_approved_manifest_update();

CREATE TRIGGER answer_manifests_approved_immutable
BEFORE UPDATE ON "answer_manifests"
FOR EACH ROW EXECUTE FUNCTION prevent_approved_manifest_update();

CREATE TRIGGER pipeline_manifests_approved_immutable
BEFORE UPDATE ON "pipeline_manifests"
FOR EACH ROW EXECUTE FUNCTION prevent_approved_manifest_update();

-- 租户是引用关系的最高隔离域。单列 ID 外键无法阻止跨租户拼接，
-- 因此对 Pipeline/Release 的所有跨表引用增加带 tenantId 的复合外键。
CREATE UNIQUE INDEX "knowledge_spaces_tenantId_id_key"
    ON "knowledge_spaces"("tenantId", "id");
CREATE UNIQUE INDEX "ingestion_manifests_tenantId_id_key"
    ON "ingestion_manifests"("tenantId", "id");
CREATE UNIQUE INDEX "retrieval_manifests_tenantId_id_key"
    ON "retrieval_manifests"("tenantId", "id");
CREATE UNIQUE INDEX "answer_manifests_tenantId_id_key"
    ON "answer_manifests"("tenantId", "id");
CREATE UNIQUE INDEX "pipeline_manifests_tenantId_id_key"
    ON "pipeline_manifests"("tenantId", "id");
CREATE UNIQUE INDEX "index_partitions_tenantId_id_key"
    ON "index_partitions"("tenantId", "id");

ALTER TABLE "index_partitions"
    ADD CONSTRAINT "index_partitions_tenant_knowledge_space_fkey"
    FOREIGN KEY ("tenantId", "knowledgeSpaceId")
    REFERENCES "knowledge_spaces"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "index_partitions"
    DROP CONSTRAINT "index_partitions_knowledgeSpaceId_fkey";

ALTER TABLE "pipeline_manifests"
    ADD CONSTRAINT "pipeline_manifests_tenant_ingestion_fkey"
    FOREIGN KEY ("tenantId", "ingestionManifestId")
    REFERENCES "ingestion_manifests"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pipeline_manifests"
    DROP CONSTRAINT "pipeline_manifests_ingestionManifestId_fkey";
ALTER TABLE "pipeline_manifests"
    DROP CONSTRAINT "pipeline_manifests_retrievalManifestId_fkey";
ALTER TABLE "pipeline_manifests"
    DROP CONSTRAINT "pipeline_manifests_answerManifestId_fkey";
ALTER TABLE "pipeline_manifests"
    ADD CONSTRAINT "pipeline_manifests_tenant_retrieval_fkey"
    FOREIGN KEY ("tenantId", "retrievalManifestId")
    REFERENCES "retrieval_manifests"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pipeline_manifests"
    ADD CONSTRAINT "pipeline_manifests_tenant_answer_fkey"
    FOREIGN KEY ("tenantId", "answerManifestId")
    REFERENCES "answer_manifests"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "release_manifests"
    ADD CONSTRAINT "release_manifests_tenant_knowledge_space_fkey"
    FOREIGN KEY ("tenantId", "knowledgeSpaceId")
    REFERENCES "knowledge_spaces"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_manifests"
    ADD CONSTRAINT "release_manifests_tenant_partition_fkey"
    FOREIGN KEY ("tenantId", "indexPartitionId")
    REFERENCES "index_partitions"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_manifests"
    ADD CONSTRAINT "release_manifests_tenant_ingestion_fkey"
    FOREIGN KEY ("tenantId", "ingestionManifestId")
    REFERENCES "ingestion_manifests"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_manifests"
    DROP CONSTRAINT "release_manifests_knowledgeSpaceId_fkey";
ALTER TABLE "release_manifests"
    DROP CONSTRAINT "release_manifests_indexPartitionId_fkey";
ALTER TABLE "release_manifests"
    DROP CONSTRAINT "release_manifests_ingestionManifestId_fkey";
