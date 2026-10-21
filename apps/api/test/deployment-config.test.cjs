const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { validateProductionConfiguration } = require('../dist/config/production-config');

const startServer = readFileSync(resolve(__dirname, '../../../packaging/windows/Start-Server.ps1'), 'utf8');
const installer = readFileSync(resolve(__dirname, '../../../packaging/windows/install.ps1'), 'utf8');
const compose = readFileSync(resolve(__dirname, '../../../compose.production.yaml'), 'utf8');
const caddy = readFileSync(resolve(__dirname, '../../../Caddyfile'), 'utf8');

test('Windows daily launcher starts the LiveKit media profile with the school platform', () => {
  assert.match(startServer, /Ensure-MediaConfig\.ps1/u);
  assert.match(startServer, /\$composeArguments = @\('compose', '--profile', 'media'\)/u);
  assert.match(startServer, /if \(\$cloudflareConfigured\) \{ \$composeArguments \+= @\('--profile', 'cloud'\) \}/u);
  assert.match(startServer, /docker @composeArguments/u);
});

test('Windows installation starts LiveKit as part of the school platform', () => {
  assert.match(installer, /Ensure-MediaConfig\.ps1/u);
  assert.match(installer, /\$stackArguments = @\('compose', '--profile', 'media'\)/u);
  assert.match(installer, /if \(\$cloudflareEnabled\) \{ \$stackArguments \+= @\('--profile', 'cloud'\) \}/u);
  assert.match(installer, /\$stackArguments \+= @\('-p', \$composeProjectName, '-f', \$composePath, 'up', '-d', '--build'\)/u);
});

test('Cloudflare configuration stays optional and is handled by the main installer', () => {
  const launcher = readFileSync(resolve(__dirname, '../../../packaging/windows/InstallerApp.cs'), 'utf8');
  assert.match(launcher, /AutoScroll = true/u);
  assert.match(launcher, /ClientSize = new Size\(800, 760\)/u);
  assert.match(launcher, /configureCloudflare = configureCloudflare\.Checked/u);
  assert.match(installer, /if \(\$cloudflareEnabled\).*?Set-CloudflareSettings\.ps1/su);
  assert.match(installer, /CLOUDFLARE_HEALTH_PENDING/u);
  assert.doesNotMatch(installer, /Enable-Cloudflare\.ps1/u);
  assert.match(startServer, /CLOUDFLARE_TUNNEL_TOKEN/u);
});

test('Windows installer detects LiveKit port conflicts before starting the stack and preserves existing data', () => {
  assert.match(installer, /function Assert-LiveKitPortsAvailable/u);
  assert.match(installer, /'ps', '--filter', "publish=\$port"/u);
  assert.match(installer, /ownerProject -ne \$composeProjectName/u);
  assert.match(installer, /Assert-LiveKitPortsAvailable\s+Write-Host ''\s+Write-Host 'Собираю и запускаю приложение/u);
  assert.match(installer, /Не удаляйте volumes и не выполняйте docker compose down -v/u);
});

test('API waits for both PostgreSQL databases before startup', () => {
  assert.match(compose, /results-postgres:\s*\n\s+condition: service_healthy/u);
  assert.match(compose, /postgres:\s*\n\s+condition: service_healthy/u);
});

test('Windows setup synchronizes credentials with both persistent PostgreSQL databases', () => {
  assert.match(installer, /Set-DatabaseRolePassword -ContainerName \$postgresContainer -DatabaseName 'schoolcrm' -DesiredPassword \$dbPassword/u);
  assert.match(installer, /Set-DatabaseRolePassword -ContainerName \$resultsContainer -DatabaseName 'schoolresults' -DesiredPassword \$dbPassword/u);
  assert.match(installer, /resultsDatabaseReady/u);
  assert.match(compose, /school_data:\s*\n\s+results_data:/u);
  assert.match(startServer, /docker @composeArguments/u);
});

test('installer creates a clean school while preserving schema and Docker volumes', () => {
  const launcher = readFileSync(resolve(__dirname, '../../../packaging/windows/InstallerApp.cs'), 'utf8');
  assert.match(launcher, /ВСЕ существующие аккаунты/u);
  assert.doesNotMatch(launcher, /resetSchoolData|Начать заново/u);
  assert.match(installer, /\$resetSchoolData = \$true/u);
  assert.match(installer, /if \(\$resetSchoolData -or -not \(Test-Path \$setupComplete\)\)/u);
  assert.match(installer, /stop', 'api'/u);
  assert.match(installer, /TRUNCATE TABLE[\s\S]*?RESTART IDENTITY CASCADE/u);
  assert.match(installer, /tablename <> '_prisma_migrations'/u);
  assert.match(installer, /Set-Content -Path \$setupComplete/u);
  assert.match(compose, /school_data:/u);
  assert.match(compose, /results_data:/u);
  assert.match(startServer, /composeArguments/u);
});

test('desktop and startup shortcuts use the Zaily Urpaq brand icon', () => {
  const launcher = readFileSync(resolve(__dirname, '../../../packaging/windows/InstallerApp.cs'), 'utf8');
  assert.match(launcher, /CreateBrandIcon\(installationPath\)/u);
  assert.match(launcher, /shortcut\.IconLocation = iconPath \+ ",0"/u);
  assert.match(launcher, /ZailyUrpaq\.ico/u);
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

test('Windows installer avoids interactive certificate prompts and continues if trust-store writes are blocked', () => {
  assert.match(installer, /X509Certificates\.X509Store/u);
  assert.match(installer, /StoreLocation\]::CurrentUser/u);
  assert.match(installer, /CERTIFICATE_TRUST_PENDING/u);
  assert.match(installer, /сервер и база уже запущены, установка продолжится/iu);
  assert.doesNotMatch(installer, /Import-Certificate -FilePath \$lanCertificateFile/u);
});

test('Windows Firewall opens only HTTPS and LiveKit ports to the private local subnet', () => {
  for (const [displayName, protocol, port] of [
    ['Zaily Urpaq School HTTPS', 'TCP', '8443'],
    ['Zaily Urpaq LiveKit TCP', 'TCP', '7881'],
    ['Zaily Urpaq LiveKit UDP', 'UDP', '7882'],
  ]) {
    const escapedName = displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(installer, new RegExp(`DisplayName = '${escapedName}'; Protocol = '${protocol}'; LocalPort = ${port}`, 'u'));
  }
  assert.match(installer, /-RemoteAddress LocalSubnet -Profile Private/u);
  assert.doesNotMatch(installer, /DisplayName = 'Zaily Urpaq School Platform'; Protocol = 'TCP'; LocalPort = 8080/u);
});

test('Windows backup cleans temporary dumps on success and failure paths', () => {
  const backup = readFileSync(resolve(__dirname, '../../../packaging/windows/Backup.ps1'), 'utf8');
  assert.match(backup, /function Backup-Database/u);
  assert.match(backup, /finally\s*\{/u);
  assert.match(backup, /'rm',\s*'-f',\s*\$RemoteDumpPath/u);
  assert.match(backup, /if \(-not \$backupSucceeded -and \(Test-Path -LiteralPath \$FilePath\)\)/u);
  assert.match(backup, /Write-Warning .*Проверьте контейнер вручную/u);
});

test('release smoke check verifies private-LAN HTTPS without credentials or TLS bypass', () => {
  const smoke = readFileSync(resolve(__dirname, './qa-release-smoke.mjs'), 'utf8');
  assert.match(smoke, /rejectUnauthorized:\s*true/u);
  assert.match(smoke, /isPrivateIpv4\(base\.hostname\)/u);
  assert.match(smoke, /Only localhost or a private\/link-local IPv4 address is allowed/u);
  assert.match(smoke, /\/api\/health/u);
  assert.match(smoke, /delivery\.pendingCount === 0/u);
  assert.doesNotMatch(smoke, /rejectUnauthorized:\s*false/u);
  assert.doesNotMatch(smoke, /Authorization:/u);
  assert.match(smoke, /mediaVerified:\s*false/u);
  assert.match(smoke, /backupRestoreVerified:\s*false/u);
});

test('release smoke check refuses public hosts and non-HTTPS URLs before network access', () => {
  const script = resolve(__dirname, './qa-release-smoke.mjs');
  const run = base => spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, QA_BASE_URL: base, QA_CA_FILE: 'nonexistent-public-test-ca.crt' },
  });
  const publicHost = run('https://example.com');
  assert.notEqual(publicHost.status, 0);
  assert.match(publicHost.stderr, /private\/link-local IPv4 address is allowed/u);

  const plainHttp = run('http://192.168.1.20:8443');
  assert.notEqual(plainHttp.status, 0);
  assert.match(plainHttp.stderr, /requires HTTPS/u);

  const embeddedCredentials = run('https://user:secret@192.168.1.20:8443');
  assert.notEqual(embeddedCredentials.status, 0);
  assert.match(embeddedCredentials.stderr, /Credentials must not be embedded/u);
});


test('CI recovery drill restricts destructive restore operations to local test databases', () => {
  const recovery = readFileSync(resolve(__dirname, './qa-postgres-recovery-ci.mjs'), 'utf8');
  assert.match(recovery, /\['localhost', '127\.0\.0\.1'\]/u);
  assert.match(recovery, /test\|audit/i);
  assert.match(recovery, /CREATE DATABASE/u);
  assert.match(recovery, /pg_dump/u);
  assert.match(recovery, /pg_restore.*--exit-on-error/u);
  assert.match(recovery, /DROP DATABASE IF EXISTS/u);
  assert.match(recovery, /productionDatabasesTouched:\s*false/u);
  assert.match(recovery, /Both CI databases must share the same local PostgreSQL service/u);
});

test('plain HTTP is bound to localhost and never opened to the school LAN', () => {
  assert.match(compose, /"127\.0\.0\.1:\$\{WEB_PORT:-8080\}:80"/u);
  assert.doesNotMatch(compose, /"0\.0\.0\.0:\$\{WEB_PORT:-8080\}:80"/u);
  assert.doesNotMatch(installer, /DisplayName = 'Zaily Urpaq School Platform'; Protocol = 'TCP'; LocalPort = 8080/u);
  assert.match(installer, /Remove-NetFirewallRule -DisplayName 'Zaily Urpaq School Platform'/u);
  assert.match(installer, /http:\/\/127\.0\.0\.1:8080\/api\/health/u);
  assert.match(installer, /http:\/\/localhost:8080/u);
  assert.match(caddy, /:80\s*\{\s*import school_routes/u);
});


test('production configuration refuses missing, short, or placeholder JWT secrets', () => {
  const base = { NODE_ENV: 'production', WEB_ORIGIN: 'https://192.168.1.20:8443' };
  const strongSecret = 'k9!Qv2#Lm7@Rs4$Xp8^Ta1&Zc6*Bn3?Hd5';
  for (const JWT_SECRET of ['', 'short', 'replace-with-random-secret-at-least-32-bytes', 'your-secret-' + 'x'.repeat(40)]) {
    assert.throws(() => validateProductionConfiguration({ ...base, JWT_SECRET }), /JWT_SECRET must be a unique random secret/u);
  }
  assert.throws(() => validateProductionConfiguration({ ...base, JWT_SECRET: strongSecret, WEB_ORIGIN: '' }), /WEB_ORIGIN must be a valid HTTPS origin/u);
  for (const WEB_ORIGIN of ['http://192.168.1.20:8443', '*', 'https://example.com/path', 'https://user:pass@example.com', 'https://example.com?x=1']) {
    assert.throws(() => validateProductionConfiguration({ ...base, JWT_SECRET: strongSecret, WEB_ORIGIN }), /WEB_ORIGIN/u, WEB_ORIGIN);
  }
  assert.doesNotThrow(() => validateProductionConfiguration({ ...base, JWT_SECRET: strongSecret }));
  assert.doesNotThrow(() => validateProductionConfiguration({ ...base, WEB_ORIGIN: 'https://school.example', JWT_SECRET: strongSecret }));
  assert.doesNotThrow(() => validateProductionConfiguration({ NODE_ENV: 'test' }));
});


test('production configuration rejects weak, repetitive, and reused JWT secrets', () => {
  const base = {
    NODE_ENV: 'production',
    WEB_ORIGIN: 'https://192.168.1.20:8443',
  };
  for (const JWT_SECRET of [
    'a'.repeat(48),
    'abcd'.repeat(12),
    'a'.repeat(32) + 'b',
  ]) {
    assert.throws(() => validateProductionConfiguration({ ...base, JWT_SECRET }), /JWT_SECRET must be a unique random secret/u);
  }
  const independentSecret = 'k9!Qv2#Lm7@Rs4$Xp8^Ta1&Zc6*Bn3?Hd5';
  for (const env of [
    { POSTGRES_PASSWORD: independentSecret },
    { BOOTSTRAP_ADMIN_KEY: independentSecret },
    { LIVEKIT_API_SECRET: independentSecret },
  ]) {
    assert.throws(() => validateProductionConfiguration({ ...base, ...env, JWT_SECRET: independentSecret }), /JWT_SECRET must be a unique random secret/u);
  }
  assert.doesNotThrow(() => validateProductionConfiguration({ ...base, JWT_SECRET: independentSecret, POSTGRES_PASSWORD: 'separate-db-secret', BOOTSTRAP_ADMIN_KEY: 'separate-bootstrap-secret' }));
});

test('production API and web containers run as the unprivileged Node user', () => {
  const apiDockerfile = readFileSync(resolve(__dirname, '../../../apps/api/Dockerfile'), 'utf8');
  const webDockerfile = readFileSync(resolve(__dirname, '../../../apps/web/Dockerfile'), 'utf8');
  assert.match(apiDockerfile, /ENV NODE_ENV=production[\s\S]*?USER node[\s\S]*?EXPOSE 4000/u);
  assert.match(webDockerfile, /COPY --chown=node:node --from=build[\s\S]*?USER node[\s\S]*?EXPOSE 3000/u);
  assert.doesNotMatch(apiDockerfile, /USER root/u);
  assert.doesNotMatch(webDockerfile, /USER root/u);
});


test('production CORS origin is explicitly configured as the school HTTPS origin', () => {
  const mediaConfig = readFileSync(resolve(__dirname, '../../../packaging/windows/Ensure-MediaConfig.ps1'), 'utf8');
  const envExample = readFileSync(resolve(__dirname, '../../../.env.example'), 'utf8');
  assert.match(compose, /WEB_ORIGIN:\s*\$\{WEB_ORIGIN:\?Set WEB_ORIGIN to the school's HTTPS origin\}/u);
  assert.match(mediaConfig, /Add-MissingSetting 'WEB_ORIGIN' "https:\/\/\$\{LanIp\}:\$\{httpsPort\}"/u);
  assert.match(envExample, /WEB_ORIGIN="https:\/\/192\.168\.1\.10:8443"/u);
});
