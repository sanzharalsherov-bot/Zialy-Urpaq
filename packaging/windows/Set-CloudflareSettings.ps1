param(
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [Parameter(Mandatory = $true)][string]$Hostname,
  [Parameter(Mandatory = $true)][string]$TunnelToken
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $EnvFile)) { throw 'The platform environment file is missing.' }
$Hostname = $Hostname.Trim().ToLowerInvariant().TrimEnd('.')
if ($Hostname.Length -gt 253 -or $Hostname -notmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?if ($TunnelToken.Length -lt 20 -or $TunnelToken.Length -gt 4096 -or $TunnelToken -notmatch '^[A-Za-z0-9_+/=-]+$') {
  throw 'The Cloudflare Tunnel token is empty or has an invalid format.'
}

$content = [IO.File]::ReadAllText($EnvFile, [Text.Encoding]::UTF8)
function Set-EnvSetting([string]$Name, [string]$Value) {
  $pattern = '^' + [regex]::Escape($Name) + '=.*$'
  $line = $Name + '="' + $Value + '"'
  $lines = [Collections.Generic.List[string]]::new()
  $set = $false
  foreach ($existingLine in @($script:content -split '\r?\n')) {
    if ($existingLine -match $pattern) {
      if (-not $set) { $lines.Add($line); $set = $true }
    } else {
      $lines.Add($existingLine)
    }
  }
  if (-not $set) { $lines.Add($line) }
  $script:content = [string]::Join("`r`n", $lines)
}

Set-EnvSetting 'CLOUDFLARE_TUNNEL_TOKEN' $TunnelToken
Set-EnvSetting 'LIVEKIT_PUBLIC_URL' "wss://${Hostname}/livekit"
[IO.File]::WriteAllText($EnvFile, $content, [Text.UTF8Encoding]::new($false))
) {
  throw 'Enter a public hostname only, for example tests.school.kz; do not include https://, a path, or a port.'
}
if ($Hostname -match '(?i)(^|\.)duckdns\.orgif ($TunnelToken.Length -lt 20 -or $TunnelToken.Length -gt 4096 -or $TunnelToken -notmatch '^[A-Za-z0-9_+/=-]+$') {
  throw 'The Cloudflare Tunnel token is empty or has an invalid format.'
}

$content = [IO.File]::ReadAllText($EnvFile, [Text.Encoding]::UTF8)
function Set-EnvSetting([string]$Name, [string]$Value) {
  $pattern = '^' + [regex]::Escape($Name) + '=.*$'
  $line = $Name + '="' + $Value + '"'
  $lines = [Collections.Generic.List[string]]::new()
  $set = $false
  foreach ($existingLine in @($script:content -split '\r?\n')) {
    if ($existingLine -match $pattern) {
      if (-not $set) { $lines.Add($line); $set = $true }
    } else {
      $lines.Add($existingLine)
    }
  }
  if (-not $set) { $lines.Add($line) }
  $script:content = [string]::Join("`r`n", $lines)
}

Set-EnvSetting 'CLOUDFLARE_TUNNEL_TOKEN' $TunnelToken
Set-EnvSetting 'LIVEKIT_PUBLIC_URL' "wss://${Hostname}/livekit"
[IO.File]::WriteAllText($EnvFile, $content, [Text.UTF8Encoding]::new($false))
) {
  throw 'DuckDNS hostnames cannot be used as Cloudflare Public Hostnames. Cancel this setup and use DuckDNS with Caddy, or use a hostname whose DNS zone is managed by Cloudflare.'
}
if ($TunnelToken.Length -lt 20 -or $TunnelToken.Length -gt 4096 -or $TunnelToken -notmatch '^[A-Za-z0-9_+/=-]+$') {
  throw 'The Cloudflare Tunnel token is empty or has an invalid format.'
}

$content = [IO.File]::ReadAllText($EnvFile, [Text.Encoding]::UTF8)
function Set-EnvSetting([string]$Name, [string]$Value) {
  $pattern = '^' + [regex]::Escape($Name) + '=.*$'
  $line = $Name + '="' + $Value + '"'
  $lines = [Collections.Generic.List[string]]::new()
  $set = $false
  foreach ($existingLine in @($script:content -split '\r?\n')) {
    if ($existingLine -match $pattern) {
      if (-not $set) { $lines.Add($line); $set = $true }
    } else {
      $lines.Add($existingLine)
    }
  }
  if (-not $set) { $lines.Add($line) }
  $script:content = [string]::Join("`r`n", $lines)
}

Set-EnvSetting 'CLOUDFLARE_TUNNEL_TOKEN' $TunnelToken
Set-EnvSetting 'LIVEKIT_PUBLIC_URL' "wss://${Hostname}/livekit"
[IO.File]::WriteAllText($EnvFile, $content, [Text.UTF8Encoding]::new($false))
