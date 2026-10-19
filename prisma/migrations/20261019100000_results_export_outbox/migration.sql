CREATE TABLE "ResultExportOutbox" (
    "id" TEXT NOT NULL,
    "sourceSubmissionId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "exportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResultExportOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResultExportOutbox_sourceSubmissionId_key" ON "ResultExportOutbox"("sourceSubmissionId");
CREATE INDEX "ResultExportOutbox_exportedAt_availableAt_idx" ON "ResultExportOutbox"("exportedAt", "availableAt");
