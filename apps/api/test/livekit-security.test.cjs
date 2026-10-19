const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { buildLiveKitToken, LiveKitService } = require('../dist/assignments/livekit.service');

function decode(token) {
  const [header, payload, signature] = token.split('.');
  return { header: JSON.parse(Buffer.from(header, 'base64url')), payload: JSON.parse(Buffer.from(payload, 'base64url')), signature };
}

test('LiveKit student token is room scoped and can publish only screen share', () => {
  const token = buildLiveKitToken({ apiKey: 'test_key', apiSecret: 's'.repeat(40), identity: 'student:p-1', name: 'A Student', room: 'room-1', staff: false, nowSeconds: 1000 });
  const decoded = decode(token);
  assert.equal(decoded.header.alg, 'HS256');
  assert.equal(decoded.payload.iss, 'test_key');
  assert.equal(decoded.payload.sub, 'student:p-1');
  assert.equal(decoded.payload.nbf, 995);
  assert.equal(decoded.payload.exp, 1600);
  assert.deepEqual(decoded.payload.video, { roomJoin: true, room: 'room-1', canPublish: true, canSubscribe: false, canPublishSources: ['screen_share'] });
  const expected = createHmac('sha256', 's'.repeat(40)).update(token.split('.').slice(0, 2).join('.')).digest('base64url');
  assert.equal(decoded.signature, expected);
});

test('LiveKit staff token can subscribe but cannot publish student media', () => {
  const decoded = decode(buildLiveKitToken({ apiKey: 'test_key', apiSecret: 's'.repeat(40), identity: 'teacher:t-1', name: 'Teacher', room: 'room-1', staff: true, nowSeconds: 1000 }));
  assert.deepEqual(decoded.payload.video, { roomJoin: true, room: 'room-1', canPublish: false, canSubscribe: true });
});

test('LiveKit token creation rejects invalid credentials and identities', () => {
  assert.throws(() => buildLiveKitToken({ apiKey: '', apiSecret: 'short', identity: 'x', name: 'Student', room: 'r', staff: false }));
  assert.throws(() => buildLiveKitToken({ apiKey: 'test_key', apiSecret: 's'.repeat(40), identity: 'x'.repeat(200), name: 'Student', room: 'r', staff: false }));
});

test('LiveKit service enforces teacher ownership and only authorizes active room members', async t => {
  const previous = { key: process.env.LIVEKIT_API_KEY, secret: process.env.LIVEKIT_API_SECRET, url: process.env.LIVEKIT_PUBLIC_URL };
  process.env.LIVEKIT_API_KEY = 'test_key';
  process.env.LIVEKIT_API_SECRET = 's'.repeat(40);
  process.env.LIVEKIT_PUBLIC_URL = 'wss://school.example/livekit';
  t.after(() => {
    if (previous.key === undefined) delete process.env.LIVEKIT_API_KEY; else process.env.LIVEKIT_API_KEY = previous.key;
    if (previous.secret === undefined) delete process.env.LIVEKIT_API_SECRET; else process.env.LIVEKIT_API_SECRET = previous.secret;
    if (previous.url === undefined) delete process.env.LIVEKIT_PUBLIC_URL; else process.env.LIVEKIT_PUBLIC_URL = previous.url;
  });
  const roomToken = 'a'.repeat(48);
  const hash = require('node:crypto').createHash('sha256').update(roomToken).digest('hex');
  const prisma = {
    testRoom: { findFirst: async ({ where }) => where.creatorId === 'teacher-1' ? { id: 'room-1', status: 'RUNNING' } : null },
    user: { findUnique: async () => ({ firstName: 'Teacher', lastName: 'One' }) },
    roomParticipant: { findFirst: async ({ where }) => where.sessionHash === hash ? { id: 'participant-1', firstName: 'Student', lastName: 'One', room: { id: 'room-1', status: 'RUNNING' } } : null },
    submission: { findFirst: async () => ({ status: 'IN_PROGRESS' }) },
  };
  const service = new LiveKitService(prisma);
  const teacher = await service.staffToken('room-1', { sub: 'teacher-1', role: 'TEACHER' });
  assert.equal(teacher.url, 'wss://school.example/livekit');
  assert.equal(decode(teacher.token).payload.video.canSubscribe, true);
  await assert.rejects(service.staffToken('room-1', { sub: 'other-teacher', role: 'TEACHER' }), error => error.getStatus?.() === 404);
  const student = await service.studentToken('room-1', roomToken);
  assert.equal(decode(student.token).payload.video.canPublish, true);
  assert.equal(decode(student.token).payload.video.canSubscribe, false);
  await assert.rejects(service.studentToken('room-1', 'x'.repeat(48)), error => error.getStatus?.() === 404);
});
