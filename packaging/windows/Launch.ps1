$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dockerCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
  (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
)
$dockerDesktop = $dockerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $dockerDesktop) { throw 'Не найден Docker Desktop. Переустановите Docker Desktop или повторите настройку сервера.' }
$previousPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  docker info *> $null
  $dockerReady = $LASTEXITCODE -eq 0
} finally {
  $ErrorActionPreference = $previousPreference
}
if (-not $dockerReady) { Start-Process -FilePath $dockerDesktop | Out-Null }
& (Join-Path $PSScriptRoot 'Start-Server.ps1')
if ($LASTEXITCODE -ne 0) {
  Write-Error 'Docker Desktop ещё не запущен. Проверьте его значок в области уведомлений и повторите запуск.'
  exit $LASTEXITCODE
}
$envFile = Join-Path $projectDir '.env'
$portLine = Get-Content $envFile | Where-Object { $_ -match '^WEB_PORT=' } | Select-Object -First 1
$port = if ($portLine) { ($portLine -split '=', 2)[1].Trim('"') } else { '8080' }
$lanIpLine = Get-Content $envFile | Where-Object { $_ -match '^SCHOOL_LAN_IP=' } | Select-Object -First 1
$lanIp = if ($lanIpLine) { ($lanIpLine -split '=', 2)[1].Trim('"') } else { '' }
$httpsPortLine = Get-Content $envFile | Where-Object { $_ -match '^WEB_HTTPS_PORT=' } | Select-Object -First 1
$httpsPort = if ($httpsPortLine) { ($httpsPortLine -split '=', 2)[1].Trim('"') } else { '8443' }
if ($lanIp -and (Test-Path -LiteralPath (Join-Path $projectDir 'lan-root-ca.crt'))) {
  Start-Process "https://${lanIp}:$httpsPort"
} else {
  Start-Process "http://localhost:$port"
}
