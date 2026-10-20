const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

test('Cloudflare configuration stores WSS signaling and preserves LAN media settings', {
  skip: process.platform !== 'win32' && 'Requires Windows PowerShell',
}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'zaily-cloudflare-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, 'LIVEKIT_API_KEY="lk_existing"\r\nLIVEKIT_API_SECRET="existing-secret-value-with-at-least-32-chars"\r\nLIVEKIT_PUBLIC_URL="ws://192.168.1.25:8080/livekit"\r\nLIVEKIT_NODE_IP="192.168.1.25"\r\nWEB_PORT="8080"\r\n', 'utf8');
  const script = resolve(__dirname, '../../../packaging/windows/Set-CloudflareSettings.ps1');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-EnvFile', envFile, '-Hostname', 'school.example.kz', '-TunnelToken', 'opaque-test-token-12345678901234567890='], { stdio: 'pipe' });
  const content = readFileSync(envFile, 'utf8');
  assert.match(content, /^CLOUDFLARE_TUNNEL_TOKEN="opaque-test-token-12345678901234567890="$/mu);
  assert.match(content, /^LIVEKIT_PUBLIC_URL="wss:\/\/school\.example\.kz\/livekit"$/mu);
  assert.match(content, /^LIVEKIT_NODE_IP="192\.168\.1\.25"$/mu);
  assert.match(content, /^LIVEKIT_API_SECRET="existing-secret-value-with-at-least-32-chars"$/mu);
});

test('Cloudflare configuration rejects URL schemes and paths without changing settings', {
  skip: process.platform !== 'win32' && 'Requires Windows PowerShell',
}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'zaily-cloudflare-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  const original = 'LIVEKIT_PUBLIC_URL="ws://192.168.1.25:8080/livekit"\r\n';
  writeFileSync(envFile, original, 'utf8');
  const script = resolve(__dirname, '../../../packaging/windows/Set-CloudflareSettings.ps1');
  assert.throws(() => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-EnvFile', envFile, '-Hostname', 'https://school.example.kz/path', '-TunnelToken', 'opaque-test-token'], { stdio: 'pipe' }));
  assert.equal(readFileSync(envFile, 'utf8'), original);
});

test('Cloudflare configuration normalizes hostnames and replaces duplicate settings', {
  skip: process.platform !== 'win32' && 'Requires Windows PowerShell',
}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'zaily-cloudflare-reconfigure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, 'LIVEKIT_PUBLIC_URL="ws://old-school:8080/livekit"\r\nLIVEKIT_PUBLIC_URL="ws://stale-school:8080/livekit"\r\nCLOUDFLARE_TUNNEL_TOKEN="old-token-12345678901234567890"\r\nCLOUDFLARE_TUNNEL_TOKEN="stale-token-12345678901234567890"\r\n', 'utf8');
  const script = resolve(__dirname, '../../../packaging/windows/Set-CloudflareSettings.ps1');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-EnvFile', envFile, '-Hostname', 'Tests.School.Example.KZ.', '-TunnelToken', 'replacement-token-12345678901234567890='], { stdio: 'pipe' });
  const content = readFileSync(envFile, 'utf8');
  assert.equal((content.match(/^LIVEKIT_PUBLIC_URL=/gmu) || []).length, 1);
  assert.equal((content.match(/^CLOUDFLARE_TUNNEL_TOKEN=/gmu) || []).length, 1);
  assert.match(content, /^LIVEKIT_PUBLIC_URL="wss:\/\/tests\.school\.example\.kz\/livekit"$/mu);
  assert.match(content, /^CLOUDFLARE_TUNNEL_TOKEN="replacement-token-12345678901234567890="$/mu);
});

test('Cloudflare setup rejects DuckDNS domains before modifying the environment file', {
  skip: process.platform !== 'win32' && 'Requires Windows PowerShell',
}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'zaily-cloudflare-duckdns-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  const original = 'LIVEKIT_PUBLIC_URL="wss://192.168.1.25:8443/livekit"\\r\\nCLOUDFLARE_TUNNEL_TOKEN=""\\r\\n';
  writeFileSync(envFile, original, 'utf8');
  const script = resolve(__dirname, '../../../packaging/windows/Set-CloudflareSettings.ps1');
  for (const hostname of ['zailyurpaq.duckdns.org', 'other.example.duckdns.org']) {
    assert.throws(() => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-EnvFile', envFile, '-Hostname', hostname, '-TunnelToken', 'opaque-test-token-12345678901234567890='], { stdio: 'pipe' }));
    assert.equal(readFileSync(envFile, 'utf8'), original);
  }
});

test('Cloudflare configuration rejects a malformed token without modifying the environment file', {
  skip: process.platform !== 'win32' && 'Requires Windows PowerShell',
}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'zaily-cloudflare-token-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  const original = 'LIVEKIT_PUBLIC_URL="ws://192.168.1.25:8080/livekit"\r\n';
  writeFileSync(envFile, original, 'utf8');
  const script = resolve(__dirname, '../../../packaging/windows/Set-CloudflareSettings.ps1');
  assert.throws(() => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-EnvFile', envFile, '-Hostname', 'school.example.kz', '-TunnelToken', 'short'], { stdio: 'pipe' }));
  assert.equal(readFileSync(envFile, 'utf8'), original);
});
