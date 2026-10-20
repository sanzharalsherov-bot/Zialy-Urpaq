CREATE TABLE "AssignmentRecipient" (
    "assignmentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssignmentRecipient_pkey" PRIMARY KEY ("assignmentId", "studentId")
);

CREATE INDEX "AssignmentRecipient_studentId_assignmentId_idx"
ON "AssignmentRecipient"("studentId", "assignmentId");

ALTER TABLE "AssignmentRecipient"
ADD CONSTRAINT "AssignmentRecipient_assignmentId_fkey"
FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssignmentRecipient"
ADD CONSTRAINT "AssignmentRecipient_studentId_fkey"
FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
