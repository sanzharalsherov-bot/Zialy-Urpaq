$ErrorActionPreference = 'Stop'
$repoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path.TrimEnd('\')
$outputDir = Join-Path $PSScriptRoot 'dist'
$workDir = Join-Path $env:TEMP ('zailyurpaq-package-' + [guid]::NewGuid().ToString('N'))
$payloadDir = Join-Path $workDir 'payload'
$zipPath = Join-Path $workDir 'deployment.zip'
$setupScript = Join-Path $PSScriptRoot 'install.ps1'
$installerSource = Join-Path $PSScriptRoot 'InstallerApp.cs'
$brandLogo = Join-Path $repoDir 'apps\web\public\brand\zaily-urpaq-logo.jpg'
$targetExe = Join-Path $outputDir 'ZailyUrpaqSetup.exe'
$stagedExe = Join-Path $outputDir '.ZailyUrpaqSetup.staged.exe'
New-Item -ItemType Directory -Force -Path $payloadDir, $outputDir | Out-Null

try {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $excludedSegments = @('node_modules', '.next', 'dist', '.git', 'backups', 'output', 'tmp')
  Get-ChildItem -LiteralPath $repoDir -Recurse -File -Force | ForEach-Object {
    $relative = $_.FullName.Substring($repoDir.Length).TrimStart('\', '/')
    $segments = $relative -split '[\\/]'
    if ($segments | Where-Object { $excludedSegments -contains $_ }) { return }
    if ($_.Name -like '.env*' -or $_.Name -like '*.bak' -or $_.Name -in @('school-crm-source.zip', 'reset-admin-password.js', 'README-AUTH-PATCH.md', 'ZailyUrpaqSetup.exe')) { return }
    $destination = Join-Path $payloadDir $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination
  }
  [IO.Compression.ZipFile]::CreateFromDirectory($payloadDir, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $false)

  $candidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  )
  $compiler = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $compiler) { throw 'Компилятор Windows .NET Framework не найден. Соберите установщик на Windows с установленным .NET Framework 4.x.' }

  & $compiler /nologo /target:winexe /platform:anycpu /optimize+ "/out:$stagedExe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:Microsoft.CSharp.dll "/resource:$zipPath,Deployment.zip" "/resource:$setupScript,Install.ps1" "/resource:$brandLogo,BrandLogo.jpg" $installerSource
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать графический установщик. Проверьте ошибки компилятора выше.' }

  try {
    Move-Item -LiteralPath $stagedExe -Destination $targetExe -Force
  } catch {
    $targetExe = Join-Path $outputDir 'ZailyUrpaqSetup-Updated.exe'
    Move-Item -LiteralPath $stagedExe -Destination $targetExe -Force
  }

  Write-Host "Графический установщик собран: $targetExe" -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
