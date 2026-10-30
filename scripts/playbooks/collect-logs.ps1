# IndiansAssist starter playbook: Collect logs (zip), then offer the file to the Desk (never auto-sent).
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'IndiansAssist'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$work = Join-Path $root "logs-$stamp"
New-Item -ItemType Directory -Path $work -Force | Out-Null
$since = (Get-Date).AddHours(-24)
foreach ($log in 'System', 'Application') {
  Get-WinEvent -FilterHashtable @{ LogName = $log; StartTime = $since } -ErrorAction SilentlyContinue |
    Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, Message |
    Export-Csv -LiteralPath (Join-Path $work "$log.csv") -NoTypeInformation -Encoding UTF8
}
ipconfig /all | Out-File -LiteralPath (Join-Path $work 'ipconfig.txt') -Encoding UTF8
systeminfo | Out-File -LiteralPath (Join-Path $work 'systeminfo.txt') -Encoding UTF8
$zip = "$work.zip"
Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zip -Force
Remove-Item -LiteralPath $work -Recurse -Force
Write-Output "IA_FILE_OFFER $zip"
