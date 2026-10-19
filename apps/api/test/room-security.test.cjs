const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AssignmentsService } = require('../dist/assignments/assignments.service');

const teacher = { sub: 'teacher-1', role: 'TEACHER' };
const student = { sub: 'student-1', role: 'STUDENT', kind: 'shared_student', firstName: 'Айша', lastName: 'Ахметова' };

function makeService(tx, prismaOverrides = {}) {
  tx.$queryRaw ??= async () => [];
  return new AssignmentsService({ ...tx, $transaction: async work => work(tx), ...prismaOverrides });
}

test('room-code guessing is logged and the third miss starts a 15-minute block', async () => {
  let row = null;
  const audit = [];
  const tx = {
    roomJoinAttempt: {
      findUnique: async () => row,
      upsert: async ({ create, update }) => { row = { ...row, ...create, ...update }; return row; },
    },
    auditLog: { create: async ({ data }) => audit.push(data) },
  };
  const service = makeService(tx);
  const now = new Date('2026-10-17T10:00:00Z');
  for (const expectedStatus of [400, 400, 429, 429]) {
    await assert.rejects(service.rejectRoomCode('a'.repeat(64), student.sub, now), error => error.getStatus?.() === expectedStatus);
  }
  assert.equal(row.failures, 3);
  assert.equal(row.blockedUntil.getTime(), now.getTime() + 15 * 60_000);
  assert.equal(audit.length, 4);
  assert.ok(audit.every(item => item.action === 'ROOM_CODE_REJECTED' && !JSON.stringify(item.metadata).includes('code')));
});

test('one student guessing a room code does not block classmates behind the same school IP', async () => {
  const rows = new Map();
  const tx = {
    assignment: { findFirst: async () => null },
    roomJoinAttempt: {
      findUnique: async ({ where }) => rows.get(where.ipKey) ?? null,
      upsert: async ({ where, create, update }) => {
        const row = { ...(rows.get(where.ipKey) ?? {}), ...create, ...update };
        rows.set(where.ipKey, row);
        return row;
      },
    },
    auditLog: { create: async () => {} },
  };
  const service = makeService(tx);
  for (const expectedStatus of [400, 400, 429]) {
    await assert.rejects(service.joinRoom('WRONG01', '192.168.1.10', student), error => error.getStatus?.() === expectedStatus);
  }
  const classmate = { ...student, sub: 'student-2', firstName: 'Данияр' };
  await assert.rejects(service.joinRoom('WRONG01', '192.168.1.10', classmate), error => error.getStatus?.() === 400);
  assert.equal(rows.size, 2);
});

test('teacher cannot launch a room before the configured lobby fills', async () => {
  const service = makeService({
    assignment: { findFirst: async () => ({ id: 'a1', lobbyTarget: 5, status: 'PUBLISHED' }) },
    submission: { count: async () => 4, updateMany: async () => ({ count: 4 }) },
    auditLog: { create: async () => {} },
  });
  await assert.rejects(() => service.startRoom('a1', teacher), error => error.getStatus?.() === 400 && /4 из 5/.test(error.message));
});

test('staff lobby polling returns only room counts instead of loading test content', async () => {
  let groupedWhere;
  const service = makeService({
    assignment: { findMany: async ({ select }) => {
      assert.deepEqual(select, { id: true, roomStartedAt: true });
      return [{ id: 'a1', roomStartedAt: null }, { id: 'a2', roomStartedAt: null }];
    } },
    submission: { groupBy: async ({ where }) => {
      groupedWhere = where;
      return [{ assignmentId: 'a1', _count: { assignmentId: 3 } }];
    } },
  });
  assert.deepEqual(await service.roomSummaries(teacher), [
    { id: 'a1', roomStartedAt: null, waitingCount: 3 },
    { id: 'a2', roomStartedAt: null, waitingCount: 0 },
  ]);
  assert.deepEqual(groupedWhere.assignmentId, { in: ['a1', 'a2'] });
  assert.equal(groupedWhere.status, 'WAITING');
  assert.ok(groupedWhere.lastSeenAt.gte instanceof Date);
});

test('legacy proctor events count continuous episodes once and preserve saved answers on third warning', async () => {
  let warnings = 0;
  const events = [];
  let finalized;
  const service = makeService({
    submission: {
      findFirst: async () => ({ id: 's1', assignmentId: 'a1', proctorWarnings: warnings, answers: [{ questionId: 'q1', textValue: null, numericValue: null, jsonValue: 'option-a' }] }),
      update: async ({ data }) => { warnings = data.proctorWarnings; return data; },
    },
    proctorEvent: {
      findFirst: async () => events.at(-1) ?? null,
      create: async ({ data }) => { events.push(data); return data; },
    },
    auditLog: { create: async () => {} },
  });
  service.finalize = async (assignmentId, submissionId, dto, actor, finishReason) => {
    finalized = { assignmentId, submissionId, dto, actor, finishReason };
    return { id: submissionId, status: 'GRADED', totalScore: 1 };
  };
  assert.equal((await service.proctorEvent('s1', { eventType: 'VISIBILITY_HIDDEN' }, student)).warnings, 1);
  assert.equal((await service.proctorEvent('s1', { eventType: 'VISIBILITY_HIDDEN' }, student)).warnings, 1, 'duplicate hidden signals stay in the same episode');
  assert.equal((await service.proctorEvent('s1', { eventType: 'VISIBILITY_RESTORED' }, student)).warnings, 1);
  assert.equal((await service.proctorEvent('s1', { eventType: 'PAGE_HIDDEN' }, student)).warnings, 2);
  await service.proctorEvent('s1', { eventType: 'VISIBILITY_RESTORED' }, student);
  const result = await service.proctorEvent('s1', { eventType: 'VISIBILITY_HIDDEN' }, student);
  assert.equal(result.warnings, 3);
  assert.equal(result.finished, true);
  assert.equal(result.status, 'GRADED');
  assert.equal(finalized.assignmentId, 'a1');
  assert.equal(finalized.dto.answers[0].jsonValue, 'option-a');
  assert.equal(finalized.finishReason, 'PROCTORING_VIOLATION_LIMIT');
});

test('question and option orders are fixed per attempt and include every ID once', () => {
  const service = makeService({});
  const result = service.attemptOrder({ shuffleQuestions: true, shuffleOptions: true, questions: [
    { id: 'q1', options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    { id: 'q2', options: [{ id: 'd' }, { id: 'e' }] },
  ] });
  assert.deepEqual([...result.questionOrder].sort(), ['q1', 'q2']);
  assert.deepEqual([...result.optionOrder.q1].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...result.optionOrder.q2].sort(), ['d', 'e']);
});
