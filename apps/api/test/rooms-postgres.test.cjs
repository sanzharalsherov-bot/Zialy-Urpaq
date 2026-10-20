const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const migration = readFileSync(resolve(__dirname, '../../../prisma/migrations/20261018110000_independent_test_rooms/migration.sql'), 'utf8');
const proctorMigration = readFileSync(resolve(__dirname, '../../../prisma/migrations/20261018120000_room_proctor_finish_reason/migration.sql'), 'utf8');

test('room migration is additive and backfills legacy submissions without deleting history', () => {
  assert.match(migration, /CREATE TABLE "TestRoom"/u);
  assert.match(migration, /CREATE TABLE "RoomParticipant"/u);
  assert.match(migration, /INSERT INTO "RoomParticipant"/u);
  assert.match(migration, /UPDATE "Submission" s[\s\S]*?SET "roomId"/u);
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN|TYPE)\b/iu);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\s+"(?:Submission|Answer|Question|Assignment)"/iu);
});

test('proctor finish migration only adds the persisted finish reason', () => {
  assert.match(proctorMigration, /ADD COLUMN "finishReason" TEXT/u);
  assert.doesNotMatch(proctorMigration, /\b(DROP|DELETE|TRUNCATE)\b/iu);
});

const databaseUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL rooms: independent rooms, session isolation, snapshot redaction and staff ownership', {
  skip: !databaseUrl && 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database', timeout: 60000,
}, async t => {
  const url = new URL(databaseUrl);
  assert.match(url.pathname, /test|audit/i, 'Refusing to use a database without test/audit in its name');
  assert.ok(['127.0.0.1', 'localhost', 'postgres-test', 'postgres'].includes(url.hostname), 'Use an isolated local PostgreSQL instance');
  require('reflect-metadata');
  const { PrismaClient } = require('@prisma/client');
  const { RoomsService } = require('../dist/assignments/rooms.service');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const service = new RoomsService(prisma);
  const suffix = require('node:crypto').randomUUID();
  const subjectName = `rooms-audit-${suffix}`;
  const teacher = await prisma.user.create({ data: { email: `rooms-${suffix}@test.invalid`, firstName: 'Test', lastName: 'Teacher', role: 'TEACHER', passwordHash: 'fixture-not-login' } });
  const other = await prisma.user.create({ data: { email: `rooms-other-${suffix}@test.invalid`, firstName: 'Other', lastName: 'Teacher', role: 'TEACHER', passwordHash: 'fixture-not-login' } });
  const assignment = await serviceAssignment(prisma, teacher, subjectName);
  const fixtureQuestion = await prisma.question.findFirst({ where: { assignmentId: assignment.id }, include: { options: { orderBy: { position: 'asc' } } } });
  const actor = { sub: teacher.id, role: 'TEACHER' };
  const admin = { sub: teacher.id, role: 'ADMIN' };
  const rooms = [];
  t.after(async () => {
    try {
      await prisma.submission.deleteMany({ where: { assignmentId: assignment.id } });
      await prisma.testRoom.deleteMany({ where: { assignmentId: assignment.id } });
      await prisma.assignment.deleteMany({ where: { id: assignment.id } });
      await prisma.subject.deleteMany({ where: { name: subjectName } });
      await prisma.user.deleteMany({ where: { id: { in: [teacher.id, other.id] } } });
    } finally { await prisma.$disconnect(); }
  });

  const roomA = await service.createRoom(assignment.id, { lobbyTarget: 10 }, actor);
  const roomB = await service.createRoom(assignment.id, { lobbyTarget: 10 }, actor);
  rooms.push(roomA, roomB);
  assert.notEqual(roomA.joinCode, roomB.joinCode);
  assert.deepEqual((await service.listRooms({ sub: other.id, role: 'TEACHER' })).map(r => r.id), []);
  await assert.rejects(() => service.getRoom(roomA.id, { sub: other.id, role: 'TEACHER' }), error => error.getStatus() === 404);

  const first = await service.joinRoom(roomA.joinCode, 'Same', 'Name');
  const second = await service.joinRoom(roomA.joinCode, 'Same', 'Name');
  assert.notEqual(first.participantId, second.participantId);
  assert.equal((await service.getRoom(roomA.id, actor)).count, 2);
  await service.startRoom(roomA.id, actor); // 2 of 10 is a valid manual start.
  const view = await service.getStudentRoom(roomA.id, first.sessionToken);
  assert.equal('isCorrect' in view.questions[0].options[0], false);
  await service.saveRoomAnswers(roomA.id, first.sessionToken, { answers: [{ questionId: fixtureQuestion.id, value: fixtureQuestion.options[0].id }] });
  await service.recordRoomProctorEvent(roomA.id, first.sessionToken, { eventType: 'VISIBILITY_HIDDEN' });
  await service.recordRoomProctorEvent(roomA.id, first.sessionToken, { eventType: 'VISIBILITY_RESTORED' });
  await service.recordRoomProctorEvent(roomA.id, first.sessionToken, { eventType: 'VISIBILITY_HIDDEN' });
  await service.recordRoomProctorEvent(roomA.id, first.sessionToken, { eventType: 'VISIBILITY_RESTORED' });
  const proctorResult = await service.recordRoomProctorEvent(roomA.id, first.sessionToken, { eventType: 'VISIBILITY_HIDDEN' });
  assert.equal(proctorResult.finished, true);
  const finishedView = await service.getStudentRoom(roomA.id, first.sessionToken);
  assert.equal(finishedView.submission.finishReason, 'PROCTORING_VIOLATION_LIMIT');
  assert.equal(Number(finishedView.submission.score), 1);
  const saved = await prisma.answer.findFirst({ where: { submissionId: first.attemptId, questionId: fixtureQuestion.id } });
  assert.equal(saved.jsonValue, fixtureQuestion.options[0].id, 'Third warning must preserve the student answer');
  assert.equal((await service.getRoom(roomA.id, actor)).participants[0].attempt.proctorWarnings, 3);
  assert.equal((await service.joinRoom(roomA.joinCode, 'New', 'Name').catch(e => e.status)), 400);
  await assert.rejects(() => service.startRoom(roomA.id, { sub: other.id, role: 'TEACHER' }), error => error.getStatus() === 404);

  // Real PostgreSQL race: the last two submissions finish at nearly the same time.
  const raceOne = await service.joinRoom(roomB.joinCode, 'Race', 'One');
  const raceTwo = await service.joinRoom(roomB.joinCode, 'Race', 'Two');
  await service.startRoom(roomB.id, actor);
  const raceResults = await Promise.allSettled([
    service.saveRoomAnswers(roomB.id, raceOne.sessionToken, { answers: [{ questionId: fixtureQuestion.id, value: fixtureQuestion.options[0].id }] }),
    service.submitRoom(roomB.id, raceOne.sessionToken),
    service.submitRoom(roomB.id, raceTwo.sessionToken),
  ]);
  assert.equal(raceResults[1].status, 'fulfilled', 'first student submission should finish exactly once');
  assert.equal(raceResults[2].status, 'fulfilled', 'second student submission should finish exactly once');
  assert.equal((await prisma.testRoom.findUnique({ where: { id: roomB.id }, select: { status: true } })).status, 'FINISHED');
  assert.equal(await prisma.submission.count({ where: { roomId: roomB.id, status: 'GRADED' } }), 2);
  const raceAnswer = await prisma.answer.findFirst({ where: { submissionId: raceOne.attemptId, questionId: fixtureQuestion.id } });
  assert.ok(raceAnswer, 'finalization must create a durable answer row even if autosave loses the race');
  if (raceAnswer.jsonValue === fixtureQuestion.options[0].id) {
    assert.equal(raceAnswer.isCorrect, true, 'an autosaved answer must be graded if it wins the lock');
  } else {
    assert.equal(raceAnswer.jsonValue, null, 'an autosave arriving after finalization must not mutate the submitted answer');
    assert.equal(raceAnswer.isCorrect, false);
  }
  assert.ok(rooms.length === 2);
});

async function serviceAssignment(prisma, teacher, subjectName) {
  const subject = await prisma.subject.create({ data: { name: subjectName } });
  return prisma.assignment.create({ data: {
    title: 'Room integration fixture', status: 'PUBLISHED', joinCode: `A${Date.now().toString().slice(-11)}`,
    creatorId: teacher.id, subjectId: subject.id, totalPoints: 1,
    questions: { create: [{
      type: 'SINGLE_CHOICE', prompt: 'Fixture question', position: 1, points: 1,
      options: { create: [{ text: 'Correct', isCorrect: true, position: 1 }, { text: 'Wrong', isCorrect: false, position: 2 }] },
    }] },
  } });
}
