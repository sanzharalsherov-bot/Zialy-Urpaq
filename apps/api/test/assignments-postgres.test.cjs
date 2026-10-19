const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { PrismaClient } = require('@prisma/client');
const { AssignmentsService } = require('../dist/assignments/assignments.service');

// Run only against an explicitly supplied, disposable test database. No .env is loaded.
const databaseUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL: simultaneous attempts/submits/grades preserve limits, ownership and scoring', {
  skip: !databaseUrl && 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database', timeout: 60000,
}, async t => {
  const url = new URL(databaseUrl);
  assert.match(url.pathname, /test|audit/i, 'Refusing to use a database without test/audit in its name');
  assert.ok(['127.0.0.1', 'localhost', 'postgres-test', 'postgres'].includes(url.hostname), 'Use an isolated local PostgreSQL instance');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const service = new AssignmentsService(prisma);
  const suffix = randomUUID();
  const subjectName = `security-audit-${suffix}`;
  const owner = await prisma.user.create({ data: { email: `owner-${suffix}@test.invalid`, firstName: 'Test', lastName: 'Owner', role: 'TEACHER', passwordHash: 'test-fixture-not-a-login' } });
  const another = await prisma.user.create({ data: { email: `other-${suffix}@test.invalid`, firstName: 'Other', lastName: 'Teacher', role: 'TEACHER', passwordHash: 'test-fixture-not-a-login' } });
  const teacher = { sub: owner.id, role: 'TEACHER' };
  const admin = { sub: owner.id, role: 'ADMIN' };
  const student = { sub: `shared-student:${suffix}`, role: 'STUDENT', kind: 'shared_student', firstName: 'Оқушы', lastName: 'Test' };
  const assignmentIds = [];
  t.after(async () => {
    try {
      for (const id of assignmentIds) await service.delete(id, admin);
      await prisma.subject.deleteMany({ where: { name: subjectName } });
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, another.id] } } });
    } finally { await prisma.$disconnect(); }
  });

  const created = await service.create({ title: 'Concurrent numeric attempt', subjectName, maxAttempts: 1, questions: [
    { type: 'NUMERIC', prompt: 'What is six times seven?', points: 2.5, config: { correctValue: 42 } },
  ] }, teacher);
  assignmentIds.push(created.id);
  await service.publish(created.id, teacher);
  const starts = await Promise.all(Array.from({ length: 8 }, () => service.start(created.id, student, created.joinCode, '127.0.0.1')));
  assert.equal(new Set(starts.map(s => s.submission.id)).size, 1, 'Double click and parallel sessions resume one attempt');
  assert.equal(await prisma.submission.count({ where: { assignmentId: created.id } }), 1);
  assert.equal('config' in starts[0].assignment.questions[0], false);
  const attempt = starts[0].submission.id;
  const answers = [{ questionId: created.questions[0].id, numericValue: 42 }];
  await assert.rejects(() => service.submit(created.id, attempt, { answers }, { ...student, sub: 'another-student' }), e => e.getStatus() === 404);
  const submits = await Promise.allSettled(Array.from({ length: 8 }, () => service.submit(created.id, attempt, { answers }, student)));
  assert.equal(submits.filter(r => r.status === 'fulfilled').length, 1, 'Exactly one submit can save answers');
  assert.ok(submits.filter(r => r.status === 'rejected').every(r => r.reason.getStatus() === 404));
  assert.equal(await prisma.answer.count({ where: { submissionId: attempt } }), 1);
  assert.equal(Number((await prisma.submission.findUnique({ where: { id: attempt } })).totalScore), 2.5);
  await assert.rejects(() => service.start(created.id, student, created.joinCode, '127.0.0.1'), e => e.getStatus() === 400);
  await assert.rejects(() => service.results(created.id, { sub: another.id, role: 'TEACHER' }), e => e.getStatus() === 404);
  await assert.rejects(() => service.grade(attempt, { answers: [] }, { sub: another.id, role: 'TEACHER' }), e => e.getStatus() === 404);
  await assert.rejects(() => service.delete(created.id, teacher), e => e.getStatus() === 403);

  const manual = await service.create({ title: 'Concurrent manual review', subjectName, questions: [
    { type: 'SHORT_TEXT', prompt: 'First answer' }, { type: 'LONG_TEXT', prompt: 'Second answer' },
  ] }, teacher);
  assignmentIds.push(manual.id);
  await service.publish(manual.id, teacher);
  const started = await service.start(manual.id, student, manual.joinCode, '127.0.0.1');
  await service.submit(manual.id, started.submission.id, { answers: manual.questions.map(q => ({ questionId: q.id, textValue: 'Student answer' })) }, student);
  const rows = await prisma.answer.findMany({ where: { submissionId: started.submission.id }, orderBy: { question: { position: 'asc' } } });
  await assert.rejects(() => service.grade(started.submission.id, { answers: [] }, teacher), e => e.getStatus() === 400);
  await service.grade(started.submission.id, { answers: rows.map(a => ({ answerId: a.id, awardedPoints: 1 })) }, teacher);
  await Promise.all([
    service.grade(started.submission.id, { answers: [{ answerId: rows[0].id, awardedPoints: 3 }] }, teacher),
    service.grade(started.submission.id, { answers: [{ answerId: rows[1].id, awardedPoints: 5 }] }, teacher),
  ]);
  const final = await prisma.submission.findUnique({ where: { id: started.submission.id }, include: { answers: true, gradeHistory: { orderBy: { createdAt: 'asc' } } } });
  assert.equal(Number(final.totalScore), 8, 'Concurrent independent edits must not lose each other');
  assert.equal(final.answers.reduce((sum, a) => sum + Number(a.awardedPoints), 0), 8);
  assert.equal(final.gradeHistory.length, 3);
  const finalHistory = final.gradeHistory.find(h => Number(h.newScore) === 8);
  assert.ok([4, 6].includes(Number(finalHistory.oldScore)), 'History reflects the immediately previous committed score');
});
