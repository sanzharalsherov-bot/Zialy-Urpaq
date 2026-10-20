$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backupDir = Join-Path $projectDir 'backups'
$composeProjectFile = Join-Path $projectDir '.compose-project'
$composeProjectName = if (Test-Path -LiteralPath $composeProjectFile) { (Get-Content -LiteralPath $composeProjectFile -Raw).Trim() } else { 'zailyurpaq' }
if ($composeProjectName -notmatch '^[a-z0-9][a-z0-9_-]{0,62}$') { throw 'Имя Docker-проекта в .compose-project некорректно.' }
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupFile = Join-Path $backupDir "zailyurpaq-$stamp.dump"
$resultsBackupFile = Join-Path $backupDir "zailyurpaq-results-$stamp.dump"
$composeFile = Join-Path $projectDir 'compose.production.yaml'
$primaryContainer = 'postgres'
$resultsContainer = 'results-postgres'

function Invoke-DockerChecked([string[]]$Arguments, [string]$FailureMessage, [switch]$Quiet) {
  # Docker Compose writes progress to stderr even on success. Windows PowerShell
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

Invoke-DockerChecked @('compose', '-p', $composeProjectName, '-f', $composeFile, 'exec', '-T', $primaryContainer, 'pg_dump', '-U', 'schoolcrm', '-d', 'schoolcrm', '-Fc', '-f', "/tmp/$stamp.dump") 'PostgreSQL не создал резервную копию.'
Invoke-DockerChecked @('compose', '-p', $composeProjectName, '-f', $composeFile, 'exec', '-T', $primaryContainer, 'pg_restore', '--list', "/tmp/$stamp.dump") 'Созданный дамп основной базы не прошёл проверку pg_restore --list.' -Quiet
Invoke-DockerChecked @('compose', '-p', $composeProjectName, '-f', $composeFile, 'cp', "${primaryContainer}:/tmp/$stamp.dump", $backupFile) 'Не удалось сохранить корректную копию на компьютер школы.'
if (-not (Test-Path -LiteralPath $backupFile) -or (Get-Item -LiteralPath $backupFile).Length -le 0) { throw 'Скопированная основная резервная копия отсутствует или пуста.' }
Invoke-DockerChecked @('compose', '-p', $composeProjectName, '-f', $composeFile, 'exec', '-T', $primaryContainer, 'rm', "/tmp/$stamp.dump") 'Не удалось удалить временный дамп основной базы из контейнера.' -Quiet

Invoke-DockerChecked @('compose', '-p', $composeProjectName, '-f', $composeFile, 'exec', '-T', $resultsContainer, 'pg_dump', '-U', 'schoolcrm', '-d', 'schoolresults', '-Fc', '-f', "/tmp/$stamp-results.dump") 'База результатов не создала резервную копию.'
Invoke-DockerChecked @('compose', '-p', $composeProjectName, '-f', $composeFile, 'exec', '-T', $resultsContainer, 'pg_restore', '--list', "/tmp/$stamp-results.dump") 'Созданный дамп базы результатов не прошёл проверку pg_restore --list.' -Quiet
Invoke-DockerChecked @('compose', '-p', $composeProjectName, '-f', $composeFile, 'cp', "${resultsContainer}:/tmp/$stamp-results.dump", $resultsBackupFile) 'Не удалось сохранить корректную копию базы результатов на компьютер школы.'
if (-not (Test-Path -LiteralPath $resultsBackupFile) -or (Get-Item -LiteralPath $resultsBackupFile).Length -le 0) { throw 'Скопированная резервная копия результатов отсутствует или пуста.' }
Invoke-DockerChecked @('compose', '-p', $composeProjectName, '-f', $composeFile, 'exec', '-T', $resultsContainer, 'rm', "/tmp/$stamp-results.dump") 'Не удалось удалить временный дамп базы результатов из контейнера.' -Quiet

$primaryHash = (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash
$resultsHash = (Get-FileHash -LiteralPath $resultsBackupFile -Algorithm SHA256).Hash
Write-Host "Основная база сохранена: $backupFile (SHA256: $primaryHash)"
Write-Host "База результатов сохранена: $resultsBackupFile (SHA256: $resultsHash)"
