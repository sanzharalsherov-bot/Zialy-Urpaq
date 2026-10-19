import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, unlinkSync } from 'node:fs';

export function createResultsArchive(data: any): Buffer {
  const path = join(tmpdir(), `zaily-results-${randomUUID()}.sqlite`);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec(`PRAGMA journal_mode=MEMORY; PRAGMA foreign_keys=ON;
      CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE test (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE question (id TEXT PRIMARY KEY, test_id TEXT NOT NULL REFERENCES test(id), position INTEGER, type TEXT, prompt TEXT, points REAL);
      CREATE TABLE option (id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES question(id), text TEXT, is_correct INTEGER);
      CREATE TABLE attempt (id TEXT PRIMARY KEY, test_id TEXT NOT NULL REFERENCES test(id), first_name TEXT, last_name TEXT, attempt_no INTEGER, status TEXT, score REAL, started_at TEXT, submitted_at TEXT, duration_seconds REAL, warnings INTEGER);
      CREATE TABLE answer (attempt_id TEXT NOT NULL REFERENCES attempt(id), question_id TEXT NOT NULL REFERENCES question(id), text_value TEXT, numeric_value REAL, selected_options_json TEXT, correct INTEGER, awarded_points REAL, teacher_comment TEXT, PRIMARY KEY(attempt_id,question_id));
      CREATE TABLE proctor_event (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempt(id), type TEXT, occurred_at TEXT);
      BEGIN;`);
    const meta = db.prepare('INSERT INTO metadata VALUES (?,?)');
    meta.run('schema_version', '1'); meta.run('exported_at_utc', new Date().toISOString()); meta.run('purpose', 'Results snapshot; not a full platform backup');
    db.prepare('INSERT INTO test VALUES (?,?)').run(data.assignment.id, data.assignment.title);
    const question = db.prepare('INSERT INTO question VALUES (?,?,?,?,?,?)');
    const option = db.prepare('INSERT INTO option VALUES (?,?,?,?)');
    for (const q of data.assignment.questions) {
      question.run(q.id, data.assignment.id, q.position, q.type, q.prompt, Number(q.points));
      for (const o of q.options) option.run(o.id, q.id, o.text, o.isCorrect ? 1 : 0);
    }
    const attempt = db.prepare('INSERT INTO attempt VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const answer = db.prepare('INSERT INTO answer VALUES (?,?,?,?,?,?,?,?)');
    const event = db.prepare('INSERT INTO proctor_event VALUES (?,?,?,?)');
    for (const s of data.submissions) {
      attempt.run(s.id, data.assignment.id, s.studentFirstName, s.studentLastName, s.attemptNo, s.status, s.totalScore == null ? null : Number(s.totalScore), s.startedAt, s.submittedAt, s.submittedAt ? Math.max(0, (Date.parse(s.submittedAt) - Date.parse(s.startedAt)) / 1000) : null, s.proctorWarnings);
      for (const a of s.answers) answer.run(s.id, a.questionId, a.textValue, a.numericValue == null ? null : Number(a.numericValue), a.jsonValue == null ? null : JSON.stringify(a.jsonValue), a.isCorrect == null ? null : a.isCorrect ? 1 : 0, a.awardedPoints == null ? null : Number(a.awardedPoints), a.teacherComment);
      for (const e of s.proctorEvents) event.run(e.id, s.id, e.eventType, e.createdAt);
    }
    db.exec('COMMIT'); db.close(); db = undefined;
    return readFileSync(path);
  } finally { db?.close(); try { unlinkSync(path); } catch { /* No temporary file if database creation failed. */ } }
}
if (parentPort) {
  try { parentPort.postMessage({ buffer: createResultsArchive(workerData) }); }
  catch { parentPort.postMessage({ error: 'Не удалось создать архив результатов' }); }
}
