param(
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [string]$LanIp
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $EnvFile)) { throw 'The platform environment file is missing.' }

if (-not $LanIp) {
  $LanIp = Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway } |
    ForEach-Object { $_.IPv4Address.IPAddress } |
    Where-Object { $_ -and $_ -notlike '127.*' } |
    Select-Object -First 1
}
if (-not $LanIp) { $LanIp = '127.0.0.1' }
$parsedIp = $null
if (-not [System.Net.IPAddress]::TryParse($LanIp, [ref]$parsedIp) -or
    $parsedIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
  throw 'A valid IPv4 address is required for the LiveKit media service.'
}

function New-MediaSecret([int]$ByteCount) {
  $bytes = [byte[]]::new($ByteCount)
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$content = [IO.File]::ReadAllText($EnvFile, [Text.Encoding]::UTF8)
$updated = $false
$portMatch = [regex]::Match($content, '(?m)^WEB_PORT="?([0-9]{1,5})"?\r?$')
$webPort = if ($portMatch.Success) { [int]$portMatch.Groups[1].Value } else { 8080 }
if ($webPort -lt 1 -or $webPort -gt 65535) { throw 'The website port in the environment file is invalid.' }
$httpsPortMatch = [regex]::Match($content, '(?m)^WEB_HTTPS_PORT="?([0-9]{1,5})"?\r?$')
$httpsPort = if ($httpsPortMatch.Success) { [int]$httpsPortMatch.Groups[1].Value } else { 8443 }
if ($httpsPort -lt 1 -or $httpsPort -gt 65535) { throw 'The HTTPS port in the environment file is invalid.' }
function Add-MissingSetting([string]$Name, [string]$Value) {
  $pattern = '(?m)^' + [regex]::Escape($Name) + '=(.*)\r?$'
  $match = [regex]::Match($script:content, $pattern)
  $existingValue = if ($match.Success) { $match.Groups[1].Value.Trim().Trim('"') } else { '' }
  if ($existingValue -and -not ($Name -eq 'LIVEKIT_PUBLIC_URL' -and $existingValue -match '^ws://(?:[0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{1,5}(?:/livekit)?/?$')) { return }
  $line = $Name + '="' + $Value + '"'
  if ($match.Success) {
    $script:content = $script:content.Substring(0, $match.Index) + $line + $script:content.Substring($match.Index + $match.Length)
  } else {
    if ($script:content.Length -gt 0 -and -not $script:content.EndsWith("`n")) { $script:content += "`r`n" }
    $script:content += $line + "`r`n"
  }
  $script:updated = $true
}

Add-MissingSetting 'LIVEKIT_API_KEY' ('lk_' + (New-MediaSecret 18))
Add-MissingSetting 'LIVEKIT_API_SECRET' (New-MediaSecret 48)
Add-MissingSetting 'SCHOOL_LAN_IP' $LanIp
Add-MissingSetting 'WEB_HTTPS_PORT' ([string]$httpsPort)
Add-MissingSetting 'LIVEKIT_PUBLIC_URL' "wss://${LanIp}:${httpsPort}/livekit"
Add-MissingSetting 'LIVEKIT_NODE_IP' $LanIp

if ($updated) { [IO.File]::WriteAllText($EnvFile, $content, [Text.UTF8Encoding]::new($false)) }
