const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deliverOutboxBatch, enqueueResultExport, ResultsOutboxService } = require('../dist/assignments/results-outbox.service');

test('completion snapshot is written transactionally with grade and answer details', async () => {
  let write;
  const submission = {
    id: 's1', assignmentId: 'a1', roomId: 'r1', studentFirstName: 'Әлия', studentLastName: 'Нұр',
    attemptNo: 2, status: 'GRADED', totalScore: '3.50', startedAt: new Date('2026-10-19T11:00:00Z'),
    submittedAt: new Date('2026-10-19T11:05:00Z'), finishReason: 'STUDENT_SUBMITTED', proctorWarnings: 0,
    answers: [{ questionId: 'q1', textValue: null, numericValue: null, jsonValue: ['o1'], isCorrect: true, awardedPoints: '3.50', teacherComment: null }],
  };
  const tx = {
    submission: { findUnique: async () => submission },
    resultExportOutbox: { upsert: async args => { write = args; } },
  };
  await enqueueResultExport(tx, submission.id);
  assert.equal(write.where.sourceSubmissionId, 's1');
  assert.equal(write.create.payload.totalScore, 3.5);
  assert.equal(write.create.payload.studentFirstName, 'Әлия');
  assert.equal(write.create.payload.answers[0].awardedPoints, 3.5);
});

test('outbox delivery is idempotent and marks rows only after external commit', async () => {
  const events = [];
  const row = { id: 'o1', sourceSubmissionId: 's1', payload: { score: 7 }, attempts: 0 };
  const source = {
    $queryRaw: async () => [row],
    $executeRaw: async (strings, ...values) => { events.push({ sql: strings.join('?'), values }); return 1; },
  };
  const sink = {
    $executeRaw: async (strings, ...values) => { events.push({ sql: strings.join('?'), values }); return 1; },
  };
  const delivered = await deliverOutboxBatch(source, sink, new Date('2026-10-19T12:00:00Z'));
  assert.equal(delivered, 1);
  assert.equal(events.length, 2);
  assert.match(events[0].sql, /INSERT INTO "ExportedResult"/);
  assert.match(events[1].sql, /"exportedAt"/);
});

test('failed external delivery leaves row retryable with backoff', async () => {
  const row = { id: 'o2', sourceSubmissionId: 's2', payload: { score: 1 }, attempts: 2 };
  const updates = [];
  const source = {
    $queryRaw: async () => [row],
    $executeRaw: async (strings, ...values) => { updates.push({ sql: strings.join('?'), values }); return 1; },
  };
  const sink = { $executeRaw: async () => { throw new Error('external database unavailable'); } };
  const delivered = await deliverOutboxBatch(source, sink, new Date('2026-10-19T12:00:00Z'));
  assert.equal(delivered, 0);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /"availableAt"/);
  assert.match(updates[0].sql, /"lastError"/);
});


test('health status reports pending exports without exposing database errors', async () => {
  const service = Object.create(ResultsOutboxService.prototype);
  service.prisma = { $queryRaw: async () => [{ count: 3n }] };
  service.sink = { $queryRaw: async () => [{ '?column?': 1 }] };
  assert.deepEqual(await service.healthStatus(), { status: 'pending', pendingCount: 3 });

  service.prisma = { $queryRaw: async () => [{ count: 0n }] };
  assert.deepEqual(await service.healthStatus(), { status: 'connected', pendingCount: 0 });

  service.sink = { $queryRaw: async () => { throw new Error('secret connection string must not be returned'); } };
  assert.deepEqual(await service.healthStatus(), { status: 'unavailable', pendingCount: 0 });

  service.sink = undefined;
  assert.deepEqual(await service.healthStatus(), { status: 'disabled', pendingCount: null });
});
