CREATE TYPE "RoomStatus" AS ENUM ('LOBBY', 'RUNNING', 'FINISHED', 'CANCELLED');

CREATE TABLE "TestRoom" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "joinCode" VARCHAR(6) NOT NULL,
    "status" "RoomStatus" NOT NULL DEFAULT 'LOBBY',
    "lobbyTarget" INTEGER NOT NULL,
    "durationMinutes" INTEGER,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TestRoom_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RoomParticipant" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "sessionHash" CHAR(64) NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoomParticipant_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Submission" ADD COLUMN "roomId" TEXT;
ALTER TABLE "Submission" ADD COLUMN "participantId" TEXT;

CREATE UNIQUE INDEX "TestRoom_joinCode_key" ON "TestRoom"("joinCode");
CREATE INDEX "TestRoom_assignmentId_status_idx" ON "TestRoom"("assignmentId", "status");
CREATE INDEX "TestRoom_creatorId_status_idx" ON "TestRoom"("creatorId", "status");
CREATE UNIQUE INDEX "RoomParticipant_sessionHash_key" ON "RoomParticipant"("sessionHash");
CREATE INDEX "RoomParticipant_roomId_joinedAt_idx" ON "RoomParticipant"("roomId", "joinedAt");
CREATE INDEX "Submission_roomId_status_idx" ON "Submission"("roomId", "status");
CREATE INDEX "Submission_participantId_status_idx" ON "Submission"("participantId", "status");

ALTER TABLE "TestRoom" ADD CONSTRAINT "TestRoom_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TestRoom" ADD CONSTRAINT "TestRoom_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomParticipant" ADD CONSTRAINT "RoomParticipant_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "TestRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "TestRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_participantId_fkey"
  FOREIGN KEY ("participantId") REFERENCES "RoomParticipant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve existing room state and link legacy attempts without removing or
-- rewriting assignments, questions, submissions, or answers.  The numeric
-- sequence is unique and deterministic for this migration's eligible rows.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM "Assignment" a WHERE a."lobbyTarget" IS NOT NULL
      OR EXISTS (SELECT 1 FROM "Submission" s WHERE s."assignmentId" = a."id")) > 999999 THEN
    RAISE EXCEPTION 'Cannot safely assign unique six-digit codes to more than 999999 legacy rooms';
  END IF;
END $$;

WITH legacy AS (
  SELECT a.*,
         ROW_NUMBER() OVER (ORDER BY a."id") AS seq,
         COALESCE(a."lobbyTarget", GREATEST(1, (
           SELECT COUNT(*)::int FROM "Submission" s WHERE s."assignmentId" = a."id"
         ))) AS target,
         CASE
           WHEN a."roomStartedAt" IS NOT NULL OR EXISTS (
             SELECT 1 FROM "Submission" s WHERE s."assignmentId" = a."id" AND s."status" = 'IN_PROGRESS'
           ) THEN 'RUNNING'::"RoomStatus"
           WHEN EXISTS (
             SELECT 1 FROM "Submission" s WHERE s."assignmentId" = a."id" AND s."status" = 'WAITING'
           ) THEN 'LOBBY'::"RoomStatus"
           ELSE 'FINISHED'::"RoomStatus"
         END AS room_status,
         (SELECT COUNT(*) FROM "Submission" s WHERE s."assignmentId" = a."id") AS attempt_count
  FROM "Assignment" a
  WHERE a."lobbyTarget" IS NOT NULL
     OR EXISTS (SELECT 1 FROM "Submission" s WHERE s."assignmentId" = a."id")
)
INSERT INTO "TestRoom" ("id", "assignmentId", "creatorId", "joinCode", "status", "lobbyTarget", "durationMinutes", "startedAt", "finishedAt", "createdAt", "updatedAt")
SELECT 'legacy-room-' || l."id", l."id", l."creatorId", LPAD(l.seq::text, 6, '0'), l.room_status,
       l.target, l."timeLimitMinutes", l."roomStartedAt",
       CASE WHEN l.room_status = 'FINISHED' THEN COALESCE(l."updatedAt", CURRENT_TIMESTAMP) ELSE NULL END,
       COALESCE(l."createdAt", CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
FROM legacy l;

WITH identity_groups AS (
  SELECT tr."id" AS room_id, tr."assignmentId" AS assignment_id,
         s."studentIdentityKey", MIN(s."studentFirstName") AS first_name,
         MIN(s."studentLastName") AS last_name, MIN(s."startedAt") AS joined_at,
         ('legacy-participant-' || MD5(tr."id" || ':' || s."studentIdentityKey")) AS participant_id,
         MD5('legacy-session-a:' || tr."id" || ':' || s."studentIdentityKey") ||
         MD5('legacy-session-b:' || tr."id" || ':' || s."studentIdentityKey") AS session_hash
  FROM "TestRoom" tr
  JOIN "Submission" s ON s."assignmentId" = tr."assignmentId"
  GROUP BY tr."id", tr."assignmentId", s."studentIdentityKey"
)
INSERT INTO "RoomParticipant" ("id", "roomId", "firstName", "lastName", "sessionHash", "joinedAt", "lastSeenAt")
SELECT participant_id, room_id, first_name, last_name, session_hash, joined_at, joined_at
FROM identity_groups;

UPDATE "Submission" s
SET "roomId" = tr."id",
    "participantId" = 'legacy-participant-' || MD5(tr."id" || ':' || s."studentIdentityKey")
FROM "TestRoom" tr
WHERE tr."assignmentId" = s."assignmentId";
