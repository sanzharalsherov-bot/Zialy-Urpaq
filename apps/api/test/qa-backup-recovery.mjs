// Exercises the exact packaged backup script; restores ONLY into new isolated volumes.
// No host ports, no production volume changes, no credentials in output.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const env = require('dotenv').parse(readFileSync('tmp/lancheck-20261019/test.env'));
const source = 'zaily-lancheck-20261019-postgres-1';
const sink = 'zaily-lancheck-20261019-results-postgres-1';
function run(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000, ...options });
  assert.equal(result.status, 0, `Docker ${args[0]} ${args[1]} failed: ${(result.stderr || result.error?.code || '').slice(0, 400)}`);
  return result.stdout.trim();
}
for (const name of [source, sink]) {
  const container = JSON.parse(run(['inspect', name]))[0];
  assert.equal(container.Config.Labels['com.docker.compose.project'], 'zaily-lancheck-20261019');
}
const stage = resolve('tmp/recovery-20261019');
mkdirSync(`${stage}/packaging/windows`, { recursive: true });
copyFileSync('packaging/windows/Backup.ps1', `${stage}/packaging/windows/Backup.ps1`);
copyFileSync('compose.production.yaml', `${stage}/compose.production.yaml`);
copyFileSync('tmp/lancheck-20261019/test.env', `${stage}/.env`);
writeFileSync(`${stage}/.compose-project`, 'zaily-lancheck-20261019');
const backup = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${stage}/packaging/windows/Backup.ps1`], { encoding: 'utf8', timeout: 120000 });
assert.equal(backup.status, 0, 'Packaged Backup.ps1 failed');
const files = readdirSync(`${stage}/backups`).filter(file => /^zailyurpaq-\d.*\.dump$/.test(file)).sort();
const primary = files.at(-1);
assert(primary, 'No source dump');
const results = primary.replace('zailyurpaq-', 'zailyurpaq-results-');
const hashes = {};
for (const file of [primary, results]) {
  assert(statSync(`${stage}/backups/${file}`).size > 0);
  hashes[file] = createHash('sha256').update(readFileSync(`${stage}/backups/${file}`)).digest('hex');
}
const tables = ['User', 'Assignment', 'TestRoom', 'RoomParticipant', 'Submission', 'Answer', 'ResultExportOutbox'];
function snapshot(container, database, names) {
  return Object.fromEntries(names.map(table => {
    const key = table === 'ExportedResult' ? 'sourceSubmissionId' : 'id';
    const sql = `SELECT count(*) || ':' || md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."${key}")::text,'[]')) FROM "${table}" t`;
    return [table, run(['exec', container, 'psql', '-U', 'schoolcrm', '-d', database, '-At', '-c', sql])];
  }));
}
const before = snapshot(source, 'schoolcrm', tables);
const beforeResults = snapshot(sink, 'schoolresults', ['ExportedResult']);
assert(!before.User.startsWith('0:'), 'Seed nonempty QA data before exercising recovery');
assert(!beforeResults.ExportedResult.startsWith('0:'), 'Wait for QA results export before recovery');
const project = `zaily-restorecheck-20261019-${randomBytes(4).toString('hex')}`;
const password = randomBytes(32).toString('hex');
const childEnv = { ...process.env, POSTGRES_PASSWORD: password };
run(['network', 'create', '--label', `zaily.qa=${project}`, project]);
const containers = [];
const volumes = [];
// Retain this isolated environment on failure for diagnosis; remove only owned resources after success.
for (const [suffix, database, alias, file] of [
  ['source', 'schoolcrm_test', 'postgres-test', primary],
  ['results', 'schoolresults_test', 'results-postgres', results],
]) {
  const name = `${project}-${suffix}`;
  const volume = `${name}-data`;
  run(['volume', 'create', '--label', `zaily.qa=${project}`, volume]); volumes.push(volume);
  run(['run', '-d', '--name', name, '--label', `zaily.qa=${project}`, '--network', project, '--network-alias', alias,
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_USER=schoolcrm', '-e', `POSTGRES_DB=${database}`,
    '--mount', `type=volume,src=${volume},dst=/var/lib/postgresql/data`, 'postgres:17-alpine'], { env: childEnv });
  containers.push(name);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const check = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'schoolcrm', '-d', database], { encoding: 'utf8' });
    if (check.status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(ready, 'Disposable PostgreSQL did not start');
  run(['cp', `${stage}/backups/${file}`, `${name}:/tmp/restore.dump`]);
  run(['exec', name, 'pg_restore', '--list', '/tmp/restore.dump']);
  run(['exec', name, 'pg_restore', '--exit-on-error', '--no-owner', '-U', 'schoolcrm', '-d', database, '/tmp/restore.dump']);
}
assert.deepEqual(snapshot(containers[0], 'schoolcrm_test', tables), before);
assert.deepEqual(snapshot(containers[1], 'schoolresults_test', ['ExportedResult']), beforeResults);
console.log('Both restored databases match source counts and complete row digests.');
const api = `${project}-api`;
const apiEnv = { ...process.env,
  DATABASE_URL: `postgresql://schoolcrm:${password}@postgres-test:5432/schoolcrm_test?schema=public`,
  RESULTS_DATABASE_URL: `postgresql://schoolcrm:${password}@results-postgres:5432/schoolresults_test?schema=public`,
  JWT_SECRET: env.JWT_SECRET,
};
run(['run', '-d', '--name', api, '--label', `zaily.qa=${project}`, '--network', project,
  '-e', 'DATABASE_URL', '-e', 'RESULTS_DATABASE_URL', '-e', 'JWT_SECRET', '-e', 'API_PORT=4000', '-e', 'NODE_ENV=production', '-e', 'WEB_ORIGIN=http://localhost',
  'zaily-lancheck-20261019-api:readiness'], { env: apiEnv }); containers.push(api);
let healthy = false;
for (let attempt = 0; attempt < 45; attempt++) {
  const check = spawnSync('docker', ['exec', api, 'node', '-e', "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { encoding: 'utf8' });
  if (check.status === 0) { healthy = true; break; }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert(healthy, 'Restored API did not become healthy');
const fixture = JSON.parse(readFileSync('tmp/lancheck-20261019/acceptance-fixture.json'));
const credentials = JSON.parse(readFileSync('tmp/lancheck-20261019/qa-credentials.json'));
const probe = `const a=require('assert/strict');const data=JSON.parse(require('fs').readFileSync(0,'utf8'));(async()=>{
  const login=await fetch('http://127.0.0.1:4000/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data.credentials)});
  a.equal(login.status,200);const session=await login.json();
  const response=await fetch('http://127.0.0.1:4000/api/rooms/'+data.fixture.roomId+'/analytics',{headers:{Authorization:'Bearer '+session.accessToken}});
  a.equal(response.status,200);const analytics=await response.json();a.equal(analytics.attemptCount,2);a.equal(analytics.summary.averageScore,2);
  console.log('Restored login and known result analytics verified');
})().catch(()=>{console.error('Restored application probe failed');process.exitCode=1})`;
console.log(run(['exec', '-i', api, 'node', '-e', probe], { input: JSON.stringify({ credentials, fixture }) }));
const integration = `process.env.TEST_DATABASE_URL=process.env.DATABASE_URL;process.env.TEST_RESULTS_DATABASE_URL=process.env.RESULTS_DATABASE_URL;
require('node:child_process').execFileSync(process.execPath,['--test','apps/api/test/assignments-postgres.test.cjs','apps/api/test/rooms-postgres.test.cjs','apps/api/test/results-outbox-postgres.test.cjs'],{stdio:'inherit'});`;
console.log(run(['exec', api, 'node', '-e', integration]));
const report = { project, backupHashes: hashes, primary: before, results: beforeResults,
  restoredRowsMatch: true, restoredLoginAndAnalytics: true, postgresIntegrationPassed: true,
  productionDatabasesModified: false };
writeFileSync(`${stage}/verification.json`, JSON.stringify(report, null, 2));
for (const name of containers.reverse()) {
  assert.equal(JSON.parse(run(['inspect', name]))[0].Config.Labels['zaily.qa'], project);
  run(['rm', '-f', name]);
}
for (const volume of volumes) {
  assert.equal(JSON.parse(run(['volume', 'inspect', volume]))[0].Labels['zaily.qa'], project);
  run(['volume', 'rm', volume]);
}
run(['network', 'rm', project]);
console.log('Recovery verified; only owned disposable restore resources removed. Dumps and verification.json retained.');
