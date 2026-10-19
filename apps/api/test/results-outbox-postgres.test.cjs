const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
require('reflect-metadata');
const { PrismaClient } = require('@prisma/client');
const { deliverOutboxBatch } = require('../dist/assignments/results-outbox.service');

const sourceUrl = process.env.TEST_DATABASE_URL;
const sinkUrl = process.env.TEST_RESULTS_DATABASE_URL;

test('PostgreSQL: result export is delivered to the separate database idempotently', {
  skip: (!sourceUrl || !sinkUrl) && 'Set TEST_DATABASE_URL and TEST_RESULTS_DATABASE_URL to isolated PostgreSQL test databases',
  timeout: 60000,
}, async t => {
  for (const value of [sourceUrl, sinkUrl]) {
    const url = new URL(value);
    assert.match(url.pathname, /test|audit/i, 'Refusing to use a database without test/audit in its name');
    assert.ok(['127.0.0.1', 'localhost', 'postgres-test', 'postgres', 'results-postgres'].includes(url.hostname), 'Use isolated local PostgreSQL instances');
  }

  const source = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
  const sink = new PrismaClient({ datasources: { db: { url: sinkUrl } } });
  const id = `export-test-${randomUUID()}`;
  // The database default is evaluated after this test timestamp is captured.
  // Leave a small margin so the newly created row is already eligible to claim.
  const now = new Date(Date.now() + 2_000);
  const payload = {
    id, assignmentId: `assignment-${randomUUID()}`, roomId: null, status: 'GRADED',
    totalScore: 7.5, submittedAt: now.toISOString(), startedAt: now.toISOString(),
    studentFirstName: 'Integration', studentLastName: 'Test', answers: [],
  };

  t.after(async () => {
    try {
      await sink.$executeRaw`DELETE FROM "ExportedResult" WHERE "sourceSubmissionId" = ${id}`;
      await source.resultExportOutbox.deleteMany({ where: { sourceSubmissionId: id } });
    } finally {
      await Promise.all([source.$disconnect(), sink.$disconnect()]);
    }
  });

  await source.resultExportOutbox.create({ data: { sourceSubmissionId: id, payload } });
  assert.equal(await deliverOutboxBatch(source, sink, now), 1);
  const exported = await sink.$queryRaw`SELECT "sourceSubmissionId", "assignmentId", "totalScore", "payload" FROM "ExportedResult" WHERE "sourceSubmissionId" = ${id}`;
  assert.equal(exported.length, 1);
  assert.equal(exported[0].sourceSubmissionId, id);
  assert.equal(exported[0].assignmentId, payload.assignmentId);
  assert.equal(Number(exported[0].totalScore), 7.5);

  assert.equal(await deliverOutboxBatch(source, sink, now), 0, 'Delivered rows are not reprocessed');
  assert.equal(await sink.$queryRaw`SELECT "sourceSubmissionId" FROM "ExportedResult" WHERE "sourceSubmissionId" = ${id}`.then(rows => rows.length), 1);
  assert.ok((await source.resultExportOutbox.findUnique({ where: { sourceSubmissionId: id } })).exportedAt);
});
