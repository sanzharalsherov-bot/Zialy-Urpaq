const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { writeFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { MonitorService } = require('../dist/assignments/monitor.service');
const { createResultsArchive } = require('../dist/assignments/results-export.worker');
const { ResultsExportService } = require('../dist/assignments/results-export.service');
const student = { sub: 'student-a', role: 'STUDENT' };
const teacher = { sub: 'teacher-a', role: 'TEACHER' };
const status = code => e => e.getStatus?.() === code;

function fixture(t) {
  const events = [];
  let attemptStatus = 'IN_PROGRESS';
  const identity = createHash('sha256').update(`student:${student.sub}`).digest('hex');
  const prisma = {
    submission: {
      findFirst: async ({ where }) => {
        if (where.studentIdentityKey) return where.studentIdentityKey === identity ? { assignmentId: 'a', status: 'IN_PROGRESS' } : null;
        if (where.assignment?.creatorId && where.assignment.creatorId !== teacher.sub) return null;
        return { id: 's', status: attemptStatus, studentFirstName: 'Aruzhan', studentLastName: 'Sapar', proctorWarnings: 0, answers: [{ questionId: 'q', jsonValue: 'correct-option', question: { prompt: '2+2?', options: [{ id: 'correct-option', text: '4' }] } }] };
      }, update: async () => {},
    },
    proctorEvent: { create: async ({ data }) => events.push(data) },
    question: { findFirst: async ({ where }) => where.id === 'q' ? { id: 'q' } : null, findUnique: async () => ({ prompt: 'Question' }) },
  };
  const service = new MonitorService(prisma); t.after(() => service.onModuleDestroy());
  return { service, events, setAttemptStatus: value => { attemptStatus = value; } };
}
test('screen streams require ownership and students cannot watch classmates', async t => {
  const { service } = fixture(t);
  await assert.rejects(service.heartbeat('s', { visible: true, sharing: true }, { ...student, sub: 'intruder' }), status(404));
  await assert.rejects(service.watch('s', student), status(403));
  await assert.rejects(service.watch('s', { ...teacher, sub: 'another-teacher' }), status(404));
  await assert.rejects(service.uploadFrame('s', 'data:image/jpeg;base64,/9j/2Q==', student), status(403));
});
test('live monitoring hides answers while active and exposes them only after completion', async t => {
  const { service, setAttemptStatus } = fixture(t);
  const live = await service.watch('s', teacher);
  assert.deepEqual(live.answers, []);
  setAttemptStatus('GRADED');
  const completed = await service.watch('s', teacher);
  assert.equal(completed.answers[0].jsonValue, 'correct-option');
});
test('frames expire, stop deletes them, invalid frames and flood are rejected', async t => {
  const { service, events } = fixture(t);
  await service.heartbeat('s', { visible: true, sharing: true, questionId: 'q' }, student);
  await service.watch('s', teacher);
  const frame = 'data:image/jpeg;base64,/9j/2Q==';
  await service.uploadFrame('s', frame, student);
  assert.equal((await service.watch('s', teacher)).frame, frame);
  await assert.rejects(service.uploadFrame('s', frame, student), status(429));
  for (const bad of ['data:text/html;base64,PHNjcmlwdD4=', 'data:image/jpeg;base64,YmFk', 'a'.repeat(140001)]) await assert.rejects(service.uploadFrame('s', bad, student), status(400));
  service.states.get('s').frameAt = Date.now() - 11000;
  assert.equal((await service.watch('s', teacher)).frame, null);
  await service.heartbeat('s', { visible: true, sharing: false }, student);
  assert.equal(service.states.get('s').frame, undefined);
  assert.deepEqual(events.map(e => e.eventType), ['SCREEN_STARTED', 'SCREEN_STOPPED']);
  await assert.rejects(service.heartbeat('s', { visible: true, sharing: false, questionId: 'foreign' }, student), status(400));
});
test('archive is a real SQLite database preserving Unicode, SQL-looking text, unanswered questions and pending grades', t => {
  const data = { assignment: { id: 'a', title: 'Қазақ тілі', questions: [
    { id: 'q', position: 1, type: 'SHORT_TEXT', prompt: "'); DROP TABLE test; --", points: 0, options: [] },
    { id: 'q2', position: 2, type: 'SINGLE_CHOICE', prompt: 'Unanswered', points: 2, options: [{ id: 'o', text: '=SUM(1,2)', isCorrect: true }] },
  ] }, submissions: [{ id: 's', studentFirstName: 'Әлия', studentLastName: 'Алиева', attemptNo: 1, status: 'UNDER_REVIEW', totalScore: null, startedAt: '2026-10-17T10:00:00Z', submittedAt: '2026-10-17T10:01:30Z', proctorWarnings: 1, answers: [{ questionId: 'q', textValue: 'Жауап', numericValue: null, jsonValue: null, isCorrect: null, awardedPoints: null, teacherComment: null }], proctorEvents: [] }] };
  const bytes = createResultsArchive(data);
  assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
  const path = join(tmpdir(), `zaily-export-test-${randomUUID()}.sqlite`); writeFileSync(path, bytes);
  const db = new DatabaseSync(path, { readOnly: true }); t.after(() => { db.close(); unlinkSync(path); });
  assert.equal(db.prepare('SELECT count(*) AS n FROM question').get().n, 2);
  const row = db.prepare('SELECT * FROM attempt').get(); assert.equal(row.first_name, 'Әлия'); assert.equal(row.score, null); assert.equal(row.duration_seconds, 90);
  assert.equal(db.prepare('SELECT prompt FROM question WHERE id=?').get('q').prompt, data.assignment.questions[0].prompt);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
test('archive endpoint denies students before reading data', async () => {
  const service = new ResultsExportService({ $transaction: () => { throw new Error('must not read'); } });
  await assert.rejects(service.sqlite('a', student), status(403));
});
