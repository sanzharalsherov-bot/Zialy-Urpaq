$ErrorActionPreference = 'Stop'
$encodedConfig = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($encodedConfig)) { throw 'Токен Cloudflare не задан.' }
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedConfig)) | ConvertFrom-Json
$token = [string]$config.token
$hostname = [string]$config.hostname

$projectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envFile = Join-Path $projectDir '.env'
$composeFile = Join-Path $projectDir 'compose.production.yaml'
$composeProjectFile = Join-Path $projectDir '.compose-project'
if (-not (Test-Path -LiteralPath $envFile) -or -not (Test-Path -LiteralPath $composeFile)) { throw 'Установка Zaily Urpaq не найдена. Сначала установите платформу.' }
$composeProjectName = if (Test-Path -LiteralPath $composeProjectFile) { (Get-Content -LiteralPath $composeProjectFile -Raw).Trim() } else { 'zailyurpaq' }
if ($composeProjectName -notmatch '^[a-z0-9][a-z0-9_-]{0,62}$') { throw 'Имя Docker-проекта некорректно.' }

& (Join-Path $PSScriptRoot 'Set-CloudflareSettings.ps1') -EnvFile $envFile -Hostname $hostname -TunnelToken $token

$dockerCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'),
  (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe')
)
$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
if ($dockerCommand) { $dockerCandidates += $dockerCommand.Source }
$dockerExe = $dockerCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $dockerExe) { throw 'Docker Desktop CLI не найден. Запустите платформу через ярлык и повторите попытку.' }

$previousPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  $result = @(& $dockerExe compose --profile cloud -p $composeProjectName -f $composeFile up -d cloudflared 2>&1)
  $exitCode = $LASTEXITCODE
} finally { $ErrorActionPreference = $previousPreference }
foreach ($line in $result) { Write-Output ([string]$line) }
if ($exitCode -ne 0) { throw 'Docker Compose не смог запустить Cloudflare Tunnel. Проверьте, что сервер запущен и Docker Desktop готов.' }

$publicAddressReady = $false
for ($attempt = 0; $attempt -lt 8; $attempt++) {
  try {
    $response = Invoke-WebRequest -Uri "https://${hostname}/api/health" -UseBasicParsing -MaximumRedirection 3 -TimeoutSec 5
    $health = $response.Content | ConvertFrom-Json
    if ([int]$response.StatusCode -eq 200 -and
        $health.status -eq 'ok' -and
        $health.database -eq 'connected' -and
        $health.service -eq 'school-crm-api') {
      $livekit = Invoke-WebRequest -Uri "https://${hostname}/livekit/" -UseBasicParsing -MaximumRedirection 3 -TimeoutSec 5
      if ([int]$livekit.StatusCode -eq 200 -and $livekit.Content.Trim() -eq 'OK') {
        $publicAddressReady = $true
        break
      }
    }
  } catch { }
  Start-Sleep -Seconds 3
}

if ($publicAddressReady) {
  Write-Output "PUBLIC_HEALTH_OK: https://${hostname}/api/health and /livekit/ returned the expected platform responses."
  Write-Output 'HTTPS API and LiveKit proxy verified. WebSocket and media still need verification from a device on the school LAN.'
} else {
  Write-Output "PUBLIC_HEALTH_PENDING: The tunnel process started, but https://${hostname}/api/health and /livekit/ did not return the expected platform responses. Check the Cloudflare Tunnel state and its Public Hostname service http://caddy:80."
  Write-Output 'Do not treat public access as ready until the address returns the platform health response.'
}
