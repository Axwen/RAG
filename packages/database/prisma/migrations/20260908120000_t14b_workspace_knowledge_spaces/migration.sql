-- CreateTable
CREATE TABLE "workspace_knowledge_spaces" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "knowledgeSpaceId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_knowledge_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_knowledge_spaces_tenantId_id_key"
ON "workspace_knowledge_spaces"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_knowledge_spaces_tenantId_workspaceId_knowledgeSpaceId_key"
ON "workspace_knowledge_spaces"("tenantId", "workspaceId", "knowledgeSpaceId");

-- AddForeignKey
ALTER TABLE "workspace_knowledge_spaces"
ADD CONSTRAINT "workspace_knowledge_spaces_workspace_fkey"
FOREIGN KEY ("tenantId", "workspaceId") REFERENCES "workspaces"("tenantId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_knowledge_spaces"
ADD CONSTRAINT "workspace_knowledge_spaces_knowledge_space_fkey"
FOREIGN KEY ("tenantId", "knowledgeSpaceId") REFERENCES "knowledge_spaces"("tenantId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;
