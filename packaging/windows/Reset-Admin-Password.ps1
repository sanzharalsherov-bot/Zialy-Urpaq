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
if ($email) { try { $null = New-Object -TypeName System.Net.Mail.MailAddress -ArgumentList $email } catch { throw 'Введите корректный email администратора.' } }
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

# Resolve the API container by Compose labels, not by a generated container name.
# Compose names can differ after reinstallations or when a project name was customized.
$previousPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  $apiContainerProbe = @(& $dockerExe ps --filter "label=com.docker.compose.project=$projectName" --filter 'label=com.docker.compose.service=api' --format '{{.ID}}' 2>&1)
  $apiContainerProbeExitCode = $LASTEXITCODE
} finally { $ErrorActionPreference = $previousPreference }
if ($apiContainerProbeExitCode -ne 0) {
  throw 'Не удалось проверить API-контейнеры Docker. Запустите Docker Desktop и повторите попытку. Пароль не изменён.'
}
$apiContainerIds = @($apiContainerProbe | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -match '^[a-f0-9]{12,64}$' } | Select-Object -Unique)
if ($apiContainerIds.Count -eq 0) {
  throw 'Запущенный API-контейнер этой установки не найден. Сначала запустите Zaily Urpaq ярлыком и дождитесь готовности сервера.'
}
if ($apiContainerIds.Count -ne 1) {
  throw 'Найдено несколько запущенных API-контейнеров этого Docker-проекта. Ничего не изменено во избежание сброса пароля не в том контейнере.'
}
$apiContainer = [string]$apiContainerIds[0]
$previousPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  $inspectOutput = @(& $dockerExe inspect --format '{{.State.Running}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' $apiContainer 2>&1)
  $inspectExitCode = $LASTEXITCODE
} finally { $ErrorActionPreference = $previousPreference }
if ($inspectExitCode -ne 0 -or $inspectOutput.Count -eq 0) {
  throw 'Не удалось проверить выбранный API-контейнер. Пароль не изменён.'
}
$parts = ([string]$inspectOutput[0]).Trim() -split '\|', 3
if ($parts.Count -ne 3 -or $parts[0] -ne 'true' -or $parts[1] -ne $projectName -or $parts[2] -ne 'api') {
  throw 'API-контейнер не принадлежит текущему Docker-проекту или не запущен. Ничего не изменено.'
}
# The fixed Node payload is stored as base64 so PowerShell never parses JavaScript syntax.
# The email and password remain JSON input on stdin and are not exposed in process arguments.
$nodeSourceBase64 = 'Y29uc3QgZnMgPSByZXF1aXJlKCJub2RlOmZzIik7CmNvbnN0IHsgUHJpc21hQ2xpZW50IH0gPSByZXF1aXJlKCJAcHJpc21hL2NsaWVudCIpOwpjb25zdCBiY3J5cHQgPSByZXF1aXJlKCJiY3J5cHRqcyIpOwpjb25zdCBwYXlsb2FkID0gSlNPTi5wYXJzZShmcy5yZWFkRmlsZVN5bmMoMCwgInV0ZjgiKSk7Cihhc3luYyAoKSA9PiB7CiAgY29uc3QgcHJpc21hID0gbmV3IFByaXNtYUNsaWVudCgpOwogIHRyeSB7CiAgICBjb25zdCBlbWFpbCA9IFN0cmluZyhwYXlsb2FkLmVtYWlsIHx8ICIiKS50cmltKCkudG9Mb3dlckNhc2UoKTsKICAgIGxldCB1c2VyOwogICAgaWYgKGVtYWlsKSB7CiAgICAgIHVzZXIgPSBhd2FpdCBwcmlzbWEudXNlci5maW5kVW5pcXVlKHsgd2hlcmU6IHsgZW1haWwgfSwgc2VsZWN0OiB7IGlkOiB0cnVlLCBlbWFpbDogdHJ1ZSwgcm9sZTogdHJ1ZSwgaXNBY3RpdmU6IHRydWUgfSB9KTsKICAgICAgaWYgKCF1c2VyIHx8IHVzZXIucm9sZSAhPT0gIkFETUlOIikgdGhyb3cgbmV3IEVycm9yKCJBRE1JTl9BQ0NPVU5UX05PVF9GT1VORCIpOwogICAgICBpZiAoIXVzZXIuaXNBY3RpdmUpIHRocm93IG5ldyBFcnJvcigiQURNSU5fQUNDT1VOVF9JTkFDVElWRSIpOwogICAgfSBlbHNlIHsKICAgICAgY29uc3QgdXNlcnMgPSBhd2FpdCBwcmlzbWEudXNlci5maW5kTWFueSh7IHdoZXJlOiB7IHJvbGU6ICJBRE1JTiIsIGlzQWN0aXZlOiB0cnVlIH0sIHNlbGVjdDogeyBpZDogdHJ1ZSwgZW1haWw6IHRydWUgfSB9KTsKICAgICAgaWYgKCF1c2Vycy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcigiQURNSU5fQUNDT1VOVF9OT1RfRk9VTkQiKTsKICAgICAgaWYgKHVzZXJzLmxlbmd0aCA+IDEpIHRocm93IG5ldyBFcnJvcigiQURNSU5fRU1BSUxfUkVRVUlSRUQiKTsKICAgICAgdXNlciA9IHVzZXJzWzBdOwogICAgfQogICAgY29uc3QgcGFzc3dvcmQgPSBTdHJpbmcocGF5bG9hZC5wYXNzd29yZCB8fCAiIik7CiAgICBjb25zdCBwYXNzd29yZEhhc2ggPSBhd2FpdCBiY3J5cHQuaGFzaChwYXNzd29yZCwgMTIpOwogICAgYXdhaXQgcHJpc21hLnVzZXIudXBkYXRlKHsgd2hlcmU6IHsgaWQ6IHVzZXIuaWQgfSwgZGF0YTogeyBwYXNzd29yZEhhc2ggfSB9KTsKICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBBRE1JTl9QQVNTV09SRF9SRVNFVF9PS1xuQURNSU5fQUNDT1VOVF9FTUFJTDoke3VzZXIuZW1haWx9XG5gKTsKICB9IGNhdGNoIChlcnJvcikgewogICAgY29uc3QgY29kZSA9IGVycm9yICYmIHR5cGVvZiBlcnJvci5tZXNzYWdlID09PSAic3RyaW5nIiA/IGVycm9yLm1lc3NhZ2UgOiAiIjsKICAgIGlmIChbIkFETUlOX0FDQ09VTlRfTk9UX0ZPVU5EIiwgIkFETUlOX0FDQ09VTlRfSU5BQ1RJVkUiLCAiQURNSU5fRU1BSUxfUkVRVUlSRUQiXS5pbmNsdWRlcyhjb2RlKSkgY29uc29sZS5lcnJvcihjb2RlKTsKICAgIGVsc2UgY29uc29sZS5lcnJvcigiQURNSU5fUEFTU1dPUkRfUkVTRVRfRkFJTEVEIik7CiAgICBwcm9jZXNzLmV4aXRDb2RlID0gMTsKICB9IGZpbmFsbHkgewogICAgYXdhaXQgcHJpc21hLiRkaXNjb25uZWN0KCk7CiAgfQp9KSgpOw=='
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
  $processExitCode = $process.ExitCode
} finally { $process.Dispose() }

if ($processExitCode -ne 0) {
  if ($stderr -match 'ADMIN_ACCOUNT_NOT_FOUND') {
    throw 'Для введённого email не найдена активная учётная запись администратора. Пароль не изменён. Проверьте email, который использовался при первой установке.'
  }
  if ($stderr -match 'ADMIN_ACCOUNT_INACTIVE') {
    throw 'Учётная запись администратора отключена. Пароль не изменён; требуется проверить статус аккаунта.'
  }
  if ($stderr -match 'ADMIN_EMAIL_REQUIRED') {
    throw 'В базе несколько администраторов. Укажите email нужной учётной записи.'
  }
  throw 'Не удалось безопасно обновить пароль. Проверьте, что обе базы и API работают, затем повторите попытку. Существующие данные не удалялись.'
}
if ($stdout -notmatch 'ADMIN_PASSWORD_RESET_OK') { throw 'Сервер не подтвердил обновление пароля. Повторите проверку входа; данные не удалялись.' }
$emailMatch = [regex]::Match($stdout, '(?m)^ADMIN_ACCOUNT_EMAIL:(.+)$')
$resolvedEmail = if ($emailMatch.Success) { $emailMatch.Groups[1].Value.Trim() } else { $email }
Write-Output 'ADMIN_PASSWORD_RESET_OK'
Write-Output "ADMIN_ACCOUNT_EMAIL:$resolvedEmail"
Write-Output "Пароль обновлён для существующей учётной записи администратора: $resolvedEmail"
