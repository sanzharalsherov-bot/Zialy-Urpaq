$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backupDir = Join-Path $projectDir 'backups'
$composeProjectFile = Join-Path $projectDir '.compose-project'
$composeProjectName = if (Test-Path -LiteralPath $composeProjectFile) { (Get-Content -LiteralPath $composeProjectFile -Raw).Trim() } else { 'zailyurpaq' }
if ($composeProjectName -notmatch '^[a-z0-9][a-z0-9_-]{0,62}$') { throw 'Имя Docker-проекта в .compose-project некорректно.' }
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$composeFile = Join-Path $projectDir 'compose.production.yaml'

function Invoke-DockerChecked([string[]]$Arguments, [string]$FailureMessage, [switch]$Quiet) {
  # Docker Compose may write progress to stderr even on success. Windows PowerShell
  # 5.1 can turn native stderr into a terminating error under ErrorAction Stop.
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& docker @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if (-not $Quiet) { foreach ($line in $output) { Write-Host ([string]$line) } }
  if ($exitCode -ne 0) { throw $FailureMessage }
}

function Backup-Database(
  [string]$Container,
  [string]$Database,
  [string]$FilePath,
  [string]$RemoteDumpPath,
  [string]$FailurePrefix
) {
  $backupSucceeded = $false
  try {
    Invoke-DockerChecked @('compose', '-p', $composeProjectName, '-f', $composeFile, 'exec', '-T', $Container, 'pg_dump', '-U', 'schoolcrm', '-d', $Database, '-Fc', '-f', $RemoteDumpPath) "$FailurePrefix : PostgreSQL не создал резервную копию."
    Invoke-DockerChecked @('compose', '-p', $composeProjectName, '-f', $composeFile, 'exec', '-T', $Container, 'pg_restore', '--list', $RemoteDumpPath) "$FailurePrefix : дамп не прошёл проверку pg_restore --list." -Quiet
    Invoke-DockerChecked @('compose', '-p', $composeProjectName, '-f', $composeFile, 'cp', "${Container}:$RemoteDumpPath", $FilePath) "$FailurePrefix : не удалось скопировать дамп на компьютер школы."
    if (-not (Test-Path -LiteralPath $FilePath) -or (Get-Item -LiteralPath $FilePath).Length -le 0) {
      throw "$FailurePrefix : скопированная резервная копия отсутствует или пуста."
    }
    $backupSucceeded = $true
  } finally {
    # Temporary dumps contain school data. Always attempt cleanup, including when
    # pg_dump, validation, or docker cp fails; never hide the original exception.
    try {
      Invoke-DockerChecked @('compose', '-p', $composeProjectName, '-f', $composeFile, 'exec', '-T', $Container, 'rm', '-f', $RemoteDumpPath) 'Не удалось удалить временный дамп из контейнера.' -Quiet
    } catch {
      Write-Warning "Не удалось удалить временный файл $RemoteDumpPath из контейнера $Container. Проверьте контейнер вручную."
    }
    if (-not $backupSucceeded -and (Test-Path -LiteralPath $FilePath)) {
      Remove-Item -LiteralPath $FilePath -Force -ErrorAction SilentlyContinue
    }
  }
}

$backupFile = Join-Path $backupDir "zailyurpaq-$stamp.dump"
$resultsBackupFile = Join-Path $backupDir "zailyurpaq-results-$stamp.dump"
Backup-Database -Container 'postgres' -Database 'schoolcrm' -FilePath $backupFile -RemoteDumpPath "/tmp/$stamp.dump" -FailurePrefix 'Основная база'
Backup-Database -Container 'results-postgres' -Database 'schoolresults' -FilePath $resultsBackupFile -RemoteDumpPath "/tmp/$stamp-results.dump" -FailurePrefix 'База результатов'

$primaryHash = (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash
$resultsHash = (Get-FileHash -LiteralPath $resultsBackupFile -Algorithm SHA256).Hash
Write-Host "Основная база сохранена: $backupFile (SHA256: $primaryHash)"
Write-Host "База результатов сохранена: $resultsBackupFile (SHA256: $resultsHash)"
