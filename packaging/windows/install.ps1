$ErrorActionPreference = 'Stop'

$setupJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$setupConfig = $setupJson | ConvertFrom-Json
$installDir = [IO.Path]::GetFullPath([string]$setupConfig.installDir)
$email = ([string]$setupConfig.email).Trim()
$firstName = ([string]$setupConfig.firstName).Trim()
$lastName = ([string]$setupConfig.lastName).Trim()
$password = [string]$setupConfig.password
$studentAccessCode = [string]$setupConfig.studentAccessCode
$resetSchoolData = [bool]$setupConfig.resetSchoolData
$cloudflareEnabled = [bool]$setupConfig.configureCloudflare
$cloudflareHostname = ([string]$setupConfig.cloudflareHostname).Trim()
$cloudflareToken = ([string]$setupConfig.cloudflareToken).Trim()

function Write-InstallStatus([string]$Message) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Message))
  [Console]::Out.WriteLine(('STATUS64:' + $encoded))
  [Console]::Out.Flush()
}

function Write-InstallAddress([string]$Address) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Address))
  [Console]::Out.WriteLine(('ADDRESS64:' + $encoded))
  [Console]::Out.Flush()
}

function New-RandomSecret([int]$byteCount = 48) {
  $bytes = [byte[]]::new($byteCount)
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# Windows PowerShell 5.1 promotes stderr from native programs (including Docker)
# to terminating NativeCommandError records when ErrorActionPreference is Stop.
# Optional probes must therefore run under Continue so a missing container or a
# Docker daemon that is still starting does not abort the installer.
function Invoke-DockerProbe([string]$DockerExe, [string[]]$Arguments) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $result = @(& $DockerExe @Arguments 2>$null)
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{ Output = $result; ExitCode = $exitCode }
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Invoke-DockerCommand([string[]]$Arguments) {
  $previousPreference = $ErrorActionPreference
  try {
    # Docker Compose reports normal progress on stderr. Keep that stream from
    # becoming a terminating NativeCommandError under Windows PowerShell 5.1.
    $ErrorActionPreference = 'Continue'
    $output = @(& $dockerCli @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  foreach ($line in $output) { Write-Host ([string]$line) }
  return [pscustomobject]@{ Output = $output; ExitCode = $exitCode }
}

function Set-DatabaseRolePassword([string]$ContainerName, [string]$DatabaseName, [string]$DesiredPassword) {
  # The official PostgreSQL image allows local socket access inside the
  # container. Feed SQL over stdin so this generated secret is not added to
  # Docker's process command line or installer logs.
  $escapedPassword = $DesiredPassword.Replace("'", "''")
  $sql = "ALTER ROLE schoolcrm WITH PASSWORD '$escapedPassword';"
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $dockerCli
  $startInfo.Arguments = "exec -i -u postgres $ContainerName psql -v ON_ERROR_STOP=1 -U schoolcrm -d $DatabaseName"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'Не удалось проверить учётные данные базы PostgreSQL.' }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.StandardInput.WriteLine($sql)
  $process.StandardInput.Close()
  $process.WaitForExit()
  $stdout = $stdoutTask.Result.Trim()
  $stderr = $stderrTask.Result.Trim()
  $exitCode = $process.ExitCode
  $process.Dispose()
  if ($exitCode -ne 0) {
    $detail = if ($stderr) { " Диагностика: $stderr" } else { '' }
    throw "Не удалось синхронизировать пароль базы с защищённой конфигурацией.$detail"
  }
}

function Clear-DatabaseContents([string]$ContainerName, [string]$DatabaseName) {
  $sql = @'
DO $$
DECLARE public_tables TEXT;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
  INTO public_tables
  FROM pg_tables
  WHERE schemaname = 'public' AND tablename <> '_prisma_migrations';
  IF public_tables IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || public_tables || ' RESTART IDENTITY CASCADE';
  END IF;
END $$;
'@
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $dockerCli
  $startInfo.Arguments = "exec -i -u postgres $ContainerName psql -v ON_ERROR_STOP=1 -U schoolcrm -d $DatabaseName"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw "Не удалось запустить очистку школьной базы $DatabaseName." }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.WriteLine($sql)
    $process.StandardInput.Close()
    $process.WaitForExit()
    $stderr = $stderrTask.Result.Trim()
    if ($process.ExitCode -ne 0) {
      $detail = if ($stderr) { " Диагностика: $stderr" } else { '' }
      throw "Не удалось очистить базу $DatabaseName.$detail"
    }
  } finally { $process.Dispose() }
}

try {
Write-Host ''
Write-Host 'Установщик Zaily Urpaq' -ForegroundColor Magenta
Write-Host 'Будет настроен один сервер школы и общая база для учеников и учителей.'
Write-Host ''
Write-InstallStatus 'Проверяю систему и Docker Desktop…'

$os = Get-CimInstance Win32_OperatingSystem
$osCaption = [string]$os.Caption
$osBuild = [int]$os.BuildNumber
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Для Docker Desktop требуется 64-разрядная Windows.' }
if ($osCaption -match 'Windows 10' -and $osBuild -lt 19045) {
  throw 'Для Windows 10 требуется версия 22H2 (сборка 19045) и WSL 2. На более ранней версии Docker Desktop установить нельзя.'
}
if ($osCaption -match 'Windows 10') {
  Write-Host 'Внимание: стандартная поддержка Windows 10 завершилась. Убедитесь, что этому выпуску всё ещё предоставляются обновления безопасности (например, через действующую программу расширенных обновлений).' -ForegroundColor Yellow
  Write-InstallStatus 'Проверка Windows 10: требуется действующая поддержка обновлений безопасности.'
}
if ($osCaption -match 'Windows 11' -and $osBuild -lt 22631) {
  throw 'Для Windows 11 требуется версия 23H2 (сборка 22631) или новее и WSL 2.'
}
if ($osCaption -notmatch 'Windows 10|Windows 11') { throw 'Поддерживаются Windows 10 22H2 и Windows 11 23H2 или новее.' }

function Resolve-DockerCli {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'),
    (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe')
  )
  $fromPath = Get-Command docker.exe -ErrorAction SilentlyContinue
  if ($fromPath) { $candidates += $fromPath.Source }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Start-DockerDesktop {
  $dockerExe = Resolve-DockerCli
  $desktopCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
  )
  $desktopExe = $desktopCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

  if (-not $dockerExe) {
    if ([Environment]::Is64BitOperatingSystem -eq $false) { throw 'Docker Desktop требует 64-разрядную Windows.' }
    Write-Host 'Docker Desktop не найден. Скачаю официальный установщик Docker для Windows.' -ForegroundColor Cyan
    Write-InstallStatus 'Скачиваю официальный Docker Desktop…'
    $installerPath = Join-Path $env:TEMP 'DockerDesktopInstaller.exe'
    $downloadUrl = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $downloadUrl -OutFile $installerPath -UseBasicParsing
    $signature = Get-AuthenticodeSignature -FilePath $installerPath
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Docker') {
      Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
      throw 'Проверка цифровой подписи установщика Docker не прошла. Установка отменена.'
    }
    Write-Host 'Запускаю установку Docker Desktop. В окне Docker примите лицензионное соглашение, чтобы продолжить.' -ForegroundColor Yellow
    Write-InstallStatus 'Устанавливаю Docker Desktop…'
    $dockerInstall = Start-Process -FilePath $installerPath -ArgumentList @('install', '--user') -Wait -PassThru
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
    if ($dockerInstall.ExitCode -ne 0) { throw "Установщик Docker завершился с кодом $($dockerInstall.ExitCode). Проверьте сообщение Docker и запустите установщик Zaily Urpaq повторно." }
    $dockerExe = Resolve-DockerCli
    $desktopExe = $desktopCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }

  if (-not $dockerExe) { throw 'Docker Desktop установлен, но docker.exe не найден. Перезагрузите Windows и запустите установщик Zaily Urpaq повторно.' }
  $dockerBin = Split-Path -Parent $dockerExe
  if (($env:PATH -split ';') -notcontains $dockerBin) { $env:PATH = "$dockerBin;$env:PATH" }

  if ($desktopExe) { Start-Process -FilePath $desktopExe | Out-Null }
  Write-InstallStatus 'Запускаю Docker Desktop. Если появится его окно, примите лицензионное соглашение…'
  Write-Host 'Жду запуска Docker Desktop. При первом запуске примите соглашение Docker в появившемся окне.' -ForegroundColor Cyan
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    $probe = Invoke-DockerProbe -DockerExe $dockerExe -Arguments @('info')
    if ($probe.ExitCode -eq 0) { return $dockerExe }
    Start-Sleep -Seconds 5
  }
  throw 'Docker Desktop не запустился за 10 минут. Если Windows попросила перезагрузку для WSL 2 — перезагрузите компьютер и снова откройте ZailyUrpaqSetup.exe. Если показано лицензионное окно Docker, примите условия и повторите установку.'
}

$dockerCli = Start-DockerDesktop
& $dockerCli compose version
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose недоступен после запуска Docker Desktop.' }

$installDir = [IO.Path]::GetFullPath($installDir)
Write-InstallStatus 'Подготавливаю файлы платформы…'
$zipPath = Join-Path $PSScriptRoot 'deployment.zip'
if (-not (Test-Path $zipPath)) { throw 'Не найден пакет проекта рядом с установщиком.' }
$stageDir = Join-Path $env:TEMP ('zailyurpaq-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
try {
  Expand-Archive -LiteralPath $zipPath -DestinationPath $stageDir -Force
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Copy-Item -Path (Join-Path $stageDir '*') -Destination $installDir -Recurse -Force
} finally {
  Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
}
$launcherExe = Join-Path $installDir 'ZailyUrpaq.exe'
if ($env:ZAILY_INSTALLER_EXE -and (Test-Path -LiteralPath $env:ZAILY_INSTALLER_EXE)) {
  Copy-Item -LiteralPath $env:ZAILY_INSTALLER_EXE -Destination $launcherExe -Force
}

$envFile = Join-Path $installDir '.env'
$setupComplete = Join-Path $installDir '.setup-complete'
$composeProjectFile = Join-Path $installDir '.compose-project'
$composeProjectName = $null
if (Test-Path -LiteralPath $composeProjectFile) {
  $savedProjectName = (Get-Content -LiteralPath $composeProjectFile -Raw).Trim()
  if ($savedProjectName -match '^[a-z0-9][a-z0-9_-]{0,62}$') { $composeProjectName = $savedProjectName }
}
if (-not $composeProjectName) {
  $legacyProbe = Invoke-DockerProbe -DockerExe $dockerCli -Arguments @('inspect', 'zailyurpaq-postgres-1', '--format', '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')
  $legacyProjectDir = $legacyProbe.Output | Select-Object -First 1
  if ($legacyProbe.ExitCode -eq 0 -and $legacyProjectDir) {
    try {
      if ([IO.Path]::GetFullPath($legacyProjectDir.Trim()).TrimEnd('\') -ieq $installDir.TrimEnd('\')) { $composeProjectName = 'zailyurpaq' }
    } catch {}
  }
  if (-not $composeProjectName -and (Test-Path -LiteralPath $setupComplete)) { $composeProjectName = 'zailyurpaq' }
  if (-not $composeProjectName) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($installDir.ToLowerInvariant()))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $composeProjectName = 'zailyurpaq-' + $hash.Substring(0, 10)
  }
  [IO.File]::WriteAllText($composeProjectFile, $composeProjectName, [Text.UTF8Encoding]::new($false))
}
$freshInstall = -not (Test-Path $envFile)
if ($freshInstall) {
  Write-InstallStatus 'Создаю защищённую конфигурацию сервера…'
  $dbPassword = New-RandomSecret 36
  $jwtSecret = New-RandomSecret 48
  $bootstrapKey = New-RandomSecret 36
  $liveKitKey = 'lk_' + (New-RandomSecret 18)
  $liveKitSecret = New-RandomSecret 48
  $serverAddress = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object { $_ -and $_ -notlike '127.*' } | Select-Object -First 1
  if (-not $serverAddress) { $serverAddress = '127.0.0.1' }
  $envText = @"
POSTGRES_PASSWORD="$dbPassword"
DATABASE_URL="postgresql://schoolcrm:$dbPassword@postgres:5432/schoolcrm?schema=public"
JWT_SECRET="$jwtSecret"
BOOTSTRAP_ADMIN_KEY="$bootstrapKey"
WEB_PORT="8080"
WEB_HTTPS_PORT="8443"
SCHOOL_LAN_IP="$serverAddress"
CLOUDFLARE_TUNNEL_TOKEN=""
LIVEKIT_API_KEY="$liveKitKey"
LIVEKIT_API_SECRET="$liveKitSecret"
LIVEKIT_PUBLIC_URL="wss://${serverAddress}:8443/livekit"
LIVEKIT_NODE_IP="$serverAddress"
"@
  [IO.File]::WriteAllText($envFile, $envText, [Text.UTF8Encoding]::new($false))
}
& (Join-Path $installDir 'packaging\windows\Ensure-MediaConfig.ps1') -EnvFile $envFile
$dbPasswordLine = Get-Content $envFile | Where-Object { $_ -match '^POSTGRES_PASSWORD=' } | Select-Object -First 1
if (-not $dbPasswordLine) { throw 'В защищённой конфигурации отсутствует пароль базы PostgreSQL.' }
$dbPassword = ($dbPasswordLine -split '=', 2)[1].Trim().Trim('"')
if (-not $dbPassword -or $dbPassword -notmatch '^[A-Za-z0-9_-]+$') { throw 'Формат пароля базы PostgreSQL некорректен. Существующие данные не изменены.' }
if (-not (Select-String -Path $envFile -Pattern '^BOOTSTRAP_ADMIN_KEY=' -Quiet)) {
  Add-Content -Path $envFile -Value ("BOOTSTRAP_ADMIN_KEY=`"$(New-RandomSecret 36)`"")
}
$bootstrapLine = Get-Content $envFile | Where-Object { $_ -match '^BOOTSTRAP_ADMIN_KEY=' } | Select-Object -First 1
$bootstrapKey = ($bootstrapLine -split '=', 2)[1].Trim().Trim('"')
if ($resetSchoolData -or -not $bootstrapKey) {
  $bootstrapKey = New-RandomSecret 36
  $envContent = [IO.File]::ReadAllText($envFile)
  if ($envContent -match '(?m)^BOOTSTRAP_ADMIN_KEY=') {
    $envContent = [regex]::Replace($envContent, '(?m)^BOOTSTRAP_ADMIN_KEY=.*$', ('BOOTSTRAP_ADMIN_KEY="' + $bootstrapKey + '"'))
  } else {
    $envContent += "`r`nBOOTSTRAP_ADMIN_KEY=`"$bootstrapKey`"`r`n"
  }
  [IO.File]::WriteAllText($envFile, $envContent, [Text.UTF8Encoding]::new($false))
}
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $envFile /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "*$($userSid):F" *> $null
if ($cloudflareEnabled) {
  Write-InstallStatus 'Настраиваю Cloudflare Tunnel в конфигурации сервера…'
  & (Join-Path $installDir 'packaging\windows\Set-CloudflareSettings.ps1') -EnvFile $envFile -Hostname $cloudflareHostname -TunnelToken $cloudflareToken
  $cloudflareHostname = $cloudflareHostname.Trim().ToLowerInvariant().TrimEnd('.')
}

function Assert-LiveKitPortsAvailable {
  # A different Docker Compose project may already publish LiveKit's fixed host
  # ports. Detect that before building/starting the stack, without stopping or
  # deleting any existing containers or their persistent data.
  foreach ($port in @(7881, 7882)) {
    $containersProbe = Invoke-DockerProbe -DockerExe $dockerCli -Arguments @('ps', '--filter', "publish=$port", '--format', '{{.Names}}')
    if ($containersProbe.ExitCode -ne 0) { throw 'Не удалось проверить занятость портов Docker. Перезапустите Docker Desktop и повторите установку.' }
    foreach ($containerName in @($containersProbe.Output | Where-Object { $_ })) {
      $ownerProbe = Invoke-DockerProbe -DockerExe $dockerCli -Arguments @('inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', [string]$containerName)
      $ownerProject = [string]($ownerProbe.Output | Select-Object -First 1)
      if ($ownerProbe.ExitCode -eq 0 -and $ownerProject -and $ownerProject -ne $composeProjectName) {
        throw "Порт LiveKit $port уже занят контейнером '$containerName' из Docker-проекта '$ownerProject'. Установка остановлена до запуска остальных сервисов. Откройте Docker Desktop, найдите старый/дублирующий проект и штатно остановите его, если он больше не нужен. Не удаляйте volumes и не выполняйте docker compose down -v: там могут храниться данные школы."
      }
    }
  }
}

Assert-LiveKitPortsAvailable

Write-Host ''
Write-Host 'Собираю и запускаю приложение. При первом запуске Docker скачает зависимости; это может занять несколько минут.' -ForegroundColor Cyan
Write-InstallStatus 'Скачиваю компоненты и запускаю платформу. Это может занять несколько минут…'
$composePath = Join-Path $installDir 'compose.production.yaml'
$databaseStart = Invoke-DockerCommand @('compose', '-p', $composeProjectName, '-f', $composePath, 'up', '-d', 'postgres', 'results-postgres')
if ($databaseStart.ExitCode -ne 0) { throw "Не удалось запустить базу PostgreSQL. Диагностика: docker compose -p $composeProjectName -f compose.production.yaml logs postgres." }

Write-InstallStatus 'Проверяю подключение к сохранённой базе…'
$postgresContainer = "$composeProjectName-postgres-1"
$databaseReady = $false
$databaseError = ''
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try {
    Set-DatabaseRolePassword -ContainerName $postgresContainer -DatabaseName 'schoolcrm' -DesiredPassword $dbPassword
    $databaseReady = $true
    break
  } catch {
    $databaseError = [string]$_.Exception.Message
    Start-Sleep -Seconds 2
  }
}
if (-not $databaseReady) { throw "PostgreSQL запустился, но API не удаётся подключить к базе. $databaseError Данные в томе сохранены." }

# The results database has its own persistent volume. Keep its role password
# synchronized as well when an existing installation is updated/reconfigured.
$resultsContainer = "$composeProjectName-results-postgres-1"
$resultsDatabaseReady = $false
$resultsDatabaseError = ''
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try {
    Set-DatabaseRolePassword -ContainerName $resultsContainer -DatabaseName 'schoolresults' -DesiredPassword $dbPassword
    $resultsDatabaseReady = $true
    break
  } catch {
    $resultsDatabaseError = [string]$_.Exception.Message
    Start-Sleep -Seconds 2
  }
}
if (-not $resultsDatabaseReady) {
  throw "База результатов запустилась, но пароль не удалось синхронизировать. $resultsDatabaseError Данные в томе сохранены."
}

if ($resetSchoolData -or -not (Test-Path $setupComplete)) {
  Write-InstallStatus 'Подготавливаю пустую школьную базу…'
  $stopApi = Invoke-DockerCommand @('compose', '-p', $composeProjectName, '-f', $composePath, 'stop', 'api')
  if ($stopApi.ExitCode -ne 0) { throw 'Не удалось остановить API перед очисткой. Данные не изменены; повторите установку.' }
  Clear-DatabaseContents -ContainerName $postgresContainer -DatabaseName 'schoolcrm'
  Clear-DatabaseContents -ContainerName $resultsContainer -DatabaseName 'schoolresults'
  Write-Host 'Школьные аккаунты, задания, результаты и настройки очищены. Схемы и миграции сохранены.' -ForegroundColor Yellow
}

$stackArguments = @('compose', '--profile', 'media')
if ($cloudflareEnabled) { $stackArguments += @('--profile', 'cloud') }
$stackArguments += @('-p', $composeProjectName, '-f', $composePath, 'up', '-d', '--build')
$stackStart = Invoke-DockerCommand $stackArguments
if ($stackStart.ExitCode -ne 0) { throw "Сборка или запуск завершились ошибкой. Диагностика: docker compose -p $composeProjectName -f compose.production.yaml logs." }

if ($resetSchoolData -or -not (Test-Path $setupComplete)) {
  Write-InstallStatus 'Ожидаю готовности платформы…'
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 3
      if ($health.status -eq 'ok') { $ready = $true; break }
    } catch { Start-Sleep -Seconds 3 }
  }
  if (-not $ready) { throw 'Сервер не ответил после запуска. Проверьте логи через docker compose.' }

  $userCountProbe = Invoke-DockerProbe -DockerExe $dockerCli -Arguments @('exec', '-u', 'postgres', $postgresContainer, 'psql', '-U', 'schoolcrm', '-d', 'schoolcrm', '-Atc', 'SELECT count(*) FROM "User"')
  if ($userCountProbe.ExitCode -ne 0) { throw 'Не удалось проверить пустую базу перед созданием администратора. Очистка уже могла выполниться; повторите установку и проверьте подключение к PostgreSQL.' }
  $userCountText = [string]($userCountProbe.Output | Select-Object -First 1)
  $existingUserCount = 0
  if (-not [int]::TryParse($userCountText.Trim(), [ref]$existingUserCount)) { throw 'База вернула некорректный результат проверки аккаунтов.' }

  if ($existingUserCount -gt 0) {
    throw "После очистки в базе всё ещё есть аккаунты ($existingUserCount). Первоначальный администратор не создан; проверьте подключение к базе."
  } else {
    if ($password.Length -lt 12) { throw 'Пароль должен содержать не менее 12 символов. Повторно запустите установщик; запущенные данные сохранятся.' }
    if (-not $bootstrapKey) { throw 'Первый администратор ещё не создан, а ключ настройки уже отключён. Данные сохранены; обратитесь к администратору платформы.' }
    $body = @{
      email = $email; firstName = $firstName; lastName = $lastName
      password = $password; bootstrapKey = $bootstrapKey; studentAccessCode = $studentAccessCode
    } | ConvertTo-Json
    Write-InstallStatus 'Создаю учётную запись администратора…'
    Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/auth/bootstrap-admin' -Method Post -ContentType 'application/json' -Body $body | Out-Null
    Write-Host 'Первый администратор создан.' -ForegroundColor Green
  }
  $envContent = [IO.File]::ReadAllText($envFile)
  $envContent = [regex]::Replace($envContent, '(?m)^BOOTSTRAP_ADMIN_KEY=.*$', 'BOOTSTRAP_ADMIN_KEY=""')
  [IO.File]::WriteAllText($envFile, $envContent, [Text.UTF8Encoding]::new($false))
  $apiRestart = Invoke-DockerCommand @('compose', '-p', $composeProjectName, '-f', $composePath, 'up', '-d', '--force-recreate', 'api')
  if ($apiRestart.ExitCode -ne 0) { throw 'Учётная запись сохранена, но API не удалось перезапустить после отключения первоначального ключа.' }
  $apiReady = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 3
      if ($health.status -eq 'ok') { $apiReady = $true; break }
    } catch { Start-Sleep -Seconds 2 }
  }
  if (-not $apiReady) { throw 'Администратор создан, но API не восстановился после перезапуска. Проверьте логи Docker Compose.' }
  Set-Content -Path $setupComplete -Value 'completed' -NoNewline
}

if ($cloudflareEnabled) {
  Write-InstallStatus 'Проверяю публичный HTTPS-адрес Cloudflare…'
  $publicAddressReady = $false
  for ($attempt = 0; $attempt -lt 12; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "https://${cloudflareHostname}/api/health" -TimeoutSec 5
      if ($health.status -eq 'ok' -and $health.database -eq 'connected' -and $health.service -eq 'school-crm-api') {
        $liveKit = Invoke-WebRequest -Uri "https://${cloudflareHostname}/livekit/" -UseBasicParsing -TimeoutSec 5
        if ($liveKit.StatusCode -eq 200 -and $liveKit.Content.Trim() -eq 'OK') { $publicAddressReady = $true; break }
      }
    } catch { }
    Start-Sleep -Seconds 3
  }
  if ($publicAddressReady) {
    Write-InstallAddress "Публичный адрес: https://${cloudflareHostname}"
    Write-Host 'PUBLIC_HEALTH_OK'
  } else {
    [Console]::Out.WriteLine('CLOUDFLARE_HEALTH_PENDING')
    Write-Host 'Платформа работает в школьной сети, но публичный адрес Cloudflare пока не прошёл проверку. Проверьте Tunnel Token и Public Hostname в Cloudflare.' -ForegroundColor Yellow
  }
}

Write-InstallStatus 'Завершаю настройку сервера…'
$lanCertificateFile = Join-Path $installDir 'lan-root-ca.crt'
$certificateExport = Invoke-DockerCommand @('cp', "${composeProjectName}-caddy-1:/data/caddy/pki/authorities/local/root.crt", $lanCertificateFile)
if ($certificateExport.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $lanCertificateFile)) {
  throw 'Не удалось сохранить корневой сертификат локального HTTPS. Проверьте логи Caddy и повторите установку.'
}
# Import the Caddy local root without launching certificate/UI prompts from the hidden
# non-interactive PowerShell worker. If policy blocks trust-store writes, keep the
# platform running and report exactly how to trust the saved public root certificate.
$certificateTrustPending = $false
$rootCertificate = $null
$rootStore = $null
try {
  $rootCertificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $lanCertificateFile
  $caExtension = $rootCertificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' } | Select-Object -First 1
  if (-not $caExtension) { throw 'The saved certificate has no CA basic-constraints extension.' }
  $basicConstraints = New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension -ArgumentList $caExtension, $false
  if (-not $basicConstraints.CertificateAuthority) { throw 'The saved certificate is not a CA certificate.' }

  $rootStore = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    [System.Security.Cryptography.X509Certificates.StoreName]::Root,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
  )
  $rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  $alreadyTrusted = $false
  foreach ($storedCertificate in $rootStore.Certificates) {
    if ($storedCertificate.Thumbprint -eq $rootCertificate.Thumbprint) {
      $alreadyTrusted = $true
      break
    }
  }
  if (-not $alreadyTrusted) { $rootStore.Add($rootCertificate) }
  $trustVerified = $false
  foreach ($storedCertificate in $rootStore.Certificates) {
    if ($storedCertificate.Thumbprint -eq $rootCertificate.Thumbprint) {
      $trustVerified = $true
      break
    }
  }
  if (-not $trustVerified) { throw 'Windows did not confirm the root certificate in the CurrentUser Root store.' }
  Write-Host 'Корневой HTTPS-сертификат добавлен в доверенные сертификаты текущего пользователя Windows.' -ForegroundColor Green
} catch {
  $certificateTrustPending = $true
  Write-Host 'CERTIFICATE_TRUST_PENDING'
  Write-Host 'Предупреждение: Windows не разрешила автоматически добавить корневой HTTPS-сертификат. Сервер и база уже запущены, установка продолжится.' -ForegroundColor Yellow
  Write-Host "Файл сертификата сохранён: $lanCertificateFile" -ForegroundColor Yellow
  Write-Host 'Для доверенного HTTPS попросите администратора установить этот сертификат в хранилище «Доверенные корневые центры сертификации» текущего пользователя Windows. На других школьных устройствах доверие также настраивается отдельно.' -ForegroundColor Yellow
} finally {
  if ($rootStore) { try { $rootStore.Close(); $rootStore.Dispose() } catch {} }
  if ($rootCertificate) { $rootCertificate.Dispose() }
}
try {
  # Remove the legacy LAN-wide HTTP rule from older installations.
  Remove-NetFirewallRule -DisplayName 'Zaily Urpaq School Platform' -ErrorAction SilentlyContinue
  $schoolFirewallRules = @(
    @{ DisplayName = 'Zaily Urpaq School HTTPS'; Protocol = 'TCP'; LocalPort = 8443 },
    @{ DisplayName = 'Zaily Urpaq LiveKit TCP'; Protocol = 'TCP'; LocalPort = 7881 },
    @{ DisplayName = 'Zaily Urpaq LiveKit UDP'; Protocol = 'UDP'; LocalPort = 7882 }
  )
  foreach ($rule in $schoolFirewallRules) {
    if (-not (Get-NetFirewallRule -DisplayName $rule.DisplayName -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $rule.DisplayName -Direction Inbound -Action Allow -Protocol $rule.Protocol -LocalPort $rule.LocalPort -RemoteAddress LocalSubnet -Profile Private | Out-Null
    }
  }
} catch {
  Write-Host 'Не удалось создать правила брандмауэра для сайта/LiveKit. Доступ с других компьютеров может потребовать ручной настройки Windows Firewall.' -ForegroundColor Yellow
}

$shell = New-Object -ComObject WScript.Shell
if ([bool]$setupConfig.createDesktopShortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shortcut = $shell.CreateShortcut((Join-Path $desktop 'Zaily Urpaq.lnk'))
  if (-not (Test-Path -LiteralPath $launcherExe)) { throw 'Не удалось подготовить приложение запуска. Повторно соберите установщик и запустите установку снова.' }
  $shortcut.TargetPath = $launcherExe
  $shortcut.Arguments = '--launch'
  $shortcut.WorkingDirectory = $installDir
  $shortcut.IconLocation = "$launcherExe,0"
  $shortcut.Save()

}
$cloudflareShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Zaily Urpaq - Cloudflare.lnk'
Remove-Item -LiteralPath $cloudflareShortcutPath -Force -ErrorAction SilentlyContinue

$startupDir = [Environment]::GetFolderPath('Startup')
$dockerDesktopPath = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
  (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($dockerDesktopPath) {
  $dockerStartupShortcut = $shell.CreateShortcut((Join-Path $startupDir 'Docker Desktop.lnk'))
  $dockerStartupShortcut.TargetPath = $dockerDesktopPath
  $dockerStartupShortcut.Save()
}
$startupShortcut = $shell.CreateShortcut((Join-Path $startupDir 'Zaily Urpaq Server.lnk'))
$startupShortcut.TargetPath = (Join-Path $PSHOME 'powershell.exe')
$startupShortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $installDir 'packaging\windows\Start-Server.ps1') + '"'
$startupShortcut.WorkingDirectory = $installDir
$startupShortcut.Save()

$addresses = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object { $_ -and $_ -notlike '127.*' }
Write-Host ''
Write-Host 'Установка завершена.' -ForegroundColor Green
Write-InstallAddress 'На сервере: http://localhost:8080'
foreach ($address in $addresses) { Write-InstallAddress "В школьной сети: https://${address}:8443" }
Write-Host 'Для HTTPS на каждом устройстве школы необходимо доверять корневому сертификату этого сервера (см. packaging\windows\README.md).'
Write-Host 'Docker Desktop настроен на автоматический запуск при входе пользователя Windows.'
if ($cloudflareEnabled -and $publicAddressReady) { Write-Host "Публичный HTTPS-адрес: https://${cloudflareHostname}" }
Write-Host 'Резервную копию базы создаёт packaging\windows\Backup.ps1.'
Start-Process 'http://localhost:8080'
Write-InstallStatus 'Установка завершена. Платформа открывается в браузере.'
} catch {
  $errorText = [string]$_.Exception.Message
  $encodedError = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($errorText))
  [Console]::Out.WriteLine(('ERROR64:' + $encodedError))
  [Console]::Out.Flush()
  exit 1
}
