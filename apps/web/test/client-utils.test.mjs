import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError, answerText, automaticScoreRate, clearRoomSession, readRoomSession, readStorage, requestJson, roomSessionKey, storeRoomSession, validPoints, writeStorage } from '../app/client-utils.ts';

test('room session storage is namespaced per room and rejects malformed tokens', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const tokenA = 'A'.repeat(43); const tokenB = 'B'.repeat(43);
  assert.equal(roomSessionKey('room-a'), 'zaily-room-session:room-a');
  storeRoomSession(storage, 'room-a', tokenA); storeRoomSession(storage, 'room-b', tokenB);
  assert.equal(readRoomSession(storage, 'room-a'), tokenA); assert.equal(readRoomSession(storage, 'room-b'), tokenB);
  storeRoomSession(storage, 'room-a', 'invalid'); assert.equal(readRoomSession(storage, 'room-a'), tokenA);
  clearRoomSession(storage, 'room-a'); assert.equal(readRoomSession(storage, 'room-a'), null);
  assert.equal(readStorage({ getItem: () => 'not-a-token' }, roomSessionKey('room-a')), 'not-a-token');
  assert.equal(readRoomSession({ getItem: () => 'not-a-token' }, 'room-a'), null);
});

test('requests send bearer credentials without caching authenticated responses', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/auth/me');
    assert.equal(options.headers.get('authorization'), 'Bearer secret');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.get('x-client'), 'web');
    return Response.json({ id: 'one' });
  });
  assert.deepEqual(await requestJson('/api/', '/auth/me', 'secret', { headers: new Headers({ 'X-Client': 'web' }) }), { id: 'one' });
});

test('multipart uploads preserve the browser generated boundary and bearer token', async (t) => {
  const body = new FormData(); body.append('file', new Blob(['docx']), 'quiz.docx');
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.get('authorization'), 'Bearer teacher-token');
    assert.equal(options.headers.has('content-type'), false);
    assert.equal(options.body, body);
    return Response.json({ title: 'Quiz' });
  });
  assert.deepEqual(await requestJson('/api', '/assignments/import-template', 'teacher-token', { method: 'POST', body }), { title: 'Quiz' });
});

test('an HTML proxy failure is a readable API error, not an empty successful result', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
  await assert.rejects(requestJson('/api', '/assignments'), error => error instanceof ApiError && error.status === 502 && error.message === 'Ошибка API (502)');
});

test('invalid successful responses cannot create a broken login session', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>wrong route</html>', { status: 200 }));
  await assert.rejects(requestJson('/api', '/auth/login'), /Сервер вернул некорректный ответ/);
});

test('validation arrays are converted into readable text', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: ['First error', 'Second error'] }, { status: 400 }));
  await assert.rejects(requestJson('/api', '/assignments'), /First error; Second error/);
});

test('401 retains its status for session clearing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'Expired' }, { status: 401 }));
  await assert.rejects(requestJson('/api', '/auth/me'), error => error instanceof ApiError && error.status === 401);
});

test('offline errors are actionable and do not expose browser internals', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(requestJson('/api', '/assignments'), /Нет связи с сервером/);
});

test('an unresponsive server is aborted instead of leaving every button disabled', async (t) => {
  t.mock.method(globalThis, 'fetch', (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  await assert.rejects(requestJson('/api', '/assignments', '', {}, 5), /Сервер не ответил вовремя/);
});

test('denied browser storage does not break login or logout', () => {
  const unavailable = { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('disabled'); }, removeItem() { throw new Error('disabled'); } };
  assert.equal(readStorage(unavailable, 'token'), null);
  assert.doesNotThrow(() => writeStorage(unavailable, 'token', 'value'));
  assert.doesNotThrow(() => writeStorage(unavailable, 'token', null));
});

test('zero numeric answers and unanswered choice lists are displayed correctly', () => {
  assert.equal(answerText({ numericValue: 0, question: {} }, 'empty'), '0');
  assert.equal(answerText({ jsonValue: [], question: {} }, 'empty'), 'empty');
  assert.equal(answerText({ jsonValue: 'a', question: { options: [{ id: 'a', text: 'Answer A' }] } }, 'empty'), 'Answer A');
});

test('student supplied HTML is rendered as text, never executable markup', () => {
  const malicious = '<img src=x onerror=alert(document.cookie)>';
  const rendered = renderToStaticMarkup(React.createElement('p', null, answerText({ textValue: malicious, question: {} }, 'empty')));
  assert.ok(rendered.includes('&lt;img'));
  assert.ok(!rendered.includes('<img'));
});

test('manual grades with no maximum do not inflate automatic percentages', () => {
  assert.equal(automaticScoreRate([
    { awardedPoints: 2, question: { type: 'SINGLE_CHOICE', points: 4 } },
    { awardedPoints: 500, question: { type: 'SHORT_TEXT', points: 0 } },
  ]), 50);
});

test('manual-only and ungraded work has no fabricated zero percentage', () => {
  assert.equal(automaticScoreRate([{ awardedPoints: 20, question: { type: 'SHORT_TEXT', points: 0 } }]), null);
  assert.equal(automaticScoreRate([{ awardedPoints: null, question: { type: 'SINGLE_CHOICE', points: 1 } }]), null);
});

test('score inputs match database precision and reject nonfinite and out-of-range values', () => {
  for (const value of [0, 0.01, 2.45, 10000]) assert.equal(validPoints(value), true);
  for (const value of [-1, NaN, Infinity, 10001, 0.001]) assert.equal(validPoints(value), false);
  assert.equal(validPoints(0, 0.01), false);
});
