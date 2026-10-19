// Run only against the disposable Compose project bound to localhost:18081.
// Credentials come from environment variables and are never printed.
import { performance } from 'node:perf_hooks';

const base = process.env.LOAD_BASE_URL;
const bootstrapKey = process.env.LOAD_BOOTSTRAP_KEY;
const password = process.env.LOAD_ADMIN_PASSWORD;
if (base !== 'http://127.0.0.1:18081' || !bootstrapKey || !password) {
  throw new Error('Use the disposable QA stack on http://127.0.0.1:18081 with LOAD_BOOTSTRAP_KEY and LOAD_ADMIN_PASSWORD');
}

async function request(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 180)}`);
  return text ? JSON.parse(text) : null;
}

async function phase(name, items, action) {
  const began = performance.now();
  const latencies = [];
  const results = await Promise.allSettled(items.map(async item => {
    const started = performance.now();
    const result = await action(item);
    latencies.push(performance.now() - started);
    return result;
  }));
  const failed = results.filter(result => result.status === 'rejected');
  latencies.sort((a, b) => a - b);
  const report = {
    phase: name, requested: items.length, succeeded: results.length - failed.length,
    failed: failed.length, totalMs: Math.round(performance.now() - began),
    p50Ms: Math.round(latencies[Math.floor(latencies.length * 0.5)] ?? 0),
    p95Ms: Math.round(latencies[Math.floor(latencies.length * 0.95)] ?? 0),
    maxMs: Math.round(latencies.at(-1) ?? 0),
    errors: failed.slice(0, 3).map(result => String(result.reason?.message ?? result.reason)),
  };
  console.log(JSON.stringify(report));
  if (failed.length) throw new Error(`${name} failed for ${failed.length} clients`);
  return results.map(result => result.value);
}

await request('/auth/bootstrap-admin', {
  method: 'POST',
  body: { email: 'load-admin@test.invalid', firstName: 'Load', lastName: 'Admin', password, bootstrapKey, studentAccessCode: 'load-school-access' },
});
const { accessToken: staffToken } = await request('/auth/login', {
  method: 'POST', body: { email: 'load-admin@test.invalid', password },
});
const assignment = await request('/assignments', {
  method: 'POST', token: staffToken,
  body: {
    title: 'QA room capacity', subjectName: 'QA-only', maxAttempts: 1,
    questions: [{ type: 'SINGLE_CHOICE', prompt: 'Choose one answer', points: 1, options: [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: false }] }],
  },
});
await request(`/assignments/${assignment.id}/publish`, { method: 'PATCH', token: staffToken });
const rooms = await phase('create-rooms', Array.from({ length: 10 }, (_, index) => index), () => request(`/assignments/${assignment.id}/rooms`, {
  method: 'POST', token: staffToken, body: { lobbyTarget: 40, durationMinutes: 30 },
}));
const roster = rooms.flatMap((room, roomIndex) => Array.from({ length: 40 }, (_, studentIndex) => ({
  room, firstName: `Student${roomIndex + 1}`, lastName: `Number${studentIndex + 1}`,
})));
const students = await phase('join-400', roster, async student => ({ ...student, joined: await request('/student/rooms/join-v2', {
  method: 'POST', body: { code: student.room.joinCode, firstName: student.firstName, lastName: student.lastName },
}) }));
await phase('start-rooms', rooms, room => request(`/rooms/${room.id}/start`, { method: 'POST', token: staffToken }));
const active = await phase('read-400', students, async student => ({ ...student, view: await request(`/student/rooms/${student.room.id}/v2`, { token: student.joined.sessionToken }) }));
await phase('autosave-400', active, student => {
  const question = student.view.questions?.[0];
  if (!question?.options?.[0]?.id) throw new Error('Student view is missing a choice question');
  return request(`/student/rooms/${student.room.id}/v2/answers`, {
    method: 'PATCH', token: student.joined.sessionToken,
    body: { answers: [{ questionId: question.id, value: question.options[0].id }] },
  });
});
await phase('submit-400', active, student => request(`/student/rooms/${student.room.id}/v2/submit`, {
  method: 'POST', token: student.joined.sessionToken,
}));
const counts = await phase('verify-rooms', rooms, room => request(`/rooms/${room.id}`, { token: staffToken }));
if (!counts.every(room => room.count === 40)) throw new Error('At least one room has the wrong participant count');
console.log(JSON.stringify({ result: 'passed', rooms: rooms.length, students: students.length }));
