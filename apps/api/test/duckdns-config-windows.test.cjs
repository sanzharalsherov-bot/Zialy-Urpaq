const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const script = resolve(__dirname, '../../../packaging/windows/Set-DuckDnsSettings.ps1');
const fakeToken = '11111111-2222-3333-4444-555555555555';
test('DuckDNS settings isolate token from main env and do not print it', { skip: process.platform !== 'win32' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'zaily-duckdns-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = join(dir, '.env'); const file = join(dir, '.env.duckdns');
  writeFileSync(main, 'POSTGRES_PASSWORD=existing\nJWT_SECRET=unchanged\n');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-SettingsFile', file, '-Hostname', 'ZailyUrpaq.duckdns.org', '-Token', fakeToken], { encoding: 'utf8' });
  assert.equal(readFileSync(main, 'utf8'), 'POSTGRES_PASSWORD=existing\nJWT_SECRET=unchanged\n');
  assert.equal(readFileSync(file, 'utf8'), `SCHOOL_HOSTNAME=zailyurpaq.duckdns.org\r\nDUCKDNS_API_TOKEN=${fakeToken}\r\n`);
  assert(!output.includes(fakeToken));
});
test('DuckDNS invalid destination or token cannot alter existing settings', { skip: process.platform !== 'win32' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'zaily-duckdns-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '.env.duckdns'); writeFileSync(file, 'keep-existing-settings');
  for (const [name, token, target] of [['https://zailyurpaq.duckdns.org', fakeToken, file],
    ['zailyurpaq.duckdns.org', 'bad\nINJECTED=yes', file], ['zailyurpaq.duckdns.org', fakeToken, join(dir, '.env')]]) {
    assert.throws(() => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-SettingsFile', target, '-Hostname', name, '-Token', token], { stdio: 'pipe' }));
    assert.equal(readFileSync(file, 'utf8'), 'keep-existing-settings');
  }
  assert(!existsSync(join(dir, '.env')));
});
