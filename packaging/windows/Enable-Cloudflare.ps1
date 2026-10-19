$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envFile = Join-Path $projectDir '.env'
$composeProjectFile = Join-Path $projectDir '.compose-project'
$composeProjectName = if (Test-Path -LiteralPath $composeProjectFile) { (Get-Content -LiteralPath $composeProjectFile -Raw).Trim() } else { 'zailyurpaq' }
if ($composeProjectName -notmatch '^[a-z0-9][a-z0-9_-]{0,62}$') { throw 'Имя Docker-проекта в .compose-project некорректно.' }
if (-not (Test-Path $envFile)) { throw 'Сначала запустите платформу через установщик.' }

$secureToken = Read-Host 'Вставьте Tunnel Token из Cloudflare Zero Trust' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if ([string]::IsNullOrWhiteSpace($token)) { throw 'Cloudflare Tunnel Token не задан.' }

$content = Get-Content -Raw $envFile
if ($content -match '(?m)^CLOUDFLARE_TUNNEL_TOKEN=.*$') {
  $content = [regex]::Replace($content, '(?m)^CLOUDFLARE_TUNNEL_TOKEN=.*$', "CLOUDFLARE_TUNNEL_TOKEN=`"$token`"")
} else {
  $content += "`r`nCLOUDFLARE_TUNNEL_TOKEN=`"$token`"`r`n"
}
[IO.File]::WriteAllText($envFile, $content, [Text.UTF8Encoding]::new($false))
docker compose -p $composeProjectName -f (Join-Path $projectDir 'compose.production.yaml') --profile cloud up -d cloudflared
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить Cloudflare Tunnel.' }
Write-Host 'Tunnel запущен. В Cloudflare задайте публичный hostname и сервис http://caddy:80.'
