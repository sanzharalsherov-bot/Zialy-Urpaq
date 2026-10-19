// One-time explicit LAN address update for this school's DuckDNS name.
// Reads only the restricted local settings file; never prints token or request URL.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import https from 'node:https';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const settings = require('dotenv').parse(readFileSync('.env.duckdns'));
assert.equal(settings.SCHOOL_HOSTNAME, 'zailyurpaq.duckdns.org');
assert(/^[0-9a-f-]{36}$/i.test(settings.DUCKDNS_API_TOKEN));
const url = new URL('https://www.duckdns.org/update');
url.searchParams.set('domains', 'zailyurpaq');
url.searchParams.set('token', settings.DUCKDNS_API_TOKEN);
url.searchParams.set('ip', '192.168.10.8');
await new Promise((resolve, reject) => {
  const request = https.get(url, { rejectUnauthorized: true }, response => {
    let body = ''; response.on('data', chunk => body += chunk);
    response.on('end', () => {
      if (response.statusCode !== 200 || body.trim() !== 'OK') return reject(new Error('DuckDNS rejected the address update; no credentials displayed'));
      console.log('DuckDNS accepted LAN IPv4 192.168.10.8 for zailyurpaq.duckdns.org'); resolve();
    });
  });
  request.setTimeout(20000, () => request.destroy(new Error('DNS API timeout')));
  request.on('error', error => reject(new Error(`DuckDNS connection failed: ${error.code ?? 'network error'}`)));
});
