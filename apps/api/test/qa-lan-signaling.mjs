// Explicit local CA verification; never disables TLS verification or prints credentials.
// node apps/api/test/qa-lan-signaling.mjs <test.env> <root.crt>
import { readFileSync } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { JoinRequest, WrappedJoinRequest, ClientInfo, ConnectionSettings } from '@livekit/protocol';
const require = createRequire(import.meta.url);
const { parse } = require('dotenv');
const { buildLiveKitToken } = require('../dist/assignments/livekit.service');
const [envFile, rootFile] = process.argv.slice(2);
assert(envFile && rootFile, 'Provide the isolated environment and its public CA file');
const env = parse(readFileSync(envFile));
const ca = readFileSync(rootFile);
const base = new URL(env.LIVEKIT_PUBLIC_URL);
assert.equal(base.protocol, 'wss:');
// A browser opening a non-standard TLS port as HTTP must be upgraded safely.
const securePage = new URL(`${base.origin.replace('wss:', 'https:')}/room?qa=upgrade`);
const plainPage = new URL(securePage); plainPage.protocol = 'http:';
await new Promise((resolve, reject) => {
  const request = http.get(plainPage, response => {
    response.resume();
    try {
      assert([301, 302, 307, 308].includes(response.statusCode), `Expected HTTPS upgrade, got HTTP ${response.statusCode}`);
      assert.equal(response.headers.location, securePage.href, 'Upgrade must preserve TLS port, path and query');
      console.log('Plain HTTP on TLS port redirects to the exact HTTPS URL'); resolve();
    } catch (error) { reject(error); }
  });
  request.setTimeout(10000, () => request.destroy(new Error('Upgrade check timed out')));
  request.on('error', reject);
});
const token = buildLiveKitToken({ apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET,
  identity: `qa:${randomBytes(8).toString('hex')}`, name: 'Signaling QA',
  room: `qa-signaling-${Date.now()}`, staff: true });
const join = new JoinRequest({ clientInfo: new ClientInfo({ protocol: 16, version: 'qa-lan' }),
  connectionSettings: new ConnectionSettings({ autoSubscribe: true }) });
const wrapped = new WrappedJoinRequest({ joinRequest: join.toBinary() });
const url = new URL(`${base.pathname.replace(/\/$/, '')}/rtc/v1`, base);
url.protocol = 'https:';
url.searchParams.set('access_token', token);
url.searchParams.set('join_request', Buffer.from(wrapped.toBinary()).toString('base64url'));
await new Promise((resolve, reject) => {
  const request = https.get(url, { ca, rejectUnauthorized: true, headers: {
    Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
  } });
  request.setTimeout(15000, () => request.destroy(new Error('WSS verification timed out')));
  request.on('upgrade', (response, socket) => {
    try {
      assert.equal(response.statusCode, 101);
      assert.equal(socket.authorized, true);
      console.log(JSON.stringify({ signaling: 101, tlsAuthorized: socket.authorized,
        san: socket.getPeerCertificate().subjectaltname, mediaVerified: false }));
      socket.destroy(); resolve();
    } catch (error) { socket.destroy(); reject(error); }
  });
  request.on('response', response => { response.resume(); reject(new Error(`WSS returned HTTP ${response.statusCode}`)); });
  request.on('error', error => reject(new Error(`WSS connection failed: ${error.code ?? 'TLS/network error'}`)));
});
