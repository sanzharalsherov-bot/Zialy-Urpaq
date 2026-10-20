# Local-only administrator password recovery. The password is sent to Docker over stdin,
# never passed as a command-line argument and never written to logs or .env.
$ErrorActionPreference = 'Stop'

$encodedInput = ([Console]::In.ReadToEnd()).Trim()
if ([string]::IsNullOrWhiteSpace($encodedInput)) { throw 'Не получены данные формы восстановления.' }
try {
  $configJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedInput))
  $config = $configJson | ConvertFrom-Json
} catch { throw 'Данные формы восстановления повреждены. Закройте окно и откройте его повторно.' }

$email = ([string]$config.email).Trim().ToLowerInvariant()
$password = [string]$config.password
if ($email.Length -gt 254) { throw 'Email слишком длинный.' }
try { $null = New-Object System.Net.Mail.MailAddress($email) } catch { throw 'Введите корректный email администратора.' }
if ($password.Length -lt 12 -or $password.Length -gt 128) { throw 'Пароль должен содержать от 12 до 128 символов.' }
if ([Text.Encoding]::UTF8.GetByteCount($password) -gt 72) { throw 'Пароль слишком длинный в UTF-8. Допустимо не более 72 байт.' }
if ($password -match '[\x00-\x08\x0B\x0C\x0E-\x1F]') { throw 'Пароль содержит недопустимые управляющие символы.' }

$projectDir = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$envFile = Join-Path $projectDir '.env'
$composeFile = Join-Path $projectDir 'compose.production.yaml'
$projectNameFile = Join-Path $projectDir '.compose-project'
if (-not (Test-Path -LiteralPath $envFile) -or -not (Test-Path -LiteralPath $composeFile)) {
  throw 'Не найдена установка Zaily Urpaq в папке установленного приложения.'
}
if (-not (Test-Path -LiteralPath $projectNameFile)) { throw 'Не найден идентификатор Docker-проекта. Запустите платформу через ярлык и повторите попытку.' }
$projectName = (Get-Content -LiteralPath $projectNameFile -Raw).Trim()
if ($projectName -notmatch '^[a-z0-9][a-z0-9_-]{0,62}$') { throw 'Идентификатор Docker-проекта некорректен. Пароль не изменён.' }

$dockerCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'),
  (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe')
)
$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
if ($dockerCommand) { $dockerCandidates += $dockerCommand.Source }
$dockerExe = $dockerCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $dockerExe) { throw 'Docker Desktop CLI не найден. Запустите Docker Desktop и повторите попытку.' }

$apiContainer = "$projectName-api-1"
$previousPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  $inspectOutput = @(& $dockerExe inspect --format '{{.State.Running}}|{{index .Config.Labels "com.docker.compose.project"}}' $apiContainer 2>&1)
  $inspectExitCode = $LASTEXITCODE
} finally { $ErrorActionPreference = $previousPreference }
if ($inspectExitCode -ne 0 -or $inspectOutput.Count -eq 0) {
  throw 'API-контейнер этой установки не найден. Сначала запустите Zaily Urpaq ярлыком и дождитесь готовности сервера.'
}
$parts = ([string]$inspectOutput[0]).Trim() -split '\|', 2
if ($parts.Count -ne 2 -or $parts[0] -ne 'true' -or $parts[1] -ne $projectName) {
  throw 'API-контейнер не принадлежит текущему Docker-проекту или не запущен. Ничего не изменено.'
}

# Fixed JavaScript code is base64-encoded into the command line. The supplied email
# and password remain JSON input on stdin and are not exposed in process arguments.
$nodeSource = @'
const fs = require("node:fs");
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
(async () => {
  const prisma = new PrismaClient();
  try {
    const email = String(payload.email || "").trim().toLowerCase();
    const password = String(payload.password || "");
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true, isActive: true } });
    if (!user || user.role !== "ADMIN") throw new Error("ADMIN_ACCOUNT_NOT_FOUND");
    if (!user.isActive) throw new Error("ADMIN_ACCOUNT_INACTIVE");
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    process.stdout.write("ADMIN_PASSWORD_RESET_OK\n");
  } catch (error) {
    const code = error && typeof error.message === "string" ? error.message : "";
    if (code === "ADMIN_ACCOUNT_NOT_FOUND" || code === "ADMIN_ACCOUNT_INACTIVE") console.error(code);
    else console.error("ADMIN_PASSWORD_RESET_FAILED");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
'@
$nodeSourceBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($nodeSource))
$nodeExpression = "eval(Buffer.from('$nodeSourceBase64','base64').toString('utf8'))"

$processInfo = New-Object Diagnostics.ProcessStartInfo
$processInfo.FileName = $dockerExe
$processInfo.Arguments = "exec -i -w /app $apiContainer node -e `"$nodeExpression`""
$processInfo.UseShellExecute = $false
$processInfo.CreateNoWindow = $true
$processInfo.RedirectStandardInput = $true
$processInfo.RedirectStandardOutput = $true
$processInfo.RedirectStandardError = $true
$process = New-Object Diagnostics.Process
$process.StartInfo = $processInfo
try {
  if (-not $process.Start()) { throw 'Не удалось запустить локальную операцию восстановления.' }
  $payload = @{ email = $email; password = $password } | ConvertTo-Json -Compress
  $process.StandardInput.Write($payload)
  $process.StandardInput.Close()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
} finally { $process.Dispose() }

if ($process.ExitCode -ne 0) {
  if ($stderr -match 'ADMIN_ACCOUNT_NOT_FOUND') {
    throw 'Для введённого email не найдена активная учётная запись администратора. Пароль не изменён. Проверьте email, который использовался при первой установке.'
  }
  if ($stderr -match 'ADMIN_ACCOUNT_INACTIVE') {
    throw 'Учётная запись администратора отключена. Пароль не изменён; требуется проверить статус аккаунта.'
  }
  throw 'Не удалось безопасно обновить пароль. Проверьте, что обе базы и API работают, затем повторите попытку. Существующие данные не удалялись.'
}
if ($stdout -notmatch 'ADMIN_PASSWORD_RESET_OK') { throw 'Сервер не подтвердил обновление пароля. Повторите проверку входа; данные не удалялись.' }
Write-Output 'ADMIN_PASSWORD_RESET_OK'
Write-Output "Пароль обновлён для существующей учётной записи администратора: $email"
