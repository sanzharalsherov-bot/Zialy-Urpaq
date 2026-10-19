ALTER TYPE "SubmissionStatus" ADD VALUE 'WAITING';

ALTER TABLE "Assignment"
  ADD COLUMN "joinCode" TEXT,
  ADD COLUMN "lobbyTarget" INTEGER,
  ADD COLUMN "roomStartedAt" TIMESTAMP(3),
  ADD COLUMN "shuffleQuestions" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "shuffleOptions" BOOLEAN NOT NULL DEFAULT true;

UPDATE "Assignment"
SET "joinCode" = UPPER(SUBSTRING(MD5("id" || clock_timestamp()::TEXT), 1, 12))
WHERE "joinCode" IS NULL;

ALTER TABLE "Assignment" ALTER COLUMN "joinCode" SET NOT NULL;
CREATE UNIQUE INDEX "Assignment_joinCode_key" ON "Assignment"("joinCode");

ALTER TABLE "Submission"
  ADD COLUMN "questionOrder" JSONB,
  ADD COLUMN "optionOrder" JSONB,
  ADD COLUMN "proctorWarnings" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastSeenAt" TIMESTAMP(3);

CREATE TABLE "ProctorEvent" (
  "id" TEXT NOT NULL,
  "submissionId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProctorEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProctorEvent_submissionId_createdAt_idx" ON "ProctorEvent"("submissionId", "createdAt");
ALTER TABLE "ProctorEvent" ADD CONSTRAINT "ProctorEvent_submissionId_fkey"
  FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RoomJoinAttempt" (
  "id" TEXT NOT NULL,
  "ipKey" TEXT NOT NULL,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "blockedUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RoomJoinAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RoomJoinAttempt_ipKey_key" ON "RoomJoinAttempt"("ipKey");
CREATE INDEX "RoomJoinAttempt_updatedAt_idx" ON "RoomJoinAttempt"("updatedAt");
CREATE INDEX "RoomJoinAttempt_blockedUntil_idx" ON "RoomJoinAttempt"("blockedUntil");
