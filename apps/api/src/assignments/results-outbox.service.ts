import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type OutboxClient = { $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>; $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> };

export async function enqueueResultExport(tx: Prisma.TransactionClient, submissionId: string) {
  // Test doubles and non-Prisma transaction adapters may intentionally omit the optional export tables.
  if (!tx.submission.findUnique || !tx.resultExportOutbox) return;
  const submission = await tx.submission.findUnique({
    where: { id: submissionId },
    select: {
      id: true, assignmentId: true, roomId: true, studentFirstName: true, studentLastName: true,
      attemptNo: true, status: true, totalScore: true, startedAt: true, submittedAt: true,
      finishReason: true, proctorWarnings: true,
      answers: { select: { questionId: true, textValue: true, numericValue: true, jsonValue: true, isCorrect: true, awardedPoints: true, teacherComment: true } },
    },
  });
  if (!submission || !submission.submittedAt) return;
  const payload = {
    ...submission,
    totalScore: submission.totalScore === null ? null : Number(submission.totalScore),
    startedAt: submission.startedAt.toISOString(),
    submittedAt: submission.submittedAt.toISOString(),
    answers: submission.answers.map(answer => ({
      ...answer,
      numericValue: answer.numericValue === null ? null : Number(answer.numericValue),
      awardedPoints: answer.awardedPoints === null ? null : Number(answer.awardedPoints),
    })),
  } as Prisma.InputJsonValue;
  await tx.resultExportOutbox.upsert({
    where: { sourceSubmissionId: submission.id },
    create: { sourceSubmissionId: submission.id, payload },
    update: { payload, attempts: 0, availableAt: new Date(), lastError: null, exportedAt: null },
  });
}

export async function deliverOutboxBatch(source: OutboxClient, sink: OutboxClient, now = new Date()): Promise<number> {
  const leaseUntil = new Date(now.getTime() + 5 * 60_000);
  const rows = await source.$queryRaw`
    WITH picked AS (
      SELECT "id" FROM "ResultExportOutbox"
      WHERE "exportedAt" IS NULL AND "availableAt" <= ${now}
      ORDER BY "availableAt", "createdAt"
      LIMIT 20 FOR UPDATE SKIP LOCKED
    )
    UPDATE "ResultExportOutbox" AS outbox
    SET "attempts" = outbox."attempts" + 1, "availableAt" = ${leaseUntil}, "updatedAt" = ${now}
    FROM picked WHERE outbox."id" = picked."id"
    RETURNING outbox."id", outbox."sourceSubmissionId", outbox."payload", outbox."attempts"` as Array<{ id: string; sourceSubmissionId: string; payload: Record<string, any>; attempts: number }>;
  let delivered = 0;
  for (const row of rows) {
    const payload = row.payload;
    try {
      await sink.$executeRaw`
        INSERT INTO "ExportedResult" ("sourceSubmissionId", "assignmentId", "roomId", "status", "totalScore", "submittedAt", "exportedAt", "payload")
        VALUES (${row.sourceSubmissionId}, ${payload.assignmentId}, ${payload.roomId}, ${payload.status}, ${payload.totalScore}, ${payload.submittedAt}::timestamptz, ${now}, ${JSON.stringify(payload)}::jsonb)
        ON CONFLICT ("sourceSubmissionId") DO UPDATE SET
          "assignmentId" = EXCLUDED."assignmentId", "roomId" = EXCLUDED."roomId", "status" = EXCLUDED."status",
          "totalScore" = EXCLUDED."totalScore", "submittedAt" = EXCLUDED."submittedAt", "exportedAt" = EXCLUDED."exportedAt", "payload" = EXCLUDED."payload"`;
      await source.$executeRaw`UPDATE "ResultExportOutbox" SET "exportedAt" = ${now}, "lastError" = NULL, "updatedAt" = ${now} WHERE "id" = ${row.id}`;
      delivered++;
    } catch {
      const backoffMs = Math.min(15 * 60_000, 1000 * 2 ** Math.min(row.attempts, 10));
      const nextAttempt = new Date(now.getTime() + backoffMs);
      await source.$executeRaw`UPDATE "ResultExportOutbox" SET "availableAt" = ${nextAttempt}, "lastError" = 'External results database unavailable', "updatedAt" = ${now} WHERE "id" = ${row.id}`;
    }
  }
  return delivered;
}

@Injectable()
export class ResultsOutboxService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly sink?: PrismaClient;

  constructor(private readonly prisma: PrismaService) {
    const url = process.env.RESULTS_DATABASE_URL;
    if (url) this.sink = new PrismaClient({ datasources: { db: { url } } });
  }

  onModuleInit() {
    if (this.sink) this.timer = setInterval(() => { void this.flush(); }, 3000).unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.sink) void this.sink.$disconnect();
  }

  async flush() {
    if (!this.sink || this.running) return 0;
    this.running = true;
    try { return await deliverOutboxBatch(this.prisma, this.sink); }
    catch { return 0; }
    finally { this.running = false; }
  }
}
