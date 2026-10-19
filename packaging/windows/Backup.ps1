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
docker compose -p $composeProjectName -f (Join-Path $projectDir 'compose.production.yaml') exec -T postgres pg_dump -U schoolcrm -d schoolcrm -Fc -f "/tmp/$stamp.dump"
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL не создал резервную копию.' }
docker compose -p $composeProjectName -f (Join-Path $projectDir 'compose.production.yaml') cp "postgres:/tmp/$stamp.dump" $backupFile
if ($LASTEXITCODE -ne 0) { throw 'Не удалось сохранить копию на компьютер школы.' }
docker compose -p $composeProjectName -f (Join-Path $projectDir 'compose.production.yaml') exec -T postgres rm "/tmp/$stamp.dump"
docker compose -p $composeProjectName -f (Join-Path $projectDir 'compose.production.yaml') exec -T results-postgres pg_dump -U schoolcrm -d schoolresults -Fc -f "/tmp/$stamp-results.dump"
if ($LASTEXITCODE -ne 0) { throw 'База результатов не создала резервную копию.' }
docker compose -p $composeProjectName -f (Join-Path $projectDir 'compose.production.yaml') cp "results-postgres:/tmp/$stamp-results.dump" $resultsBackupFile
if ($LASTEXITCODE -ne 0) { throw 'Не удалось сохранить копию базы результатов на компьютер школы.' }
docker compose -p $composeProjectName -f (Join-Path $projectDir 'compose.production.yaml') exec -T results-postgres rm "/tmp/$stamp-results.dump"
Write-Host "Основная база сохранена: $backupFile"
Write-Host "База результатов сохранена: $resultsBackupFile"
