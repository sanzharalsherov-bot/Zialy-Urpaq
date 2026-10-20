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
  const extraUserIds = [];
  const classIds = [];
  t.after(async () => {
    try {
      for (const id of assignmentIds) await service.delete(id, admin);
      await prisma.schoolClass.deleteMany({ where: { id: { in: classIds } } });
      await prisma.subject.deleteMany({ where: { name: subjectName } });
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, another.id, ...extraUserIds] } } });
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

  await service.grade(started.submission.id, {
    answers: [
      { answerId: rows[0].id, awardedPoints: 3, teacherComment: 'Strong reasoning' },
      { answerId: rows[1].id, awardedPoints: 5, teacherComment: 'Clear explanation' },
    ],
    feedback: 'Good work. Keep showing your reasoning.',
  }, teacher);
  const review = await service.studentResult(started.submission.id, student);
  assert.equal(review.score, 8);
  assert.equal(review.feedback, 'Good work. Keep showing your reasoning.');
  assert.deepEqual(review.answers.map(a => a.teacherComment), ['Strong reasoning', 'Clear explanation']);
  assert.deepEqual(review.answers.map(a => a.awardedPoints), [3, 5]);
  assert.ok(review.answers.every(a => a.question.options.every(option => !('isCorrect' in option))));
  assert.ok(!JSON.stringify(review).includes('correctValue'), 'Student review must not expose marking config');
  await assert.rejects(() => service.studentResult(started.submission.id, { ...student, sub: 'different-student' }), e => e.getStatus() === 404);

  const history = await service.listStudentResults(student);
  assert.equal(history.length, 2);
  assert.ok(history.some(item => item.submissionId === started.submission.id && item.feedback === 'Good work. Keep showing your reasoning.'));
  assert.ok(history.every(item => !('answers' in item) && !('correctValue' in item)), 'History is a minimal summary, not an answer-key endpoint');

  // Recipient targeting must be enforced by the database query, not just the builder UI.
  const classA = await prisma.schoolClass.create({ data: { name: `recipient-a-${suffix}`, academicYear: '2026-2027' } });
  const classB = await prisma.schoolClass.create({ data: { name: `recipient-b-${suffix}`, academicYear: '2026-2027' } });
  classIds.push(classA.id, classB.id);
  async function makeStudent(label, schoolClass) {
    const account = await prisma.user.create({ data: {
      email: `${label}-${suffix}@test.invalid`, firstName: label, lastName: 'Student',
      role: 'STUDENT', passwordHash: 'test-fixture-not-a-login',
    } });
    extraUserIds.push(account.id);
    const profile = await prisma.studentProfile.create({ data: { userId: account.id, classId: schoolClass.id } });
    return { sub: account.id, role: 'STUDENT', studentProfileId: profile.id, firstName: label, lastName: 'Student' };
  }
  const selectedStudent = await makeStudent('Selected', classA);
  const classmate = await makeStudent('Classmate', classA);
  const otherClassStudent = await makeStudent('OtherClass', classB);
  const individual = await service.create({
    title: 'Individual recipient access', subjectName, classId: classA.id, studentIds: [selectedStudent.studentProfileId],
    questions: [{ type: 'SHORT_TEXT', prompt: 'Only the selected student should see this' }],
  }, teacher);
  assignmentIds.push(individual.id);
  await service.publish(individual.id, teacher);
  const selectedAvailable = await service.listAvailable(selectedStudent);
  const classmateAvailable = await service.listAvailable(classmate);
  const otherAvailable = await service.listAvailable(otherClassStudent);
  assert.ok(selectedAvailable.some(item => item.id === individual.id));
  assert.ok(!classmateAvailable.some(item => item.id === individual.id), 'Unselected classmate must not see individually assigned work');
  assert.ok(!otherAvailable.some(item => item.id === individual.id), 'Students outside the class must not see the work');

  const classWide = await service.create({
    title: 'Whole class access', subjectName, classId: classA.id,
    questions: [{ type: 'SHORT_TEXT', prompt: 'Every student in the class should see this' }],
  }, teacher);
  assignmentIds.push(classWide.id);
  await service.publish(classWide.id, teacher);
  assert.ok((await service.listAvailable(selectedStudent)).some(item => item.id === classWide.id));
  assert.ok((await service.listAvailable(classmate)).some(item => item.id === classWide.id));
  assert.ok(!(await service.listAvailable(otherClassStudent)).some(item => item.id === classWide.id));

  const dashboard = await service.dashboard(teacher);
  assert.ok(dashboard.totalSubmissions >= 2);
  const staffResults = await service.results(manual.id, teacher);
  assert.equal(staffResults.submissions.length, 1);
  assert.equal(staffResults.submissions[0].feedback, 'Good work. Keep showing your reasoning.');

  // Exercise the return -> student revision -> resubmission path against PostgreSQL.
  const returned = await service.returnSubmission(started.submission.id, 'Please add one more detail.', teacher);
  assert.equal(returned.status, 'RETURNED');
  assert.equal(returned.feedback, 'Please add one more detail.');
  const reopened = await service.reopenReturned(started.submission.id, student);
  assert.equal(reopened.submission.status, 'IN_PROGRESS');
  assert.equal(reopened.assignment.id, manual.id);
  assert.equal(reopened.answers.length, 2, 'Existing answers must survive reopening');
  assert.ok(reopened.answers.every(answer => answer.textValue === 'Student answer'));
  await service.saveAnswers(started.submission.id, {
    answers: manual.questions.map(q => ({ questionId: q.id, textValue: `Revised answer for ${q.prompt}` })),
  }, student);
  const resubmitted = await service.submit(manual.id, started.submission.id, {
    answers: manual.questions.map(q => ({ questionId: q.id, textValue: `Revised answer for ${q.prompt}` })),
  }, student);
  assert.equal(resubmitted.status, 'UNDER_REVIEW');
  assert.equal(resubmitted.totalScore, null, 'Manual work must return to the teacher queue after resubmission');
  const revisedRows = await prisma.answer.findMany({ where: { submissionId: started.submission.id } });
  assert.ok(revisedRows.every(answer => answer.textValue.startsWith('Revised answer for ')));

});
