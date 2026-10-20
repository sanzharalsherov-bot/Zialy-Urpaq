// CI-only recovery drill. Uses the disposable PostgreSQL service and Docker's
// PostgreSQL 17 client image; never accepts non-local or non-test database URLs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const image = 'postgres:17-alpine';
const sourceUrl = process.env.TEST_DATABASE_URL;
const resultsUrl = process.env.TEST_RESULTS_DATABASE_URL;
assert(sourceUrl && resultsUrl, 'Set TEST_DATABASE_URL and TEST_RESULTS_DATABASE_URL to disposable local test databases.');
function safeUrl(value, label) {
  const url = new URL(value);
  assert.equal(url.protocol, 'postgresql:', label + ' must use PostgreSQL.');
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), label + ' must be local to the CI runner.');
  assert.match(url.pathname, /test|audit/i, label + ' database name must include test/audit.');
  return url;
}
const source = safeUrl(sourceUrl, 'TEST_DATABASE_URL');
const results = safeUrl(resultsUrl, 'TEST_RESULTS_DATABASE_URL');
assert.notEqual(source.pathname, results.pathname, 'Source and results databases must be separate.');
const token = randomUUID();
const root = resolve('tmp/ci-backup-recovery');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const mount = root.replaceAll('\\', '/');
const env = { ...process.env };
function docker(args, extraEnv = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000, env: { ...env, ...extraEnv } });
  assert.equal(r.status, 0, 'Isolated PostgreSQL recovery command failed: ' + (r.stderr || r.error?.message || '').slice(-1000));
  return r.stdout.trim();
}
function pg(args, dbUrl, extraEnv = {}) {
  return docker(['run', '--rm', '--network', 'host', '-v', `${mount}:/backup`,
    '-e', 'DB_URL', image, ...args], { DB_URL: dbUrl, ...extraEnv });
}
const restoreSource = new URL(source.toString()); restoreSource.pathname = '/zaily_restore_source_test';
const restoreResults = new URL(results.toString()); restoreResults.pathname = '/zaily_restore_results_test';
try {
  // CI database is disposable. Create the second source DB and isolated restore targets.
  pg(['psql', '-v', 'ON_ERROR_STOP=1', '-d', source.toString(), '-c', 'CREATE TABLE IF NOT EXISTS "QaRecoverySentinel" ("id" text PRIMARY KEY, "payload" jsonb NOT NULL)']);
  pg(['psql', '-v', 'ON_ERROR_STOP=1', '-d', source.toString(), '-c', `INSERT INTO "QaRecoverySentinel" VALUES ('${token}', '{"database":"primary","stage":"ci-recovery"}')`]);
  pg(['psql', '-v', 'ON_ERROR_STOP=1', '-d', results.toString(), '-c', 'CREATE TABLE IF NOT EXISTS "QaRecoverySentinel" ("id" text PRIMARY KEY, "payload" jsonb NOT NULL)']);
  pg(['psql', '-v', 'ON_ERROR_STOP=1', '-d', results.toString(), '-c', `INSERT INTO "QaRecoverySentinel" VALUES ('${token}', '{"database":"results","stage":"ci-recovery"}')`]);

  for (const url of [restoreSource, restoreResults]) {
    pg(['psql', '-v', 'ON_ERROR_STOP=1', '-d', source.toString(), '-c', `CREATE DATABASE "${url.pathname.slice(1)}"`]);
  }
  pg(['pg_dump', '--format=custom', '--file=/backup/primary.dump', source.toString()]);
  pg(['pg_dump', '--format=custom', '--file=/backup/results.dump', results.toString()]);
  for (const file of ['primary.dump', 'results.dump']) pg(['pg_restore', '--list', `/backup/${file}`], source.toString());
  pg(['pg_restore', '--exit-on-error', '--no-owner', '-d', restoreSource.toString(), '/backup/primary.dump'], source.toString());
  pg(['pg_restore', '--exit-on-error', '--no-owner', '-d', restoreResults.toString(), '/backup/results.dump'], source.toString());

  for (const [url, expected] of [[restoreSource, 'primary'], [restoreResults, 'results']]) {
    const actual = pg(['psql', '-At', '-v', 'ON_ERROR_STOP=1', '-d', url.toString(), '-c', `SELECT "id" || ':' || "payload"->>'database' FROM "QaRecoverySentinel" WHERE "id" = '${token}'`], source.toString());
    assert.equal(actual, `${token}:${expected}`, 'Restored sentinel does not match its source database.');
  }
  const report = { passed: true, isolated: true, postgresMajor: 17, bothDumpsListed: true,
    bothDatabasesRestored: true, sourceAndResultsSentinelsMatched: true, productionDatabasesTouched: false };
  writeFileSync(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  // This script is intentionally restricted to test DB names on localhost.
  for (const url of [restoreSource, restoreResults]) {
    pg(['psql', '-v', 'ON_ERROR_STOP=1', '-d', source.toString(), '-c', `DROP DATABASE IF EXISTS "${url.pathname.slice(1)}"`], source.toString());
  }
  rmSync(root, { recursive: true, force: true });
}
