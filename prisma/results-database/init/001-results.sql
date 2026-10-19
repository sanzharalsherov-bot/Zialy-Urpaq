CREATE TABLE "ExportedResult" (
  "sourceSubmissionId" TEXT PRIMARY KEY,
  "assignmentId" TEXT NOT NULL,
  "roomId" TEXT,
  "status" TEXT NOT NULL,
  "totalScore" NUMERIC(10, 2),
  "submittedAt" TIMESTAMPTZ,
  "exportedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB NOT NULL
);
CREATE INDEX "ExportedResult_assignmentId_submittedAt_idx"
  ON "ExportedResult" ("assignmentId", "submittedAt" DESC);
