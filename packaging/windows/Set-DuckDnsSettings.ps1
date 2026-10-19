param(
  [Parameter(Mandatory=$true)][string]$SettingsFile,
  [Parameter(Mandatory=$true)][string]$Hostname,
  [Parameter(Mandatory=$true)][string]$Token
)
$ErrorActionPreference='Stop'
$Hostname=$Hostname.Trim().ToLowerInvariant()
if ($Hostname -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.duckdns\.org$') { throw 'Enter a single DuckDNS hostname without a URL, path or port.' }
if ($Token -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { throw 'The DuckDNS token format is invalid.' }
$SettingsFile=[IO.Path]::GetFullPath($SettingsFile)
if ([IO.Path]::GetFileName($SettingsFile) -ne '.env.duckdns') { throw 'DuckDNS credentials must use the separate .env.duckdns file.' }
$temporary=$SettingsFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
try {
  [IO.File]::WriteAllText($temporary,'')
  $acl=New-Object Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true,$false)
  $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  foreach($sid in @($owner,$system)) {
    $access=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')
    $acl.AddAccessRule($access)
  }
  [IO.File]::SetAccessControl($temporary,$acl)
  [IO.File]::WriteAllText($temporary,"SCHOOL_HOSTNAME=$Hostname`r`nDUCKDNS_API_TOKEN=$Token`r`n",[Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $SettingsFile -Force -ErrorAction Stop
  Write-Output 'DuckDNS settings saved in the separate restricted file. Token is not displayed.'
} finally { if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force} }
