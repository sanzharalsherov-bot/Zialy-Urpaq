const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const startServer = readFileSync(resolve(__dirname, '../../../packaging/windows/Start-Server.ps1'), 'utf8');
const installer = readFileSync(resolve(__dirname, '../../../packaging/windows/install.ps1'), 'utf8');
const compose = readFileSync(resolve(__dirname, '../../../compose.production.yaml'), 'utf8');
const caddy = readFileSync(resolve(__dirname, '../../../Caddyfile'), 'utf8');

test('Windows daily launcher starts the LiveKit media profile with the school platform', () => {
  assert.match(startServer, /Ensure-MediaConfig\.ps1/u);
  assert.match(startServer, /docker compose\s+--profile media\s+-p\s+\$composeProjectName/u);
});

test('Windows installation starts LiveKit as part of the school platform', () => {
  assert.match(installer, /Ensure-MediaConfig\.ps1/u);
  assert.match(installer, /@\('compose',\s*'--profile',\s*'media',\s*'-p',\s*\$composeProjectName/u);
});

test('API waits for both PostgreSQL databases before startup', () => {
  assert.match(compose, /results-postgres:\s*\n\s+condition: service_healthy/u);
  assert.match(compose, /postgres:\s*\n\s+condition: service_healthy/u);
});

test('Windows setup synchronizes credentials with both persistent PostgreSQL databases', () => {
  assert.match(installer, /Set-DatabaseRolePassword -ContainerName \$postgresContainer -DatabaseName 'schoolcrm' -DesiredPassword \$dbPassword/u);
  assert.match(installer, /Set-DatabaseRolePassword -ContainerName \$resultsContainer -DatabaseName 'schoolresults' -DesiredPassword \$dbPassword/u);
  assert.match(installer, /resultsDatabaseReady/u);
});

test('Windows backup uses PowerShell-safe Docker execution and verifies both dumps', () => {
  const backup = readFileSync(resolve(__dirname, '../../../packaging/windows/Backup.ps1'), 'utf8');
  assert.match(backup, /function Invoke-DockerChecked/u);
  assert.match(backup, /pg_restore', '--list'/u);
  assert.match(backup, /Get-FileHash -LiteralPath \$backupFile -Algorithm SHA256/u);
  assert.match(backup, /Get-FileHash -LiteralPath \$resultsBackupFile -Algorithm SHA256/u);
});

test('LiveKit signaling is routed through the web proxy and media has TCP and UDP listeners', () => {
  assert.match(caddy, /handle_path\s+\/livekit\*\s*\{\s*reverse_proxy\s+livekit:7880\s*\}/u);
  assert.match(compose, /"0\.0\.0\.0:7881:7881\/tcp"/u);
  assert.match(compose, /"0\.0\.0\.0:7882:7882\/udp"/u);
  assert.match(compose, /tcp_port:\s*7881/u);
  assert.match(compose, /udp_port:\s*7882/u);
});

test('school LAN has persistent HTTPS and WSS configuration', () => {
  assert.match(caddy, /https:\/\/\{\$SCHOOL_LAN_IP\}:443\s*\{\s*tls internal/u);
  assert.match(compose, /WEB_HTTPS_PORT:-8443\}:443/u);
  assert.match(compose, /caddy_data:\/data/u);
  assert.match(installer, /LIVEKIT_PUBLIC_URL="wss:\/\/\$\{serverAddress\}:8443\/livekit"/u);
  assert.match(installer, /lan-root-ca\.crt/u);
});

test('Windows firewall exposes only the required web and LiveKit ports to the private local subnet', () => {
  for (const [displayName, protocol, port] of [
    ['Zaily Urpaq School Platform', 'TCP', '8080'],
    ['Zaily Urpaq School HTTPS', 'TCP', '8443'],
    ['Zaily Urpaq LiveKit TCP', 'TCP', '7881'],
    ['Zaily Urpaq LiveKit UDP', 'UDP', '7882'],
  ]) {
    const escapedName = displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(installer, new RegExp(`DisplayName = '${escapedName}'; Protocol = '${protocol}'; LocalPort = ${port}`, 'u'));
  }
  assert.match(installer, /-RemoteAddress LocalSubnet -Profile Private/u);
});
