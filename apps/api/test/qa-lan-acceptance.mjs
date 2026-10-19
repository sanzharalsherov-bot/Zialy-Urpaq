// Disposable LAN stack only. Stores temporary credentials under ignored tmp/.
import https from 'node:https';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const env = require('dotenv').parse(readFileSync('tmp/lancheck-20261019/test.env'));
const ca = readFileSync('tmp/lancheck-20261019/root.crt');
assert.equal(env.WEB_HTTPS_PORT, '18443');
const base = `https://${env.SCHOOL_LAN_IP}:18443/api`;
async function request(path, method = 'GET', body, token, expected) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(`${base}${path}`, { method, ca, timeout: 15000, headers: {
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    } }, res => {
      let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => {
        try { if (expected) assert.equal(res.statusCode, expected, `${method} ${path}`);
          else assert(res.statusCode >= 200 && res.statusCode < 300, `${method} ${path}: HTTP ${res.statusCode}`);
          resolve(data ? JSON.parse(data) : null);
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('QA request timeout')));
    req.on('error', error => reject(new Error(`QA network failure: ${error.code ?? 'unknown'}`)));
    req.end(payload);
  });
}
const credentialsFile = 'tmp/lancheck-20261019/qa-credentials.json';
const credentials = existsSync(credentialsFile) ? JSON.parse(readFileSync(credentialsFile)) : {
  email: 'lan-qa@test.invalid', password: randomBytes(24).toString('base64url'),
};
if (!existsSync(credentialsFile)) {
  await request('/auth/bootstrap-admin', 'POST', { ...credentials, firstName: 'LAN', lastName: 'QA',
    bootstrapKey: env.BOOTSTRAP_ADMIN_KEY, studentAccessCode: randomBytes(16).toString('hex') });
  writeFileSync(credentialsFile, JSON.stringify(credentials));
}
const { accessToken: staff } = await request('/auth/login', 'POST', credentials);
const assignment = await request('/assignments', 'POST', {
  title: `LAN acceptance ${Date.now()}`, subjectName: 'LAN-QA', maxAttempts: 1,
  questions: [{ type: 'SINGLE_CHOICE', prompt: 'Choose A', points: 2,
    options: [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: false }] }],
}, staff);
await request(`/assignments/${assignment.id}/publish`, 'PATCH', undefined, staff);
const room = await request(`/assignments/${assignment.id}/rooms`, 'POST', { lobbyTarget: 10, durationMinutes: 30 }, staff);
const first = await request('/student/rooms/join-v2', 'POST', { code: room.joinCode, firstName: 'Same', lastName: 'Student' });
const second = await request('/student/rooms/join-v2', 'POST', { code: room.joinCode, firstName: 'Same', lastName: 'Student' });
assert.notEqual(first.participantId, second.participantId);
await request(`/rooms/${room.id}/start`, 'POST', undefined, staff);
await request('/student/rooms/join-v2', 'POST', { code: room.joinCode, firstName: 'Same', lastName: 'Student' }, undefined, 400);
const view = await request(`/student/rooms/${room.id}/v2`, 'GET', undefined, first.sessionToken);
assert(!JSON.stringify(view.questions).includes('isCorrect'));
const question = view.questions[0];
const correct = question.options.find(option => option.text === 'A').id;
for (const student of [first, second]) {
  await request(`/student/rooms/${room.id}/v2/answers`, 'PATCH', { answers: [{ questionId: question.id, value: correct }] }, student.sessionToken);
}
const resumed = await request('/student/rooms/join-v2', 'POST', { code: room.joinCode, firstName: 'Same', lastName: 'Student', sessionToken: first.sessionToken });
assert.equal(resumed.attemptId, first.attemptId);
const restored = await request(`/student/rooms/${room.id}/v2`, 'GET', undefined, first.sessionToken);
assert.equal(restored.submission.answers[0].jsonValue, correct);
assert.equal(restored.room.startedAt, view.room.startedAt);
const media = await request(`/student/rooms/${room.id}/v2/livekit-token`, 'POST', undefined, first.sessionToken);
assert.equal(media.url, env.LIVEKIT_PUBLIC_URL);
const result = await request(`/student/rooms/${room.id}/v2/submit`, 'POST', undefined, first.sessionToken);
assert.equal(result.score, 2);
const repeat = await request(`/student/rooms/${room.id}/v2/submit`, 'POST', undefined, first.sessionToken);
assert.equal(repeat.alreadySubmitted, true);
for (let index = 0; index < 3; index++) {
  await request(`/student/rooms/${room.id}/v2/proctor-events`, 'POST', { eventType: 'VISIBILITY_HIDDEN' }, second.sessionToken);
  if (index < 2) await request(`/student/rooms/${room.id}/v2/proctor-events`, 'POST', { eventType: 'VISIBILITY_RESTORED' }, second.sessionToken);
}
const finished = await request(`/student/rooms/${room.id}/v2`, 'GET', undefined, second.sessionToken);
assert.equal(finished.submission.score, 2);
assert.equal(finished.submission.proctorWarnings, 3);
assert.equal(finished.submission.finishReason, 'PROCTORING_VIOLATION_LIMIT');
await request(`/student/rooms/${room.id}/v2/livekit-token`, 'POST', undefined, second.sessionToken, 400);
const analytics = await request(`/rooms/${room.id}/analytics`, 'GET', undefined, staff);
assert.equal(analytics.attemptCount, 2);
assert.equal(analytics.summary.averageScore, 2);
writeFileSync('tmp/lancheck-20261019/acceptance-fixture.json', JSON.stringify({ assignmentId: assignment.id, roomId: room.id, attemptId: first.attemptId }));
console.log(JSON.stringify({ passed: true, students: 2, duplicateNamesIsolated: true, tokenlessReentryDenied: true,
  autosaveAndResume: true, timerPreserved: true, repeatedSubmitIdempotent: true, thirdWarningPreservesScore: true,
  analyticsVerified: true, actualWifiLossTested: false, browserMediaTested: false }));
