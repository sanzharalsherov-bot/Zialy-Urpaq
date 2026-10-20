// Read-only release smoke check for an installed school LAN server.
// Never disables TLS verification, sends credentials, or accepts public Internet hosts.
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import assert from 'node:assert/strict';

const baseValue = process.env.QA_BASE_URL;
const caFile = process.env.QA_CA_FILE;
if (!baseValue || !caFile) {
  throw new Error('Set QA_BASE_URL (for example https://192.168.1.20:8443) and QA_CA_FILE to the public LAN root certificate');
}
const base = new URL(baseValue);
assert.equal(base.protocol, 'https:', 'Release smoke check requires HTTPS');
assert.equal(base.username, '', 'Credentials must not be embedded in the URL');
assert.equal(base.password, '', 'Credentials must not be embedded in the URL');
assert.equal(base.pathname, '/', 'QA_BASE_URL must contain only the server origin');
assert.equal(base.search, '', 'QA_BASE_URL must not contain a query');
assert.equal(base.hash, '', 'QA_BASE_URL must not contain a fragment');

function isPrivateIpv4(host) {
  if (host === 'localhost') return true;
  if (isIP(host) !== 4) return false;
  const octets = host.split('.').map(Number);
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 169 && octets[1] === 254);
}
assert(isPrivateIpv4(base.hostname), 'Only localhost or a private/link-local IPv4 address is allowed; public hosts are refused');
const ca = readFileSync(caFile);
const endpoint = new URL('/api/health', base);

function getHealth() {
  return new Promise((resolve, reject) => {
    const request = https.get(endpoint, { ca, rejectUnauthorized: true, timeout: 5000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`Health endpoint returned HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Health endpoint did not return valid JSON')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Health endpoint timed out')));
    request.on('error', error => reject(new Error(`HTTPS health check failed: ${error.code ?? 'network/TLS error'}`)));
  });
}

let health;
for (let attempt = 0; attempt < 10; attempt++) {
  health = await getHealth();
  assert.equal(health.status, 'ok', 'API is not healthy');
  assert.equal(health.database, 'connected', 'Primary database is not connected');
  assert.equal(health.service, 'school-crm-api', 'Unexpected API service identity');
  const delivery = health.resultsDelivery;
  assert(delivery && ['connected', 'pending', 'unavailable', 'disabled'].includes(delivery.status),
    'Missing or invalid resultsDelivery health status');
  if (delivery.status === 'connected' && delivery.pendingCount === 0) break;
  if (delivery.status === 'unavailable' || delivery.status === 'disabled') {
    throw new Error(`Results delivery is not ready: ${delivery.status}`);
  }
  if (attempt === 9) throw new Error('Results export queue did not drain to zero within the smoke-check window');
  await new Promise(resolve => setTimeout(resolve, 2000));
}
console.log(JSON.stringify({
  result: 'passed',
  https: 'verified',
  api: health.service,
  primaryDatabase: health.database,
  resultsDelivery: health.resultsDelivery.status,
  pendingResults: health.resultsDelivery.pendingCount,
  readOnly: true,
  mediaVerified: false,
  wifiRecoveryVerified: false,
  backupRestoreVerified: false,
}));
