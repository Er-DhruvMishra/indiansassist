# IndiansAssist starter playbook: Clear temp files.
$ErrorActionPreference = 'SilentlyContinue'
$targets = @($env:TEMP, (Join-Path $env:SystemRoot 'Temp'))
$freed = 0
foreach ($dir in $targets) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  Get-ChildItem -LiteralPath $dir -Force -Recurse -File | ForEach-Object {
    $size = $_.Length
    Remove-Item -LiteralPath $_.FullName -Force
    if (-not (Test-Path -LiteralPath $_.FullName)) { $freed += $size }
  }
}
Write-Output ("Freed {0:N1} MB" -f ($freed / 1MB))
