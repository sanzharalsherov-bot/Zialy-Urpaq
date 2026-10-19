const assert = require('node:assert/strict');
const { test } = require('node:test');
require('reflect-metadata');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { AssignmentsService } = require('../dist/assignments/assignments.service');
const { CreateAssignmentDto, SubmitAnswersDto, GradeSubmissionDto } = require('../dist/assignments/assignments.dto');

const admin = { sub: 'admin', role: 'ADMIN' };
const teacher = { sub: 'teacher', role: 'TEACHER' };
const student = { sub: 'student-one', role: 'STUDENT', kind: 'shared_student', firstName: 'Айша', lastName: 'Ахметова' };
const question = (id = 'q1', type = 'SINGLE_CHOICE') => ({
  id, type, prompt: 'Question', position: 1, required: true, points: 2.5,
  config: { correctValue: 42, tolerance: 0, answer: 'secret', nested: { solution: 'secret' } },
  options: type.endsWith('CHOICE') ? [{ id: 'correct', text: 'Yes', isCorrect: true, position: 1 }, { id: 'wrong', text: 'No', isCorrect: false, position: 2 }] : [],
});
const assignment = questions => ({ id: 'a1', title: 'Test', description: '', status: 'PUBLISHED', classId: null,
  creatorId: teacher.sub, maxAttempts: 1, timeLimitMinutes: 10, availableFrom: null, dueAt: null,
  totalPoints: 2.5, questions: questions ?? [question()],
});
const submission = (overrides = {}) => ({ id: 's1', assignmentId: 'a1', status: 'IN_PROGRESS',
  startedAt: new Date(), submittedAt: null, attemptNo: 1, totalScore: null, answers: [], assignment: assignment(), ...overrides });
function serviceWith(tx) {
  const queries = [];
  tx.$queryRaw = async (strings, ...values) => { queries.push({ sql: strings.join('?'), values }); return []; };
  const prisma = { ...tx, $transaction: async work => work(tx) };
  return { service: new AssignmentsService(prisma), tx, queries };
}
const rejectedStatus = status => error => error?.getStatus?.() === status;

test('student cannot call staff operations, and only admin may delete', async () => {
  const { service } = serviceWith({});
  for (const operation of [() => service.listForStaff(student), () => service.dashboard(student),
    () => service.create({}, student), () => service.publish('a1', student), () => service.results('a1', student),
    () => service.grade('s1', { answers: [] }, student), () => service.delete('a1', student), () => service.delete('a1', teacher),
    () => service.start('a1', teacher), () => service.listAvailable(admin)]) {
    await assert.rejects(operation, rejectedStatus(403));
  }
});

test('teacher listing, results, publishing, and grading are restricted to the creator', async () => {
  const seen = [];
  const { service } = serviceWith({
    assignment: { findMany: async args => { seen.push(args.where); return []; }, findFirst: async args => { seen.push(args.where); return null; } },
    submission: { findFirst: async args => { seen.push(args.where.assignment); return null; } },
  });
  await service.listForStaff(teacher);
  await assert.rejects(() => service.results('other', teacher), rejectedStatus(404));
  await assert.rejects(() => service.publish('other', teacher), rejectedStatus(404));
  await assert.rejects(() => service.grade('other', { answers: [] }, teacher), rejectedStatus(404));
  assert.equal(seen.length, 4);
  assert.ok(seen.every(where => where.creatorId === teacher.sub));
  await service.listForStaff(admin);
  assert.deepEqual(seen.at(-1), {});
});

test('student receives no marking config or correct-option flags and repeated code join resumes the original attempt', async () => {
  let creates = 0;
  const original = { id: 'existing', attemptNo: 1, startedAt: new Date('2026-01-01T00:00:00Z'), status: 'IN_PROGRESS', answers: [], questionOrder: ['q1', 'numeric'], optionOrder: {} };
  const testAssignment = { ...assignment([question(), question('numeric', 'NUMERIC')]), joinCode: 'ABCD123456', shuffleQuestions: false, shuffleOptions: false, lobbyTarget: null, roomStartedAt: null };
  const { service, queries } = serviceWith({
    assignment: { findFirst: async () => testAssignment },
    roomJoinAttempt: { findUnique: async () => null, deleteMany: async () => {} },
    auditLog: { create: async () => {} },
    submission: { findFirst: async () => original, count: async () => 1, create: async () => { creates++; throw Error('Should not create a second attempt'); } },
  });
  const result = await service.start('a1', student, 'ABCD123456', '127.0.0.1');
  assert.equal(result.submission.id, 'existing');
  assert.equal(creates, 0);
  assert.ok(queries.some(q => q.sql.includes('pg_advisory_xact_lock')));
  for (const q of result.assignment.questions) {
    assert.equal('config' in q, false);
    assert.ok(q.options.every(option => !('isCorrect' in option)));
  }
  assert.doesNotMatch(JSON.stringify(result), /correctValue|solution|"secret"/);
});

test('legacy direct attempt cannot bypass the per-test room code', async () => {
  const { service } = serviceWith({});
  await assert.rejects(() => service.start('a1', student), rejectedStatus(400));
});

test('attempt exhaustion is a controlled 400 response', async () => {
  const { service } = serviceWith({ assignment: { findFirst: async () => assignment() },
    submission: { findFirst: async () => null, count: async () => 1 } });
  await assert.rejects(() => service.start('a1', student), rejectedStatus(400));
});

test('shared student sees only unscoped assignments, and guessed room IDs cannot bypass room codes', async () => {
  const seen = [];
  const { service } = serviceWith({ assignment: {
    findMany: async args => { seen.push(args.where); return []; },
    findFirst: async args => { seen.push(args.where); return null; },
  }, roomJoinAttempt: { findUnique: async () => null, upsert: async () => {} }, auditLog: { create: async () => {} } });
  await service.listAvailable(student);
  await assert.rejects(() => service.start('class-only', student, 'ABCD123456', '127.0.0.1'), rejectedStatus(400));
  assert.ok(seen.every(where => where.classId === null));
});

test('submitting another student attempt is rejected and ownership is checked inside the lock', async () => {
  let where;
  const { service, queries } = serviceWith({ submission: { findFirst: async args => { where = args.where; return null; } } });
  await assert.rejects(() => service.submit('a1', 'other-submission', { answers: [] }, student), rejectedStatus(404));
  assert.equal(where.id, 'other-submission');
  assert.equal(where.assignmentId, 'a1');
  assert.equal(where.status, 'IN_PROGRESS');
  assert.match(where.studentIdentityKey, /^[a-f0-9]{64}$/);
  assert.match(queries[0].sql, /FOR UPDATE/);
});

test('unknown questions, repeated questions and fabricated option IDs cannot be submitted', async () => {
  const { service } = serviceWith({ submission: { findFirst: async () => submission() } });
  for (const answers of [
    [{ questionId: 'foreign', jsonValue: 'correct' }],
    [{ questionId: 'q1', jsonValue: 'correct' }, { questionId: 'q1', jsonValue: 'wrong' }],
    [{ questionId: 'q1', jsonValue: 'foreign-option' }],
    [{ questionId: 'q1', jsonValue: { answer: 'correct' } }],
    [{ questionId: 'q1', jsonValue: 'correct', numericValue: 42 }],
  ]) await assert.rejects(() => service.submit('a1', 's1', { answers }, student), rejectedStatus(400));
});

test('multiple choice requires an exact valid set, rejecting duplicates and mixed types', async () => {
  const q = question('q1', 'MULTIPLE_CHOICE');
  const writes = [];
  const { service } = serviceWith({ submission: { findFirst: async () => submission({ assignment: assignment([q]) }),
    update: async ({ data }) => data }, answer: { deleteMany: async () => {}, createMany: async args => writes.push(args.data) } });
  for (const jsonValue of [['correct', 'correct'], ['correct', 1], ['foreign'], 'correct']) {
    await assert.rejects(() => service.submit('a1', 's1', { answers: [{ questionId: 'q1', jsonValue }] }, student), rejectedStatus(400));
  }
  const saved = await service.submit('a1', 's1', { answers: [{ questionId: 'q1', jsonValue: ['correct'] }] }, student);
  assert.equal(saved.totalScore, 2.5);
  const wrong = await service.submit('a1', 's1', { answers: [{ questionId: 'q1', jsonValue: ['correct', 'wrong'] }] }, student);
  assert.equal(wrong.totalScore, 0);
  assert.equal(writes.length, 2);
});

test('numeric grading applies tolerance and rejects polymorphic payloads', async () => {
  const q = question('q1', 'NUMERIC'); q.config = { correctValue: 42, tolerance: 0.1 };
  const { service } = serviceWith({ submission: { findFirst: async () => submission({ assignment: assignment([q]) }),
    update: async ({ data }) => data }, answer: { deleteMany: async () => {}, createMany: async () => {} } });
  const saved = await service.submit('a1', 's1', { answers: [{ questionId: 'q1', numericValue: 42.05 }] }, student);
  assert.equal(saved.totalScore, 2.5);
  await assert.rejects(() => service.submit('a1', 's1', { answers: [{ questionId: 'q1', numericValue: 42, jsonValue: { correct: true } }] }, student), rejectedStatus(400));
});

test('late submissions are graded only from autosaved answers, never their late request body', async () => {
  for (const overrides of [{ startedAt: new Date(Date.now() - 11 * 60000), answers: [{ questionId: 'q1', jsonValue: 'wrong', textValue: null, numericValue: null }] },
    { assignment: { ...assignment(), dueAt: new Date(Date.now() - 1000) }, answers: [{ questionId: 'q1', jsonValue: 'correct', textValue: null, numericValue: null }] }]) {
    const { service } = serviceWith({ submission: { findFirst: async () => submission(overrides), update: async ({ data }) => data },
      answer: { deleteMany: async () => {}, createMany: async () => {} } });
    const saved = await service.submit('a1', 's1', { answers: [{ questionId: 'q1', jsonValue: 'correct' }] }, student);
    assert.equal(saved.status, 'EXPIRED');
    assert.equal(saved.timedOut, true);
    assert.equal(saved.totalScore, overrides.assignment ? 2.5 : 0);
    assert.ok(saved.gradedAt instanceof Date);
  }
});

test('manual scores may exceed a text question legacy maximum and remain exact to cents', async () => {
  let history; const changed = [];
  const answers = [{ id: 'text', question: { type: 'SHORT_TEXT', points: 1 }, awardedPoints: null },
    { id: 'auto', question: { type: 'SINGLE_CHOICE', points: 0.1 }, awardedPoints: 0.1 }];
  const { service } = serviceWith({
    submission: { findFirst: async () => submission({ status: 'UNDER_REVIEW', submittedAt: new Date(), answers }), update: async ({ data }) => data },
    answer: { update: async args => changed.push(args) }, gradeHistory: { create: async args => { history = args.data; } },
  });
  const result = await service.grade('s1', { answers: [{ answerId: 'text', awardedPoints: 12.2 }] }, teacher);
  assert.equal(result.status, 'GRADED'); assert.equal(result.totalScore, 12.3);
  assert.equal(history.newScore, 12.3); assert.equal(history.changedById, teacher.sub);
  assert.equal(changed[0].data.isCorrect, true);
});

test('grading rejects unfinished work, incomplete manual grading, repeated IDs and score manipulation', async () => {
  const answers = [{ id: 'text', question: { type: 'SHORT_TEXT', points: 0 }, awardedPoints: null },
    { id: 'auto', question: { type: 'SINGLE_CHOICE', points: 2 }, awardedPoints: 2 }];
  let current = submission({ answers });
  const { service } = serviceWith({ submission: { findFirst: async () => current } });
  await assert.rejects(() => service.grade('s1', { answers: [] }, teacher), rejectedStatus(400));
  current = { ...current, status: 'UNDER_REVIEW', submittedAt: new Date() };
  for (const grades of [[], [{ answerId: 'foreign', awardedPoints: 1 }],
    [{ answerId: 'text', awardedPoints: 1 }, { answerId: 'text', awardedPoints: 1 }],
    [{ answerId: 'text', awardedPoints: -1 }], [{ answerId: 'text', awardedPoints: NaN }],
    [{ answerId: 'text', awardedPoints: 1.111 }], [{ answerId: 'auto', awardedPoints: 3 }, { answerId: 'text', awardedPoints: 1 }],
  ]) await assert.rejects(() => service.grade('s1', { answers: grades }, teacher), rejectedStatus(400));
});

test('creation discards text maximum, retains automatic points, strips extra answer config, and trims text', async () => {
  let created;
  const { service } = serviceWith({ subject: { upsert: async () => ({ id: 'subject' }) },
    assignment: { create: async args => { created = args.data; return args.data; } } });
  await service.create({ subjectName: ' Math ', title: ' Exam ', questions: [
    { type: 'SHORT_TEXT', prompt: ' Essay ', points: 100 },
    { type: 'NUMERIC', prompt: 'Number', points: 2.5, config: { correctValue: 42, tolerance: 0, secret: 'discard' } },
  ] }, teacher);
  assert.equal(created.title, 'Exam'); assert.equal(created.questions.create[0].points, 0);
  assert.equal(created.totalPoints, 2.5);
  assert.deepEqual(created.questions.create[1].config, { correctValue: 42, tolerance: 0 });
});

test('unusable definitions and Decimal overflow fail before inserting subjects or assignments', async () => {
  const { service } = serviceWith({});
  const base = { subjectName: 'Math', title: 'Exam' };
  for (const questions of [
    [{ type: 'SHORT_TEXT', prompt: '   ' }], [{ type: 'MATCHING', prompt: 'unsupported' }],
    [{ type: 'NUMERIC', prompt: 'number', config: { correctValue: 1, tolerance: -1 } }],
    [{ type: 'NUMERIC', prompt: 'number', config: { correctValue: 0.000001 } }],
    [{ type: 'SINGLE_CHOICE', prompt: 'choice', points: 0, options: [{ text: 'a', isCorrect: true }, { text: 'b' }] }],
    Array.from({ length: 101 }, () => ({ type: 'NUMERIC', prompt: 'n', points: 10000, config: { correctValue: 1 } })),
  ]) await assert.rejects(() => service.create({ ...base, questions }, teacher), rejectedStatus(400));
});

test('DTO boundary rejects whitespace, excess decimal precision, unsupported types and numeric overflow', async () => {
  for (const [Dto, input] of [
    [CreateAssignmentDto, { title: ' ', subjectName: 'Math', questions: [{ type: 'SHORT_TEXT', prompt: 'ok' }] }],
    [CreateAssignmentDto, { title: 'Exam', subjectName: 'Math', questions: [{ type: 'FILE_UPLOAD', prompt: 'ok' }] }],
    [CreateAssignmentDto, { title: 'Exam', subjectName: 'Math', questions: [{ type: 'NUMERIC', prompt: 'ok', points: 0.001 }] }],
    [CreateAssignmentDto, { title: 'Exam', subjectName: 'Math', questions: [{ type: 'NUMERIC', prompt: 'ok', config: [] }] }],
    [SubmitAnswersDto, { answers: [{ questionId: 'q1', numericValue: 1e20 }] }],
    [SubmitAnswersDto, { answers: [{ questionId: 'q1', numericValue: 1.12345 }] }],
    [GradeSubmissionDto, { answers: [{ answerId: 'answer', awardedPoints: 1.234 }] }],
  ]) assert.ok((await validate(plainToInstance(Dto, input))).length > 0, JSON.stringify(input));
});
