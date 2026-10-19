const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

test('Windows media setup upgrades an existing environment without changing its other settings', {
  skip: process.platform !== 'win32' && 'Requires Windows PowerShell',
}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'zaily-media-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  const original = 'POSTGRES_PASSWORD="existing-secret"\r\nJWT_SECRET="existing-jwt"\r\n';
  writeFileSync(envFile, original, 'utf8');
  const script = resolve(__dirname, '../../../packaging/windows/Ensure-MediaConfig.ps1');
  const run = () => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-EnvFile', envFile, '-LanIp', '192.168.77.10'], { stdio: 'pipe' });

  run();
  const first = readFileSync(envFile, 'utf8');
  assert.ok(first.startsWith(original));
  assert.match(first, /^LIVEKIT_API_KEY="[A-Za-z0-9_-]{20,}"$/mu);
  assert.match(first, /^LIVEKIT_API_SECRET="[A-Za-z0-9_-]{32,}"$/mu);
  assert.match(first, /^LIVEKIT_PUBLIC_URL="wss:\/\/192\.168\.77\.10:8443\/livekit"$/mu);
  assert.match(first, /^SCHOOL_LAN_IP="192\.168\.77\.10"$/mu);
  assert.match(first, /^WEB_HTTPS_PORT="8443"$/mu);
  assert.match(first, /^LIVEKIT_NODE_IP="192\.168\.77\.10"$/mu);
  run();
  assert.equal(readFileSync(envFile, 'utf8'), first, 'An existing installation keeps its generated credentials');
});

test('Windows media setup repairs the old RTC TCP port URL and honors the website port', {
  skip: process.platform !== 'win32' && 'Requires Windows PowerShell',
}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'zaily-media-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, 'WEB_PORT="8090"\r\nLIVEKIT_PUBLIC_URL="ws://192.168.77.10:7881"\r\n', 'utf8');
  const script = resolve(__dirname, '../../../packaging/windows/Ensure-MediaConfig.ps1');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-EnvFile', envFile, '-LanIp', '192.168.77.10'], { stdio: 'pipe' });
  const content = readFileSync(envFile, 'utf8');
  assert.match(content, /^LIVEKIT_PUBLIC_URL="wss:\/\/192\.168\.77\.10:8443\/livekit"$/mu);
});

test('Windows media setup fills blank media settings once and preserves configured public URL', {
  skip: process.platform !== 'win32' && 'Requires Windows PowerShell',
}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'zaily-media-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, 'LIVEKIT_API_KEY=""\r\nLIVEKIT_API_SECRET=\r\nLIVEKIT_PUBLIC_URL="wss://media.school.example"\r\nLIVEKIT_NODE_IP=\r\n', 'utf8');
  const script = resolve(__dirname, '../../../packaging/windows/Ensure-MediaConfig.ps1');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-EnvFile', envFile, '-LanIp', '192.168.77.10'], { stdio: 'pipe' });
  const content = readFileSync(envFile, 'utf8');
  assert.equal((content.match(/^LIVEKIT_API_KEY=/gm) ?? []).length, 1);
  assert.equal((content.match(/^LIVEKIT_API_SECRET=/gm) ?? []).length, 1);
  assert.match(content, /^LIVEKIT_API_KEY="[A-Za-z0-9_-]{20,}"$/mu);
  assert.match(content, /^LIVEKIT_API_SECRET="[A-Za-z0-9_-]{32,}"$/mu);
  assert.match(content, /^LIVEKIT_PUBLIC_URL="wss:\/\/media\.school\.example"$/mu);
  assert.match(content, /^LIVEKIT_NODE_IP="192\.168\.77\.10"$/mu);
});
