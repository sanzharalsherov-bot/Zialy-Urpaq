const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Prisma } = require('@prisma/client');
require('reflect-metadata');
const { RoomsService } = require('../dist/assignments/rooms.service');
const { CreateRoomDto } = require('../dist/assignments/rooms.dto');
const { validate } = require('class-validator');

function knownError(code) {
  return new Prisma.PrismaClientKnownRequestError('unique collision', { code, clientVersion: 'test' });
}

function fakePrisma() {
  const rooms = [];
  const prisma = {
    rooms,
    assignment: { findFirst: async ({ where }) => where.id === 'assignment-1' && (!where.creatorId || where.creatorId === 'teacher-1')
      ? { id: 'assignment-1', creatorId: 'teacher-1', status: 'PUBLISHED', timeLimitMinutes: 25, questions: [{ id: 'q1', type: 'SINGLE_CHOICE', options: [{ isCorrect: true }, { isCorrect: false }] }] } : null },
    testRoom: {
      create: async ({ data }) => {
        const row = { id: `room-${rooms.length + 1}`, ...data, status: 'LOBBY', startedAt: null, _count: { participants: 0 }, assignment: { title: 'Math' } };
        rooms.push(row); return row;
      },
      findMany: async ({ where }) => rooms.filter(room => !where.creatorId || room.creatorId === where.creatorId),
    },
  };
  return prisma;
}

function fakeJoinPrisma(status = 'LOBBY') {
  const room = {
    id: 'room-join', assignmentId: 'assignment-1', creatorId: 'teacher-1', joinCode: '004271',
    status, lobbyTarget: 10, durationMinutes: 30, startedAt: status === 'RUNNING' ? new Date() : null,
    snapshot: status === 'RUNNING' ? { version: 1, questions: [{ sourceQuestionId: 'q1', type: 'SINGLE_CHOICE', prompt: '2+2?', points: 1, required: true, options: [{ id: 'a', text: '4', isCorrect: true }, { id: 'b', text: '5', isCorrect: false }] }], durationMinutes: 30 } : null,
    assignment: { id: 'assignment-1', title: 'Math' }, participants: [],
  };
  const participants = []; const submissions = []; const audit = []; const answers = []; const proctorEvents = [];
  const attempts = new Map();
  let next = 0;
  const prisma = {
    room,
    roomParticipant: {
      findFirst: async ({ where }) => { const participant = participants.find(p => p.roomId === where.roomId && p.sessionHash === where.sessionHash); return participant ? { ...participant, room } : null; },
      create: async ({ data }) => { const value = { id: `participant-${++next}`, ...data }; participants.push(value); room.participants.push(value); return value; },
      update: async ({ where, data }) => Object.assign(participants.find(p => p.id === where.id), data),
    },
    submission: {
      findFirst: async ({ where }) => submissions.filter(s => (!where.id || s.id === where.id) && (!where.roomId || s.roomId === where.roomId) && (!where.participantId || s.participantId === where.participantId) && (!where.status || s.status === where.status)).sort((a, b) => b.attemptNo - a.attemptNo)[0] ?? null,
      count: async ({ where }) => submissions.filter(s => (!where.participantId || s.participantId === where.participantId) && (!where.assignmentId || s.assignmentId === where.assignmentId) && (!where.roomId || s.roomId === where.roomId) && (!where.status || s.status === where.status)).length,
      create: async ({ data }) => { const value = { id: `attempt-${submissions.length + 1}`, answers: [], proctorWarnings: 0, ...data }; submissions.push(value); return value; },
      update: async ({ where, data }) => Object.assign(submissions.find(s => s.id === where.id), data),
      findMany: async ({ where }) => submissions.filter(s => s.roomId === where.roomId && s.status === where.status).map(s => ({ id: s.id, studentFirstName: s.studentFirstName, studentLastName: s.studentLastName, totalScore: s.totalScore, submittedAt: s.submittedAt })),
    },
    proctorEvent: {
      findFirst: async ({ where, orderBy }) => proctorEvents.filter(event => event.submissionId === where.submissionId && (!where.eventType?.in || where.eventType.in.includes(event.eventType))).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
      create: async ({ data }) => { const event = { id: `proctor-${proctorEvents.length + 1}`, createdAt: new Date(Date.now() + proctorEvents.length), ...data }; proctorEvents.push(event); return event; },
    },
    testRoom: { findUnique: async ({ where }) => where.joinCode ? (where.joinCode === room.joinCode ? { id: room.id } : null) : room, update: async ({ data }) => Object.assign(room, data) },
    answer: { upsert: async ({ where, create, update }) => { let row = answers.find(a => a.submissionId === where.submissionId_questionId.submissionId && a.questionId === where.submissionId_questionId.questionId); if (!row) { row = { id: `answer-${answers.length + 1}`, ...create }; answers.push(row); submissions.find(s => s.id === row.submissionId)?.answers.push(row); } else Object.assign(row, update); return row; } },
    auditLog: { create: async ({ data }) => { audit.push(data); return data; } },
    roomJoinAttempt: {
      findUnique: async ({ where }) => attempts.get(where.ipKey) ?? null,
      upsert: async ({ where, create, update }) => { const previous = attempts.get(where.ipKey); const value = previous ? { ...previous, ...update, failures: update.failures ?? create.failures } : create; attempts.set(where.ipKey, value); return value; },
      deleteMany: async ({ where }) => { attempts.delete(where.ipKey); return { count: 1 }; },
    },
    $queryRaw: async () => [{ now: new Date('2026-10-18T00:00:00Z') }],
    $transaction: async work => work(prisma),
    participants, submissions, answers, audit, proctorEvents,
  };
  return prisma;
}

test('creates separate six-digit room codes for the same assignment', async () => {
  const db = fakePrisma(); const service = new RoomsService(db);
  const actor = { sub: 'teacher-1', role: 'TEACHER' };
  const one = await service.createRoom('assignment-1', { lobbyTarget: 10 }, actor);
  const two = await service.createRoom('assignment-1', { lobbyTarget: 10 }, actor);
  assert.match(one.joinCode, /^\d{6}$/u); assert.match(two.joinCode, /^\d{6}$/u);
  assert.notEqual(one.id, two.id); assert.notEqual(one.joinCode, two.joinCode);
  assert.equal(one.durationMinutes, 25);
});

test('room creation rejects unsupported or ungradable question types before reserving a code', async () => {
  const db = fakePrisma();
  const original = db.assignment.findFirst;
  db.assignment.findFirst = async args => {
    const assignment = await original(args);
    return assignment ? { ...assignment, questions: [{ id: 'numeric-q', type: 'NUMERIC', options: [] }] } : null;
  };
  const service = new RoomsService(db);
  await assert.rejects(
    () => service.createRoom('assignment-1', { lobbyTarget: 10 }, { sub: 'teacher-1', role: 'TEACHER' }),
    error => error.getStatus() === 400 && /только вопросы/u.test(error.message),
  );
  assert.equal(db.rooms.length, 0);
});

test('teacher scope prevents access to another teacher assignment', async () => {
  const service = new RoomsService(fakePrisma());
  await assert.rejects(() => service.createRoom('assignment-1', { lobbyTarget: 10 }, { sub: 'teacher-2', role: 'TEACHER' }), e => e.getStatus() === 404);
  await assert.rejects(() => service.createRoom('missing', { lobbyTarget: 10 }, { sub: 'teacher-1', role: 'TEACHER' }), e => e.getStatus() === 404);
});

test('teacher cannot read or analyze another teacher room', async () => {
  const queries = [];
  const db = {
    testRoom: {
      findFirst: async ({ where }) => { queries.push({ operation: 'findFirst', where }); return null; },
      findMany: async ({ where }) => { queries.push({ operation: 'findMany', where }); return []; },
    },
    assignment: { findFirst: async ({ where }) => { queries.push({ operation: 'assignment', where }); return null; } },
  };
  const service = new RoomsService(db);
  const actor = { sub: 'teacher-2', role: 'TEACHER' };
  await assert.rejects(() => service.getRoom('room-owned-by-teacher-1', actor), error => error.getStatus() === 404);
  await assert.rejects(() => service.roomAnalytics('room-owned-by-teacher-1', actor), error => error.getStatus() === 404);
  await service.listRooms(actor, 'assignment-1');
  assert.equal(queries[0].where.creatorId, 'teacher-2');
  assert.equal(queries[1].where.creatorId, 'teacher-2');
  assert.equal(queries[2].where.creatorId, 'teacher-2');
  assert.equal(queries[2].where.assignmentId, 'assignment-1');
});

test('room code collision retries with a new code', async () => {
  let calls = 0;
  const db = fakePrisma();
  const original = db.testRoom.create;
  db.testRoom.create = async args => { if (calls++ === 0) throw knownError('P2002'); return original(args); };
  const result = await new RoomsService(db).createRoom('assignment-1', { lobbyTarget: 1 }, { sub: 'teacher-1', role: 'TEACHER' });
  assert.equal(calls, 2); assert.match(result.joinCode, /^\d{6}$/u);
});

test('lobby and duration limits reject invalid values', async () => {
  const service = new RoomsService(fakePrisma());
  await assert.rejects(() => service.createRoom('assignment-1', { lobbyTarget: 41 }, { sub: 'teacher-1', role: 'TEACHER' }), e => e.getStatus() === 400);
  await assert.rejects(() => service.createRoom('assignment-1', { lobbyTarget: 1, durationMinutes: 601 }, { sub: 'teacher-1', role: 'TEACHER' }), e => e.getStatus() === 400);
});

test('CreateRoomDto rejects lobby target over forty', async () => {
  const dto = Object.assign(new CreateRoomDto(), { lobbyTarget: 41, durationMinutes: 30 });
  const errors = await validate(dto);
  assert.ok(errors.some(error => error.property === 'lobbyTarget'));
});

test('same name can join independently and each session gets only its own token', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const one = await service.joinRoom('004271', 'Aruzhan', 'Sapar', undefined, '127.0.0.1');
  const two = await service.joinRoom('004271', 'Aruzhan', 'Sapar', undefined, '127.0.0.1');
  assert.equal(one.studentRoom.room.count, 1);
  assert.equal(two.studentRoom.room.count, 2);
  assert.notEqual(one.participantId, two.participantId);
  assert.notEqual(one.attemptId, two.attemptId);
  assert.match(one.sessionToken, /^[A-Za-z0-9_-]{40,80}$/u);
  assert.match(two.sessionToken, /^[A-Za-z0-9_-]{40,80}$/u);
  assert.notEqual(db.participants[0].sessionHash, one.sessionToken, 'Only token hashes are persisted');
  assert.equal(db.participants.length, 2);
});

test('valid room token reconnects to its own attempt; unrelated token is denied', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar');
  db.room.status = 'RUNNING'; db.room.startedAt = new Date(); db.room.snapshot = fakeJoinPrisma('RUNNING').room.snapshot;
  const resumed = await service.joinRoom('004271', 'Aruzhan', 'Sapar', joined.sessionToken);
  assert.equal(resumed.attemptId, joined.attemptId);
  assert.equal(resumed.resumed, true);
  await assert.rejects(() => service.joinRoom('004271', 'Aruzhan', 'Sapar', 'x'.repeat(43)), error => error.getStatus() === 404);
});

test('valid room session can reconnect even when the device is throttled for wrong room codes', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const ip = '192.168.10.51'; const device = 'c'.repeat(64);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar', undefined, ip, device);
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      () => service.joinRoom('999999', 'Aruzhan', 'Sapar', undefined, ip, device),
      error => error.getStatus() === (i === 2 ? 429 : 404),
    );
  }
  const resumed = await service.joinRoom('004271', 'Aruzhan', 'Sapar', joined.sessionToken, ip, device);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.attemptId, joined.attemptId);
});

test('student snapshot never exposes answer keys', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar');
  db.room.status = 'RUNNING'; db.room.startedAt = new Date(); db.room.snapshot = fakeJoinPrisma('RUNNING').room.snapshot;
  const view = await service.getStudentRoom(joined.roomId, joined.sessionToken);
  assert.equal(view.questions[0].options[0].text, '4');
  assert.equal('isCorrect' in view.questions[0].options[0], false);
});

test('unknown room code does not reveal whether another code exists', async () => {
  const service = new RoomsService(fakeJoinPrisma());
  await assert.rejects(() => service.joinRoom('999999', 'Aruzhan', 'Sapar'), error => error.getStatus() === 404 && error.message.includes('Комната не найдена'));
  await assert.rejects(() => service.joinRoom('999999', 'Aruzhan', 'Sapar'), error => error.getStatus() === 404);
  await assert.rejects(() => service.joinRoom('999999', 'Different', 'Name'), error => error.getStatus() === 429);
});

test('invalid room-code attempts are blocked per device, not for every student behind one school IP', async () => {
  const db = fakeJoinPrisma();
  const service = new RoomsService(db);
  const ip = '192.168.10.50';
  const firstDevice = 'a'.repeat(64);
  const secondDevice = 'b'.repeat(64);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => service.joinRoom('999999', 'Student', 'One', undefined, ip, firstDevice), error => error.getStatus() === 404);
    await assert.rejects(() => service.joinRoom('999999', 'Student', 'Two', undefined, ip, secondDevice), error => error.getStatus() === 404);
  }
  await assert.rejects(() => service.joinRoom('999999', 'Student', 'One', undefined, ip, firstDevice), error => error.getStatus() === 429);
  await assert.rejects(() => service.joinRoom('999999', 'Student', 'Two', undefined, ip, secondDevice), error => error.getStatus() === 429);
  assert.ok(db.audit.some(entry => entry.action === 'ROOM_CODE_REJECTED'));
});

test('running room rejects tokenless entry even when the supplied name matches the roster', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const first = await service.joinRoom('004271', 'Aruzhan', 'Sapar');
  db.room.status = 'RUNNING'; db.room.startedAt = new Date();
  await assert.rejects(() => service.joinRoom('004271', 'Aruzhan', 'Sapar'), error => error.getStatus() === 400);
  assert.equal(db.participants.length, 1);
  assert.equal(db.submissions.length, 1);
  assert.equal(db.submissions[0].id, first.attemptId);
  await assert.rejects(() => service.joinRoom('004271', 'Unknown', 'Student'), error => error.getStatus() === 400);
});

test('teacher can start a room before the lobby target is full and snapshot hides answer keys', async () => {
  const db = fakeJoinPrisma();
  Object.assign(db.room, {
    participants: [{ id: 'participant-1' }],
    assignment: { id: 'assignment-1', title: 'Math', shuffleQuestions: false, shuffleOptions: false, questions: [
      { id: 'q1', type: 'SINGLE_CHOICE', prompt: '2+2?', points: 2, required: true, position: 1, options: [{ id: 'a', text: '4', isCorrect: true }, { id: 'b', text: '5', isCorrect: false }] },
    ] },
  });
  db.submission.findMany = async () => [{ id: 'waiting-attempt', participantId: 'participant-1' }];
  db.submission.update = async () => ({ id: 'waiting-attempt' });
  db.testRoom.findFirst = async () => db.room;
  db.testRoom.update = async ({ data }) => { Object.assign(db.room, data); return db.room; };
  const service = new RoomsService(db);
  const result = await service.startRoom('room-join', { sub: 'teacher-1', role: 'TEACHER' });
  assert.equal(result.status, 'RUNNING');
  assert.equal(result.count, 1);
  assert.equal(db.room.snapshot.questions[0].options[0].isCorrect, true, 'Server stores scoring key in immutable snapshot');
  db.room.participants = [];
  db.roomParticipant.findFirst = async () => ({ room: db.room });
  db.submission.findFirst = async () => ({ id: 'waiting-attempt', status: 'IN_PROGRESS', answers: [] });
  const studentView = await service.getStudentRoom('room-join', 'x'.repeat(43));
  assert.equal('isCorrect' in studentView.questions[0].options[0], false);
  assert.equal('config' in studentView.questions[0], false);
});

test('room answers autosave securely and submit calculates score from the frozen snapshot', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar');
  db.room.status = 'RUNNING'; db.room.startedAt = new Date('2026-10-18T00:00:00Z'); db.room.snapshot = fakeJoinPrisma('RUNNING').room.snapshot;
  db.submissions[0].status = 'IN_PROGRESS';
  const saved = await service.saveRoomAnswers('room-join', joined.sessionToken, { answers: [{ questionId: 'q1', value: 'a' }] });
  assert.equal(saved.saved, 1);
  assert.equal('isCorrect' in db.answers[0], false, 'Correctness is not exposed during autosave');
  const result = await service.submitRoom('room-join', joined.sessionToken);
  assert.equal(result.score, 1); assert.equal(result.correctCount, 1); assert.equal(result.rank, 1);
  assert.equal(db.submissions[0].finishReason, 'STUDENT_SUBMITTED');
  assert.equal(result.top[0].firstName, 'Aruzhan');
  assert.equal(db.room.status, 'FINISHED');
});

test('autosave rechecks attempt status after acquiring the row lock', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar');
  db.room.status = 'RUNNING'; db.room.startedAt = new Date(); db.room.snapshot = fakeJoinPrisma('RUNNING').room.snapshot;
  db.submissions[0].status = 'IN_PROGRESS';
  const originalQuery = db.$queryRaw;
  db.$queryRaw = async (strings, ...values) => {
    const query = strings.join('?');
    if (query.includes('FROM "Submission"') && query.includes('FOR UPDATE')) db.submissions[0].status = 'GRADED';
    return originalQuery(strings, ...values);
  };
  await assert.rejects(
    () => service.saveRoomAnswers('room-join', joined.sessionToken, { answers: [{ questionId: 'q1', value: 'a' }] }),
    error => error.getStatus() === 404,
  );
  assert.equal(db.answers.length, 0);
});

test('concurrent duplicate submit becomes idempotent after the row lock', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar');
  db.room.status = 'RUNNING'; db.room.startedAt = new Date(); db.room.snapshot = fakeJoinPrisma('RUNNING').room.snapshot;
  db.submissions[0].status = 'IN_PROGRESS';
  const originalQuery = db.$queryRaw;
  db.$queryRaw = async (strings, ...values) => {
    const query = strings.join('?');
    if (query.includes('FROM "Submission"') && query.includes('FOR UPDATE')) db.submissions[0].status = 'GRADED';
    return originalQuery(strings, ...values);
  };
  const result = await service.submitRoom('room-join', joined.sessionToken);
  assert.equal(result.alreadySubmitted, true);
  assert.equal(db.submissions[0].status, 'GRADED');
});

test('room mutations acquire room lock before submission lock', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar');
  db.room.status = 'RUNNING'; db.room.startedAt = new Date(); db.room.snapshot = fakeJoinPrisma('RUNNING').room.snapshot;
  db.submissions[0].status = 'IN_PROGRESS';
  const originalQuery = db.$queryRaw;
  let statements = [];
  db.$queryRaw = async (strings, ...values) => {
    statements.push(strings.join('?'));
    return originalQuery(strings, ...values);
  };
  const assertLockOrder = () => {
    const roomLock = statements.findIndex(query => query.includes('FROM "TestRoom"') && query.includes('FOR UPDATE'));
    const submissionLock = statements.findIndex(query => query.includes('FROM "Submission"') && query.includes('FOR UPDATE'));
    assert.ok(roomLock >= 0, 'room row must be locked');
    assert.ok(submissionLock > roomLock, 'room lock must precede submission lock');
  };
  await service.saveRoomAnswers('room-join', joined.sessionToken, { answers: [{ questionId: 'q1', value: 'a' }] });
  assertLockOrder();
  statements = [];
  await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'VISIBILITY_HIDDEN' });
  assertLockOrder();
  statements = [];
  await service.submitRoom('room-join', joined.sessionToken);
  assertLockOrder();
});

test('room submission after deadline is recorded as TIME_LIMIT', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar');

  db.room.status = 'RUNNING';
  db.room.startedAt = new Date('2026-10-17T23:00:00Z');
  db.room.durationMinutes = 30;
  db.room.snapshot = fakeJoinPrisma('RUNNING').room.snapshot;
  db.submissions[0].status = 'IN_PROGRESS';

  await service.submitRoom('room-join', joined.sessionToken);

  assert.equal(db.submissions[0].status, 'GRADED');
  assert.equal(db.submissions[0].finishReason, 'TIME_LIMIT');
});

test('room answer endpoint rejects fabricated choice ids', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar');
  db.room.status = 'RUNNING'; db.room.startedAt = new Date(); db.room.snapshot = fakeJoinPrisma('RUNNING').room.snapshot;
  db.submissions[0].status = 'IN_PROGRESS';
  await assert.rejects(() => service.saveRoomAnswers('room-join', joined.sessionToken, { answers: [{ questionId: 'q1', value: 'not-an-option' }] }), error => error.getStatus() === 400);
  assert.equal(db.answers.length, 0);
});

test('one continuous hidden-tab episode counts once and restoration allows a new episode', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar');
  db.room.status = 'RUNNING'; db.room.startedAt = new Date(); db.room.snapshot = fakeJoinPrisma('RUNNING').room.snapshot;
  db.submissions[0].status = 'IN_PROGRESS';
  const first = await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'VISIBILITY_HIDDEN' });
  const duplicate = await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'VISIBILITY_HIDDEN' });
  assert.equal(first.warnings, 1);
  assert.equal(duplicate.warnings, 1);
  assert.equal(db.proctorEvents.length, 1);
  await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'VISIBILITY_RESTORED' });
  const second = await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'VISIBILITY_HIDDEN' });
  assert.equal(second.warnings, 2);
  assert.equal(db.proctorEvents.length, 3);
});

test('third visibility episode grades and preserves saved answers with violation finish reason', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar');
  db.room.status = 'RUNNING'; db.room.startedAt = new Date(); db.room.snapshot = fakeJoinPrisma('RUNNING').room.snapshot;
  db.submissions[0].status = 'IN_PROGRESS';
  await service.saveRoomAnswers('room-join', joined.sessionToken, { answers: [{ questionId: 'q1', value: 'a' }] });
  for (let episode = 0; episode < 3; episode++) {
    if (episode) await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'VISIBILITY_RESTORED' });
    var result = await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'VISIBILITY_HIDDEN' });
  }
  assert.equal(result.warnings, 3);
  assert.equal(result.finished, true);
  assert.equal(db.submissions[0].status, 'GRADED');
  assert.equal(db.submissions[0].finishReason, 'PROCTORING_VIOLATION_LIMIT');
  assert.equal(db.answers[0].jsonValue, 'a');
  assert.equal(db.answers[0].isCorrect, true);
  assert.equal(db.submissions[0].totalScore, 1);
});

test('manual screen-share stop counts once and restarting sharing permits a later violation episode', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar');
  db.room.status = 'RUNNING'; db.room.startedAt = new Date(); db.room.snapshot = fakeJoinPrisma('RUNNING').room.snapshot;
  db.submissions[0].status = 'IN_PROGRESS';
  const first = await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'SCREEN_SHARE_ENDED' });
  const duplicate = await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'SCREEN_SHARE_ENDED' });
  assert.equal(first.warnings, 1);
  assert.equal(duplicate.warnings, 1);
  assert.equal(duplicate.duplicate, true);
  await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'SCREEN_SHARE_RESTORED' });
  const second = await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'SCREEN_SHARE_ENDED' });
  assert.equal(second.warnings, 2);
});

test('deadline takes precedence over a proctor event received after time expires', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar');
  db.room.status = 'RUNNING';
  db.room.startedAt = new Date('2026-10-17T23:00:00.000Z');
  db.room.durationMinutes = 30;
  db.room.snapshot = fakeJoinPrisma('RUNNING').room.snapshot;
  db.submissions[0].status = 'IN_PROGRESS';
  const result = await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'SCREEN_SHARE_ENDED' });
  assert.equal(result.finished, true);
  assert.equal(db.submissions[0].finishReason, 'TIME_LIMIT');
  assert.equal(db.submissions[0].proctorWarnings, 0);
  assert.equal(db.proctorEvents.length, 0);
});

test('overlapping visibility and screen-share violations are tracked as independent episodes', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  const joined = await service.joinRoom('004271', 'Aruzhan', 'Sapar');
  db.room.status = 'RUNNING'; db.room.startedAt = new Date(); db.room.snapshot = fakeJoinPrisma('RUNNING').room.snapshot;
  db.submissions[0].status = 'IN_PROGRESS';
  assert.equal((await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'VISIBILITY_HIDDEN' })).warnings, 1);
  assert.equal((await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'SCREEN_SHARE_ENDED' })).warnings, 2);
  await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'SCREEN_SHARE_RESTORED' });
  const duplicateVisibility = await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'VISIBILITY_HIDDEN' });
  assert.equal(duplicateVisibility.warnings, 2);
  assert.equal(duplicateVisibility.duplicate, true);
  await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'VISIBILITY_RESTORED' });
  const nextScreenViolation = await service.recordRoomProctorEvent('room-join', joined.sessionToken, { eventType: 'SCREEN_SHARE_ENDED' });
  assert.equal(nextScreenViolation.warnings, 3);
  assert.equal(nextScreenViolation.finished, true);
});

test('room analytics reports per-question accuracy and excludes unfinished attempts', async () => {
  const db = fakeJoinPrisma(); const service = new RoomsService(db);
  db.testRoom.findFirst = async ({ where }) => !where.creatorId || where.creatorId === 'teacher-1' ? ({ ...db.room, assignment: { title: 'Math' }, snapshot: { questions: [
    { sourceQuestionId: 'q1', prompt: '2+2?', points: 1 }, { sourceQuestionId: 'q2', prompt: '3+3?', points: 2 },
  ] } }) : null;
  db.submission.findMany = async ({ where }) => where.status === 'GRADED' ? [
    { totalScore: 1, startedAt: new Date('2026-10-18T10:00:00Z'), submittedAt: new Date('2026-10-18T10:02:00Z'), studentFirstName: 'A', studentLastName: 'One', answers: [{ questionId: 'q1', jsonValue: 'a', isCorrect: true }, { questionId: 'q2', jsonValue: 'x', isCorrect: false }] },
    { totalScore: 3, startedAt: new Date('2026-10-18T10:00:00Z'), submittedAt: new Date('2026-10-18T10:01:00Z'), studentFirstName: 'B', studentLastName: 'Two', answers: [{ questionId: 'q1', jsonValue: 'b', isCorrect: false }, { questionId: 'q2', jsonValue: 'y', isCorrect: true }] },
  ] : [];
  const result = await service.roomAnalytics('room-join', { sub: 'teacher-1', role: 'TEACHER' });
  assert.equal(result.attemptCount, 2);
  assert.equal(result.questions[0].answered, 2);
  assert.equal(result.questions[0].correct, 1);
  assert.equal(result.questions[0].accuracyPercent, 50);
  assert.equal(result.summary.averageScore, 2);
  await assert.rejects(() => service.roomAnalytics('room-join', { sub: 'teacher-2', role: 'TEACHER' }), error => error.getStatus() === 404);
});
