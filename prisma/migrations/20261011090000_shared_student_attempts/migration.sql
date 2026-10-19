-- Shared student access: preserve each attempt's entered name, even without a StudentProfile.
ALTER TABLE "Submission" DROP CONSTRAINT "Submission_studentId_fkey";
ALTER TABLE "Submission" ALTER COLUMN "studentId" DROP NOT NULL;

ALTER TABLE "Submission"
  ADD COLUMN "studentFirstName" TEXT,
  ADD COLUMN "studentLastName" TEXT,
  ADD COLUMN "studentIdentityKey" TEXT;

UPDATE "Submission" AS s
SET
  "studentFirstName" = COALESCE(u."firstName", 'Неизвестно'),
  "studentLastName" = COALESCE(u."lastName", 'Ученик'),
  "studentIdentityKey" = 'legacy:' || s."id"
FROM "StudentProfile" AS sp
JOIN "User" AS u ON u."id" = sp."userId"
WHERE s."studentId" = sp."id";

UPDATE "Submission"
SET
  "studentFirstName" = COALESCE("studentFirstName", 'Неизвестно'),
  "studentLastName" = COALESCE("studentLastName", 'Ученик'),
  "studentIdentityKey" = COALESCE("studentIdentityKey", 'legacy:' || "id");

ALTER TABLE "Submission"
  ALTER COLUMN "studentFirstName" SET NOT NULL,
  ALTER COLUMN "studentLastName" SET NOT NULL,
  ALTER COLUMN "studentIdentityKey" SET NOT NULL;

CREATE UNIQUE INDEX "Submission_assignmentId_studentIdentityKey_attemptNo_key"
  ON "Submission"("assignmentId", "studentIdentityKey", "attemptNo");

ALTER TABLE "Submission"
  ADD CONSTRAINT "Submission_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
