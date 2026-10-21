const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const recovery = readFileSync(resolve(__dirname, '../../../packaging/windows/Reset-Admin-Password.ps1'), 'utf8');
const launcher = readFileSync(resolve(__dirname, '../../../packaging/windows/InstallerApp.cs'), 'utf8');
const installer = readFileSync(resolve(__dirname, '../../../packaging/windows/install.ps1'), 'utf8');

const nodePayloadMatch = recovery.match(/^\$nodeSourceBase64 = '([A-Za-z0-9+/=]+)'$/mu);
const embeddedNodeSource = nodePayloadMatch ? Buffer.from(nodePayloadMatch[1], 'base64').toString('utf8') : '';

test('admin recovery is a local GUI action protected by Windows elevation', () => {
  assert.match(launcher, /"--reset-admin"/u);
  assert.match(launcher, /new AdminRecoveryForm/u);
  assert.match(launcher, /Восстановление пароля администратора/u);
  assert.match(launcher, /Encoding\.UTF8\.GetByteCount\(password\.Text\) > 72/u);
});

test('admin recovery can only update an existing active ADMIN in the selected Compose project', () => {
  assert.match(embeddedNodeSource, /role !== "ADMIN"/u);
  assert.match(embeddedNodeSource, /!user\.isActive/u);
  assert.match(embeddedNodeSource, /prisma\.user\.update/u);
  assert.match(recovery, /com\.docker\.compose\.project/u);
  assert.ok(recovery.includes('label=com.docker.compose.project=$projectName'));
  assert.ok(recovery.includes("label=com.docker.compose.service=api"));
  assert.match(recovery, /Select-Object -Unique/u);
  assert.ok(recovery.includes('$apiContainerIds.Count -ne 1'));
  assert.ok(recovery.includes("$parts[2] -ne 'api'"));
  assert.doesNotMatch(recovery, /\$apiContainer = "\$projectName-api-1"/u);
  assert.match(recovery, /данные не удалялись/iu);
  assert.doesNotMatch(recovery, /DROP DATABASE|down -v|prisma\.user\.delete/iu);
});

test('admin recovery fails closed when Docker does not return exactly one running API container', () => {
  assert.ok(recovery.includes('$apiContainerProbeExitCode -ne 0'));
  assert.ok(recovery.includes('$apiContainerIds.Count -eq 0'));
  assert.ok(recovery.includes('$apiContainerIds.Count -ne 1'));
  assert.ok(recovery.includes('label=com.docker.compose.project=$projectName'));
  assert.ok(recovery.includes("label=com.docker.compose.service=api"));
  assert.ok(recovery.includes("-split '\\|', 3"));
});

test('admin recovery sends credentials over stdin and never writes passwords to logs or .env', () => {
  assert.match(recovery, /process\.StandardInput\.Write\(\$payload\)/u);
  assert.match(recovery, /RedirectStandardInput = \$true/u);
  assert.match(embeddedNodeSource, /passwordHash = await bcrypt\.hash\(password, 12\)/u);
  assert.doesNotMatch(recovery, /Write-Host[^\n]*\$password|Write-Output[^\n]*\$password/u);
  assert.doesNotMatch(recovery, /Set-Content[^\n]*\.env|WriteAllText\([^\n]*\.env/u);
});

test('admin recovery identifies the only active administrator when email is omitted', () => {
  assert.match(launcher, /если он один/u);
  assert.match(recovery, /if \(\$email\) \{/u);
  assert.match(embeddedNodeSource, /findMany\(\{ where: \{ role: "ADMIN", isActive: true \}/u);
  assert.match(embeddedNodeSource, /users\.length > 1/u);
  assert.match(embeddedNodeSource, /ADMIN_EMAIL_REQUIRED/u);
  assert.match(embeddedNodeSource, /ADMIN_ACCOUNT_EMAIL:/u);
});

test('installer does not claim submitted credentials were applied when accounts already exist', () => {
  assert.match(installer, /ADMIN_CREDENTIALS_NOT_CHANGED/u);
  assert.match(launcher, /adminCredentialsUnchanged/u);
  assert.match(launcher, /пароль из формы обновления не применялся/iu);
});

test('installer adds the administrator recovery shortcut without recreating user accounts', () => {
  assert.match(launcher, /"--reset-admin"/u);
  assert.match(launcher, /CreateShortcut\(shell, Path\.Combine\(desktop, "Zaily Urpaq - Восстановление пароля администратора\.lnk"\)/u);
  assert.match(launcher, /recoverAdminButton\.Click \+= RecoverAdmin/u);
  assert.match(launcher, /new AdminRecoveryForm\(Path\.Combine\(destination/u);
  assert.match(installer, /if \(-not \(Test-Path \$setupComplete\)\)/u);
  assert.match(installer, /if \(\$existingUserCount -gt 0\)/u);
  assert.match(installer, /Сохраняю их без изменений/u);
});


test('admin recovery embeds Node code as static base64 so PowerShell parses the complete script', () => {
  const match = recovery.match(/^\$nodeSourceBase64 = '([A-Za-z0-9+/=]+)'$/mu);
  assert.ok(match, 'recovery should use a static base64 JavaScript payload, not a PowerShell here-string');
  assert.doesNotMatch(recovery, /^\$nodeSource = @'/mu);
  const nodeSource = Buffer.from(match[1], 'base64').toString('utf8');
  assert.match(nodeSource, /new PrismaClient\(\)/u);
  assert.match(nodeSource, /role !== "ADMIN"/u);
  assert.match(nodeSource, /bcrypt\.hash\(password, 12\)/u);
  assert.match(nodeSource, /ADMIN_PASSWORD_RESET_OK/u);
});


test('admin recovery script uses UTF-8 BOM for Windows PowerShell 5.1 Cyrillic text', () => {
  assert.equal(recovery.charCodeAt(0), 0xFEFF, 'UTF-8 BOM is required so Windows PowerShell 5.1 does not decode Cyrillic as ANSI');
});
