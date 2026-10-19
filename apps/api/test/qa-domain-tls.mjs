// Connect only to the local school server, with the public hostname as SNI.
// Uses system/public CA trust, never the temporary Caddy root.
import https from 'node:https';
import assert from 'node:assert/strict';
const [hostname = 'zailyurpaq.duckdns.org', ip = '192.168.10.8', port = '18443'] = process.argv.slice(2);
assert.equal(hostname, 'zailyurpaq.duckdns.org');
assert.equal(ip, '192.168.10.8');
for (const path of ['/api/health', '/room', '/livekit/']) {
  await new Promise((resolve, reject) => {
    const request = https.get({ hostname: ip, servername: hostname, port, path,
      headers: { Host: `${hostname}:${port}` }, rejectUnauthorized: true }, response => {
      response.resume();
      try {
        assert.equal(response.statusCode, 200, path);
        assert.equal(response.socket.authorized, true);
        console.log(JSON.stringify({ path, status: response.statusCode, publicTrust: true,
          subject: response.socket.getPeerCertificate().subject, issuer: response.socket.getPeerCertificate().issuer }));
        resolve();
      } catch (error) { reject(error); }
    });
    request.setTimeout(12000, () => request.destroy(new Error('TLS verification timeout')));
    request.on('error', error => reject(new Error(`Public TLS verification failed: ${error.code ?? 'unknown'}`)));
  });
}
