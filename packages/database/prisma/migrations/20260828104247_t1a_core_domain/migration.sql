-- CreateEnum
CREATE TYPE "DataClass" AS ENUM ('UNKNOWN', 'PUBLIC', 'INTERNAL', 'CONTROLLED', 'SENSITIVE');

-- CreateEnum
CREATE TYPE "ManifestStatus" AS ENUM ('DRAFT', 'APPROVED');

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('CREATED', 'BUILDING', 'VALIDATING', 'READY', 'ACTIVE', 'SUPERSEDED', 'ROLLING_BACK', 'FAILED', 'ABORTED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_spaces" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultDataClass" "DataClass" NOT NULL DEFAULT 'INTERNAL',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "knowledgeSpaceId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "sourceFormat" TEXT NOT NULL,
    "dataClass" "DataClass" NOT NULL DEFAULT 'INTERNAL',
    "contentHash" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_manifests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ManifestStatus" NOT NULL DEFAULT 'DRAFT',
    "parserRef" TEXT NOT NULL,
    "chunkerRef" TEXT NOT NULL,
    "embeddingRef" TEXT NOT NULL,
    "indexSchemaRef" TEXT NOT NULL,
    "parseBackend" TEXT NOT NULL DEFAULT 'deepdoc',
    "sourceFormats" TEXT[],
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ingestion_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retrieval_manifests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ManifestStatus" NOT NULL DEFAULT 'DRAFT',
    "sparsePolicy" JSONB NOT NULL,
    "vectorPolicy" JSONB NOT NULL,
    "fusionPolicy" JSONB NOT NULL,
    "rerankerRef" TEXT NOT NULL,
    "candidateBudget" INTEGER NOT NULL,
    "rerankInputSize" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "retrieval_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answer_manifests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ManifestStatus" NOT NULL DEFAULT 'DRAFT',
    "promptRef" TEXT NOT NULL,
    "modelRouteRef" TEXT NOT NULL,
    "citationPolicy" JSONB NOT NULL,
    "riskPolicy" JSONB NOT NULL,
    "fallbackPolicy" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "answer_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_manifests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ManifestStatus" NOT NULL DEFAULT 'DRAFT',
    "ingestionManifestId" UUID NOT NULL,
    "retrievalManifestId" UUID NOT NULL,
    "answerManifestId" UUID NOT NULL,
    "compatibilityHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "pipeline_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "index_partitions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "knowledgeSpaceId" UUID NOT NULL,
    "dataClass" "DataClass" NOT NULL,
    "indexSchemaVersion" TEXT NOT NULL,
    "embeddingVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "index_partitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_manifests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "knowledgeSpaceId" UUID NOT NULL,
    "indexPartitionId" UUID NOT NULL,
    "ingestionManifestId" UUID NOT NULL,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'CREATED',
    "memberSetUri" TEXT NOT NULL,
    "memberSetHash" TEXT NOT NULL,
    "memberCount" INTEGER NOT NULL,
    "docIndexName" TEXT NOT NULL,
    "chunkIndexName" TEXT NOT NULL,
    "candidateAlias" TEXT NOT NULL,
    "indexSchemaVersion" TEXT NOT NULL,
    "embeddingVersion" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_spaces_tenantId_slug_key" ON "knowledge_spaces"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "documents_tenantId_knowledgeSpaceId_idx" ON "documents"("tenantId", "knowledgeSpaceId");

-- CreateIndex
CREATE INDEX "document_versions_tenantId_documentId_idx" ON "document_versions"("tenantId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_documentId_version_key" ON "document_versions"("documentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_tenantId_contentHash_key" ON "document_versions"("tenantId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_manifests_tenantId_contentHash_key" ON "ingestion_manifests"("tenantId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "retrieval_manifests_tenantId_contentHash_key" ON "retrieval_manifests"("tenantId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "answer_manifests_tenantId_contentHash_key" ON "answer_manifests"("tenantId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_manifests_tenantId_ingestionManifestId_retrievalMa_key" ON "pipeline_manifests"("tenantId", "ingestionManifestId", "retrievalManifestId", "answerManifestId");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_manifests_tenantId_contentHash_key" ON "pipeline_manifests"("tenantId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "index_partitions_tenantId_knowledgeSpaceId_dataClass_indexS_key" ON "index_partitions"("tenantId", "knowledgeSpaceId", "dataClass", "indexSchemaVersion", "embeddingVersion");

-- CreateIndex
CREATE INDEX "release_manifests_tenantId_knowledgeSpaceId_idx" ON "release_manifests"("tenantId", "knowledgeSpaceId");

-- CreateIndex
CREATE UNIQUE INDEX "release_manifests_tenantId_contentHash_key" ON "release_manifests"("tenantId", "contentHash");

-- AddForeignKey
ALTER TABLE "knowledge_spaces" ADD CONSTRAINT "knowledge_spaces_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_knowledgeSpaceId_fkey" FOREIGN KEY ("knowledgeSpaceId") REFERENCES "knowledge_spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_manifests" ADD CONSTRAINT "ingestion_manifests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retrieval_manifests" ADD CONSTRAINT "retrieval_manifests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_manifests" ADD CONSTRAINT "answer_manifests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_manifests" ADD CONSTRAINT "pipeline_manifests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_manifests" ADD CONSTRAINT "pipeline_manifests_ingestionManifestId_fkey" FOREIGN KEY ("ingestionManifestId") REFERENCES "ingestion_manifests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_manifests" ADD CONSTRAINT "pipeline_manifests_retrievalManifestId_fkey" FOREIGN KEY ("retrievalManifestId") REFERENCES "retrieval_manifests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_manifests" ADD CONSTRAINT "pipeline_manifests_answerManifestId_fkey" FOREIGN KEY ("answerManifestId") REFERENCES "answer_manifests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "index_partitions" ADD CONSTRAINT "index_partitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "index_partitions" ADD CONSTRAINT "index_partitions_knowledgeSpaceId_fkey" FOREIGN KEY ("knowledgeSpaceId") REFERENCES "knowledge_spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_manifests" ADD CONSTRAINT "release_manifests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_manifests" ADD CONSTRAINT "release_manifests_knowledgeSpaceId_fkey" FOREIGN KEY ("knowledgeSpaceId") REFERENCES "knowledge_spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_manifests" ADD CONSTRAINT "release_manifests_indexPartitionId_fkey" FOREIGN KEY ("indexPartitionId") REFERENCES "index_partitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_manifests" ADD CONSTRAINT "release_manifests_ingestionManifestId_fkey" FOREIGN KEY ("ingestionManifestId") REFERENCES "ingestion_manifests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
