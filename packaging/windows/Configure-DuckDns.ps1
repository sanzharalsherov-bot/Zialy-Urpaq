param([string]$SettingsFile=(Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.env.duckdns'),[string]$Hostname='zailyurpaq.duckdns.org')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form=New-Object Windows.Forms.Form
$form.Text='Zaily Urpaq - DuckDNS'
$form.ClientSize=New-Object Drawing.Size(520,235)
$form.StartPosition='CenterScreen'
$form.TopMost=$true
$form.ShowInTaskbar=$true
$form.Add_Shown({$form.Activate();$tokenBox.Focus()})
$form.FormBorderStyle='FixedDialog'
$form.MaximizeBox=$false
$label=New-Object Windows.Forms.Label
$label.Text="Domain: $Hostname`r`nPaste your DuckDNS token below. It stays in a restricted local file.`r`nNo token will be displayed in chat or console."
$label.Location=New-Object Drawing.Point(18,18)
$label.Size=New-Object Drawing.Size(480,65)
$form.Controls.Add($label)
$tokenBox=New-Object Windows.Forms.TextBox
$tokenBox.Location=New-Object Drawing.Point(18,95)
$tokenBox.Size=New-Object Drawing.Size(480,25)
$tokenBox.UseSystemPasswordChar=$true
$form.Controls.Add($tokenBox)
$button=New-Object Windows.Forms.Button
$button.Text='Save locally'
$button.Location=New-Object Drawing.Point(18,145)
$button.Size=New-Object Drawing.Size(150,35)
$button.Add_Click({
  try {
    & (Join-Path $PSScriptRoot 'Set-DuckDnsSettings.ps1') -SettingsFile $SettingsFile -Hostname $Hostname -Token $tokenBox.Text | Out-Null
    $tokenBox.Clear()
    $form.DialogResult=[Windows.Forms.DialogResult]::OK
    $form.Close()
  } catch {
    [Windows.Forms.MessageBox]::Show('Unable to save. Check the hostname and token format.','DuckDNS') | Out-Null
  }
})
$form.Controls.Add($button)
$form.AcceptButton=$button
[void]$form.ShowDialog()
$form.Dispose()
