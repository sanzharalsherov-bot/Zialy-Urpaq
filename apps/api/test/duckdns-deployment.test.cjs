const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
test('DuckDNS overlay advertises the trusted domain and keeps database volumes and host ports', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zaily-duckdns-compose-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const secretFile = join(dir, '.env.duckdns');
  writeFileSync(secretFile, 'DUCKDNS_API_TOKEN=11111111-2222-3333-4444-555555555555\n');
  const envFile = join(dir, 'test.env');
  writeFileSync(envFile, `POSTGRES_PASSWORD=fake-config-only\nJWT_SECRET=fake-config-only\nWEB_ORIGIN=https://zailyurpaq.duckdns.org:18443\nSCHOOL_HOSTNAME=zailyurpaq.duckdns.org\nWEB_PORT=18080\nWEB_HTTPS_PORT=18443\nDUCKDNS_ENV_FILE=${secretFile.replaceAll('\\', '/')}\n`);
  const output = execFileSync('docker', ['compose', '--env-file', envFile, '-p', 'zaily-duckdns-config-test',
    '-f', resolve(__dirname, '../../../compose.production.yaml'), '-f', resolve(__dirname, '../../../compose.duckdns.yaml'), 'config', '--format', 'json'], { encoding: 'utf8' });
  const config = JSON.parse(output);
  assert.equal(config.services.api.environment.LIVEKIT_PUBLIC_URL, 'wss://zailyurpaq.duckdns.org:18443/livekit');
  assert.equal(config.services.api.environment.WEB_ORIGIN, 'https://zailyurpaq.duckdns.org:18443');
  assert.equal(config.services.caddy.volumes.find(v => v.target === '/data').source, 'caddy_data');
  assert.equal(config.services.postgres.volumes[0].source, 'school_data');
  assert.equal(config.services['results-postgres'].volumes[0].source, 'results_data');
  assert.deepEqual(config.services.caddy.ports.map(p => Number(p.published)).sort((a,b) => a-b), [18080,18443]);
  assert(!config.services.web.ports);
  assert.match(config.services.caddy.volumes.find(v => v.target === '/etc/caddy/Caddyfile').source, /Caddyfile\.duckdns$/);
});
