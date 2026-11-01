<#
.SYNOPSIS
  Creates the org-specific MST transform for the IndiansAssist Agent MSI (Phase D contracts 12.1).

.DESCRIPTION
  One base MSI serves every org. This script writes a transform that sets, on top of a given base
  MSI:
    - IA_ENROLL       base64url of the signed enroll.iaconfig (the only enrollment carrier, 12.3)
    - ProductName     "IndiansAssist Agent - <OrgName>" (install UI and Add/Remove Programs, 12.2)
    - ARPCONTACT      the org name; ARPHELPLINK when -HelpUrl is given
    - ARPPRODUCTICON  the org logo (an .ico), when -LogoIco is given
    - IA_WAKER_OPT_OUT / IA_AMT_PROXY_OPT_OUT when the switches are given

  It edits a temporary copy of the MSI through the Windows Installer automation API, generates the
  transform against the untouched base, then deletes the copy. Nothing is installed.

  The transform is validated against the base package's UpgradeCode only, so the same MST keeps
  applying to later builds of the base MSI (it changes Property rows and the Icon table only).

  The tokens page of the console (13.4) serves the same transform; this script is for admins and CI
  who build it themselves from the signed config returned by GET /api/v1/devices/enroll-config.

.EXAMPLE
  .\New-EnrollTransform.ps1 -Msi IndiansAssist-Agent-0.3.0-windows-x64.msi `
      -EnrollConfig .\enroll.iaconfig -OrgName "Acme Ltd" -Out .\acme.mst
  # GPO: assign the MSI with acme.mst under Modifications.
  # Command line: msiexec /i IndiansAssist-Agent-0.3.0-windows-x64.msi TRANSFORMS=acme.mst /qn
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Msi,
  [Parameter(Mandatory = $true)] [string] $EnrollConfig,
  [Parameter(Mandatory = $true)] [string] $Out,
  [string] $OrgName,
  [string] $HelpUrl,
  [string] $LogoIco,
  [switch] $WakerOptOut,
  [switch] $AmtProxyOptOut
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# --- Windows Installer automation helpers (the COM object has no type library for PowerShell, so
# members are called through IDispatch; PowerShell's PSObject wrappers must be removed first) ---
function ConvertTo-ComArgs([object[]] $argv) {
  $out = New-Object 'object[]' $argv.Count
  for ($i = 0; $i -lt $argv.Count; $i++) {
    $a = $argv[$i]
    if ($a -is [psobject]) { $a = $a.psobject.BaseObject }
    $out[$i] = $a
  }
  return ,$out
}
function Invoke-Com($obj, [string] $name, [object[]] $argv = @()) {
  return $obj.GetType().InvokeMember($name, [Reflection.BindingFlags]::InvokeMethod, $null, $obj, (ConvertTo-ComArgs $argv))
}
function Get-ComProp($obj, [string] $name, [object[]] $argv = @()) {
  return $obj.GetType().InvokeMember($name, [Reflection.BindingFlags]::GetProperty, $null, $obj, (ConvertTo-ComArgs $argv))
}
function Set-ComProp($obj, [string] $name, [object[]] $argv) {
  [void] $obj.GetType().InvokeMember($name, [Reflection.BindingFlags]::SetProperty, $null, $obj, (ConvertTo-ComArgs $argv))
}
function Invoke-Sql($db, [string] $sql, [object[]] $params = @()) {
  $view = Invoke-Com $db 'OpenView' @($sql)
  if ($params.Count -gt 0) {
    $rec = Invoke-Com $installer 'CreateRecord' @([int] $params.Count)
    for ($i = 0; $i -lt $params.Count; $i++) {
      if ($params[$i] -is [System.IO.FileInfo]) {
        Invoke-Com $rec 'SetStream' @([int] ($i + 1), $params[$i].FullName) | Out-Null
      } else {
        Set-ComProp $rec 'StringData' @([int] ($i + 1), [string] $params[$i])
      }
    }
    Invoke-Com $view 'Execute' @($rec) | Out-Null
  } else {
    Invoke-Com $view 'Execute' | Out-Null
  }
  Invoke-Com $view 'Close' | Out-Null
}
function Set-MsiProperty($db, [string] $name, [string] $value) {
  Invoke-Sql $db "DELETE FROM ``Property`` WHERE ``Property`` = '$name'"
  Invoke-Sql $db "INSERT INTO ``Property`` (``Property``, ``Value``) VALUES (?, ?)" @($name, $value)
}

# --- the signed enroll config -> IA_ENROLL (base64url of the verbatim bytes) ---
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $EnrollConfig))
if ($bytes.Length -gt 16384) { throw "enroll.iaconfig is larger than 16384 bytes" }
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
try { $cfg = $text | ConvertFrom-Json } catch { throw "enroll.iaconfig is not JSON" }
foreach ($k in 'v', 'apiOrigin', 'signalUrl', 'region', 'token', 'kid', 'sig') {
  if (-not ($cfg.PSObject.Properties.Name -contains $k)) { throw "enroll.iaconfig is missing '$k' (expected the signed file from GET /api/v1/devices/enroll-config)" }
}
if ($cfg.v -ne 1 -or $cfg.signalUrl -notmatch '/signal/device$') { throw "enroll.iaconfig has the wrong version or signalUrl" }
$iaEnroll = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

if ($OrgName -and ($OrgName.Length -gt 60 -or $OrgName -match '[\[\]{}\r\n]')) {
  throw "OrgName must be at most 60 characters without brackets, braces or line breaks"
}
if ($LogoIco -and -not (Test-Path $LogoIco)) { throw "LogoIco $LogoIco not found" }

$installer = New-Object -ComObject WindowsInstaller.Installer
$base = (Resolve-Path $Msi).Path
$outPath = [System.IO.Path]::GetFullPath($Out)
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("ia-transform-" + [guid]::NewGuid().ToString('N') + '.msi')
Copy-Item -LiteralPath $base -Destination $work
$db = $null
$baseDb = $null

try {
  $db = Invoke-Com $installer 'OpenDatabase' @($work, 1)  # msiOpenDatabaseModeTransact
  Set-MsiProperty $db 'IA_ENROLL' $iaEnroll
  if ($OrgName) {
    Set-MsiProperty $db 'ProductName' ("IndiansAssist Agent - " + $OrgName)
    Set-MsiProperty $db 'ARPCONTACT' $OrgName
  }
  if ($HelpUrl) { Set-MsiProperty $db 'ARPHELPLINK' $HelpUrl }
  if ($WakerOptOut) { Set-MsiProperty $db 'IA_WAKER_OPT_OUT' '1' }
  if ($AmtProxyOptOut) { Set-MsiProperty $db 'IA_AMT_PROXY_OPT_OUT' '1' }
  if ($LogoIco) {
    $hasIcon = [int] (Get-ComProp $db 'TablePersistent' @('Icon'))  # 1 = exists, 2 = absent
    if ($hasIcon -ne 1) {
      Invoke-Sql $db 'CREATE TABLE `Icon` (`Name` CHAR(72) NOT NULL, `Data` OBJECT NOT NULL PRIMARY KEY `Name`)'
    }
    Invoke-Sql $db "DELETE FROM ``Icon`` WHERE ``Name`` = 'OrgLogo.ico'"
    Invoke-Sql $db 'INSERT INTO `Icon` (`Name`, `Data`) VALUES (?, ?)' @('OrgLogo.ico', (Get-Item -LiteralPath $LogoIco))
    Set-MsiProperty $db 'ARPPRODUCTICON' 'OrgLogo.ico'
  }
  Invoke-Com $db 'Commit' | Out-Null

  $baseDb = Invoke-Com $installer 'OpenDatabase' @($base, 0)  # read-only
  if (Test-Path -LiteralPath $outPath) { Remove-Item -LiteralPath $outPath -Force }
  [void] (Invoke-Com $db 'GenerateTransform' @($baseDb, $outPath))
  # Suppress add-existing-row/table, delete-missing-row, update-missing-row (0x17) so the transform
  # applies to later builds of the base; validate the UpgradeCode only (0x800).
  [void] (Invoke-Com $db 'CreateTransformSummaryInfo' @($baseDb, $outPath, [int] 0x17, [int] 0x800))
} finally {
  foreach ($o in @($baseDb, $db)) {
    if ($null -ne $o) { [void] [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($o) }
  }
  $db = $null; $baseDb = $null
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  # The working copy holds IA_ENROLL: overwrite, then delete. Never mask the original error.
  try {
    if (Test-Path -LiteralPath $work) {
      $len = (Get-Item -LiteralPath $work).Length
      [System.IO.File]::WriteAllBytes($work, (New-Object byte[] $len))
      Remove-Item -LiteralPath $work -Force
    }
  } catch {
    Write-Warning "could not remove the working copy $work (it contains IA_ENROLL): $($_.Exception.Message)"
  }
}

Write-Output "transform written: $outPath"
Write-Output "  region $($cfg.region), group $(if ($cfg.PSObject.Properties.Name -contains 'groupId' -and $cfg.groupId) { $cfg.groupId } else { 'none' }), org '$OrgName'"
Write-Output "  the transform carries an enrollment token: store it like a secret (see packaging/README.md)"
