$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$composeFile = Join-Path $projectDir 'compose.production.yaml'
$composeProjectFile = Join-Path $projectDir '.compose-project'
$composeProjectName = if (Test-Path -LiteralPath $composeProjectFile) { (Get-Content -LiteralPath $composeProjectFile -Raw).Trim() } else { 'zailyurpaq' }
if ($composeProjectName -notmatch '^[a-z0-9][a-z0-9_-]{0,62}$') { throw 'Имя Docker-проекта в .compose-project некорректно.' }
$logFile = Join-Path $projectDir 'logs\startup.log'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFile) | Out-Null
& (Join-Path $PSScriptRoot 'Ensure-MediaConfig.ps1') -EnvFile (Join-Path $projectDir '.env')

$dockerDesktopCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
  (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
)
$dockerDesktop = $dockerDesktopCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

function Test-DockerDaemon {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    docker info *> $null
    return ($LASTEXITCODE -eq 0)
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

if (-not (Test-DockerDaemon) -and $dockerDesktop) { Start-Process -FilePath $dockerDesktop | Out-Null }

$dockerReady = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  if (Test-DockerDaemon) { $dockerReady = $true; break }
  Start-Sleep -Seconds 10
}
if (-not $dockerReady) {
  Add-Content -Path $logFile -Value "[$(Get-Date -Format s)] Docker Desktop is not ready."
  exit 1
}

$previousPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  $composeOutput = @(docker compose --profile media -p $composeProjectName -f $composeFile up -d 2>&1)
  $composeExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousPreference
}
$composeOutput | Add-Content -Path $logFile
if ($composeExitCode -ne 0) { exit $composeExitCode }
