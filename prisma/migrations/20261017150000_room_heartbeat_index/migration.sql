-- Keep lobby heartbeats cheap when many students are waiting in parallel.
CREATE INDEX "Submission_assignmentId_status_lastSeenAt_idx"
ON "Submission"("assignmentId", "status", "lastSeenAt");
