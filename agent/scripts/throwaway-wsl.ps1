<#
.SYNOPSIS
  Phase F contract section 8.12 "T2 disposable WSL distro" (opt-in, never a default gate):

    $env:IA_THROWAWAY_WSL = '1'; pnpm linux:throwaway -- -EnrollConfig <enroll.iaconfig> [-Deb <path>]

.DESCRIPTION
  Imports a distro named IA-Throwaway-<8 hex> from Ubuntu's official 24.04 WSL image (sha256 checked
  against the SHA256SUMS published beside it, and against -ImageSha256 when given) into a temporary
  directory, enables systemd in its /etc/wsl.conf, installs the deb, enrolls against the Windows-hosted
  test api (port 4160; the enroll.iaconfig names its origin), checks the unit is active, kills the
  service and checks Restart= brought it back with a watchdog_restarted tamper event, runs one
  read-only device action when -DeviceActionScript is given, purges, and then ALWAYS runs
  `wsl --terminate` and `wsl --unregister` on that distro in a finally block.

  It refuses unless IA_THROWAWAY_WSL is exactly 1, refuses a name that does not match
  ^IA-Throwaway-[0-9a-f]{8}$ (case-sensitive), refuses when a distro of that name exists, and never
  touches the `Ubuntu` distro. It needs the user's explicit run, network (about 400 MB), about 3 GB of
  disk and WSL with --import. Enrollment over plain http needs the api reachable as
  http://127.0.0.1:4160 inside the distro (WSL mirrored networking), because config.json allows plain
  http only for localhost; otherwise the enrollment steps are reported "not met".

  -SelfTest runs only the pure name and refusal rules (no wsl.exe call, no download) and exits 0 when
  every case passes. It is what `pnpm test:scripts` runs; T2 itself is never run by automation.
#>
[CmdletBinding()]
param(
  [switch]$SelfTest,
  [string]$Deb = '',
  [string]$EnrollConfig = '',
  [string]$DeviceActionScript = '',
  [string]$ImageUrl = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz',
  [string]$ImageSha256 = '',
  [string]$Name = ''
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

# --- the pure rules (all the self-test exercises) ---------------------------------------------------

$script:ThrowawayPattern = '^IA-Throwaway-[0-9a-f]{8}$'

function New-ThrowawayName {
  $bytes = New-Object byte[] 4
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  'IA-Throwaway-' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Test-ThrowawayName([string]$Candidate) {
  # -cmatch: case-sensitive, and `$` must not let a trailing newline through.
  return ($null -ne $Candidate) -and ($Candidate -cmatch $script:ThrowawayPattern) -and ($Candidate -notmatch "[`r`n]")
}

<# The reason T2 must not run, or $null. WSL distro names compare case-insensitively. #>
function Get-ThrowawayRefusal([string]$Candidate, [string[]]$Existing, [string]$OptIn) {
  if ($OptIn -ne '1') { return 'T2 is opt-in: set IA_THROWAWAY_WSL=1 to run it' }
  if ($Candidate -ieq 'Ubuntu') { return 'refusing the Ubuntu distro: T2 never touches it' }
  if (-not (Test-ThrowawayName $Candidate)) { return "refusing the distro name '$Candidate': it must match $script:ThrowawayPattern" }
  foreach ($e in @($Existing)) {
    if ($null -ne $e -and $e.Trim() -ieq $Candidate) { return "refusing '$Candidate': a distro of that name already exists" }
  }
  return $null
}

<# The guard in front of every destructive wsl.exe call (terminate, unregister). #>
function Assert-ThrowawayTarget([string]$Candidate) {
  if (-not (Test-ThrowawayName $Candidate)) { throw "refusing to act on the distro '$Candidate' (not an IA-Throwaway-<8 hex> name)" }
}

<# One line of `sha256sum`-style SHA256SUMS for $File: '<hex> *<file>' or '<hex>  <file>'. #>
function Find-PublishedSha256([string]$SumsText, [string]$File) {
  foreach ($line in ($SumsText -split "`n")) {
    $m = [regex]::Match($line.Trim(), '^([0-9a-f]{64}) [ *](.+)$')
    if ($m.Success -and $m.Groups[2].Value -ceq $File) { return $m.Groups[1].Value }
  }
  return $null
}

function Invoke-SelfTest {
  $script:pass = 0
  $script:fail = 0
  function Check([string]$What, [bool]$Ok) {
    if ($Ok) { $script:pass++; [Console]::Out.WriteLine("  ok   $What") } else { $script:fail++; [Console]::Out.WriteLine("  FAIL $What") }
  }
  $names = 1..64 | ForEach-Object { New-ThrowawayName }
  Check 'every generated name matches the pattern' (@($names | Where-Object { -not (Test-ThrowawayName $_) }).Count -eq 0)
  Check 'generated names are random (64 draws, at least 60 distinct)' (@($names | Sort-Object -Unique).Count -ge 60)
  Check 'accepts IA-Throwaway-0123abcd' (Test-ThrowawayName 'IA-Throwaway-0123abcd')
  foreach ($bad in @('Ubuntu', 'ubuntu', 'IA-Throwaway-0123ABCD', 'ia-throwaway-0123abcd', 'IA-Throwaway-0123abc',
      'IA-Throwaway-0123abcde', 'IA-Throwaway-0123abcd ', "IA-Throwaway-0123abcd`n", 'X-IA-Throwaway-0123abcd',
      'IA-Throwaway-', '', 'IA-Throwaway-0123abcg', 'IA_Throwaway-0123abcd')) {
    Check ("refuses the name '" + ($bad -replace "`n", '\n') + "'") (-not (Test-ThrowawayName $bad))
  }
  $good = 'IA-Throwaway-0123abcd'
  Check 'refuses without IA_THROWAWAY_WSL' ($null -ne (Get-ThrowawayRefusal $good @() ''))
  Check 'refuses IA_THROWAWAY_WSL=0' ($null -ne (Get-ThrowawayRefusal $good @() '0'))
  Check 'refuses IA_THROWAWAY_WSL=true (exactly 1)' ($null -ne (Get-ThrowawayRefusal $good @() 'true'))
  Check 'allows a fresh matching name with IA_THROWAWAY_WSL=1' ($null -eq (Get-ThrowawayRefusal $good @('Ubuntu', 'docker-desktop') '1'))
  Check 'refuses a name that exists' ($null -ne (Get-ThrowawayRefusal $good @('Ubuntu', $good) '1'))
  Check 'refuses a name that exists in another case' ($null -ne (Get-ThrowawayRefusal $good @('ia-throwaway-0123ABCD') '1'))
  Check 'refuses the Ubuntu distro even when opted in' ($null -ne (Get-ThrowawayRefusal 'Ubuntu' @() '1'))
  Check 'refuses a non-matching name when opted in' ($null -ne (Get-ThrowawayRefusal 'IA-Throwaway-xyz' @() '1'))
  $threw = $false
  try { Assert-ThrowawayTarget 'Ubuntu' } catch { $threw = $true }
  Check 'the terminate/unregister guard throws for Ubuntu' $threw
  $threw = $false
  try { Assert-ThrowawayTarget $good } catch { $threw = $true }
  Check 'the terminate/unregister guard allows an IA-Throwaway name' (-not $threw)
  $sums = "1111111111111111111111111111111111111111111111111111111111111111 *other.tar.gz`n" +
    "2222222222222222222222222222222222222222222222222222222222222222 *image.tar.gz`n"
  Check 'reads the published sha256 of the image' ((Find-PublishedSha256 $sums 'image.tar.gz') -eq ('2' * 64))
  Check 'an image missing from SHA256SUMS has no sha256' ($null -eq (Find-PublishedSha256 $sums 'missing.tar.gz'))
  [Console]::Out.WriteLine("IA_T2_SELFTEST_PASSED=$($script:pass)")
  [Console]::Out.WriteLine("IA_T2_SELFTEST_FAILED=$($script:fail)")
  if ($script:fail -eq 0) { return 0 } else { return 1 }
}

if ($SelfTest) {
  exit (Invoke-SelfTest)
}

# --- T2 itself (opt-in; never run by automation) ----------------------------------------------------

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Invoke-Wsl([string[]]$WslArgs) {
  & wsl.exe @WslArgs
  if ($LASTEXITCODE -ne 0) { throw "wsl.exe $($WslArgs -join ' ') exited $LASTEXITCODE" }
}

function Get-WslDistroNames {
  # `wsl --list --quiet` writes UTF-16; read it as such.
  $previous = [Console]::OutputEncoding
  try {
    [Console]::OutputEncoding = [System.Text.Encoding]::Unicode
    $out = & wsl.exe --list --quiet
  } finally {
    [Console]::OutputEncoding = $previous
  }
  @($out | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ -ne '' })
}

function In-Distro([string]$Distro, [string]$Command) {
  Assert-ThrowawayTarget $Distro
  # The output goes to the console, never into this function's return value (the exit code).
  & wsl.exe -d $Distro -u root -- sh -c $Command | ForEach-Object { [Console]::Out.WriteLine($_) }
  return $LASTEXITCODE
}

if ($Name -eq '') { $Name = New-ThrowawayName }
$refusal = Get-ThrowawayRefusal $Name (Get-WslDistroNames) $env:IA_THROWAWAY_WSL
if ($null -ne $refusal) {
  Write-Error "linux:throwaway: $refusal" -ErrorAction Continue
  exit 2
}
if ($Deb -eq '') {
  $Deb = Get-ChildItem (Join-Path $root 'packaging\linux\out\dist') -Filter 'IndiansAssist-Agent-*-linux-x64.deb' -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Deb -or -not (Test-Path $Deb)) { Write-Error 'linux:throwaway: no deb (run pnpm linux:pkg or pass -Deb)' -ErrorAction Continue; exit 2 }
if ($EnrollConfig -ne '' -and -not (Test-Path $EnrollConfig)) { Write-Error "linux:throwaway: $EnrollConfig does not exist" -ErrorAction Continue; exit 2 }

function ConvertTo-WslPath([string]$WinPath) {
  $full = (Resolve-Path $WinPath).Path
  '/mnt/' + $full.Substring(0, 1).ToLower() + ($full.Substring(2) -replace '\\', '/')
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) $Name
New-Item -ItemType Directory -Path $temp | Out-Null
$results = [ordered]@{}
$imported = $false
try {
  # The image, sha256 checked against the SHA256SUMS published beside it.
  $file = Split-Path $ImageUrl -Leaf
  $image = Join-Path $temp $file
  $sumsUrl = ($ImageUrl.Substring(0, $ImageUrl.Length - $file.Length)) + 'SHA256SUMS'
  Write-Output "linux:throwaway: downloading $ImageUrl"
  Invoke-WebRequest -UseBasicParsing -Uri $sumsUrl -OutFile (Join-Path $temp 'SHA256SUMS')
  Invoke-WebRequest -UseBasicParsing -Uri $ImageUrl -OutFile $image
  $published = Find-PublishedSha256 (Get-Content -Raw (Join-Path $temp 'SHA256SUMS')) $file
  $actual = (Get-FileHash -Algorithm SHA256 $image).Hash.ToLower()
  if ($null -eq $published -or $actual -ne $published) { throw "the image sha256 $actual is not the published $published" }
  if ($ImageSha256 -ne '' -and $actual -ne $ImageSha256.ToLower()) { throw "the image sha256 $actual is not the pinned $ImageSha256" }
  $results['image sha256'] = $actual

  Assert-ThrowawayTarget $Name
  Invoke-Wsl @('--import', $Name, (Join-Path $temp 'disk'), $image, '--version', '2')
  $imported = $true
  [void](In-Distro $Name "printf '[boot]\nsystemd=true\n[automount]\nenabled=true\n' >/etc/wsl.conf")
  Invoke-Wsl @('--terminate', $Name)
  [void](In-Distro $Name 'systemctl is-system-running --wait >/dev/null 2>&1; systemctl is-system-running || true')

  $debIn = ConvertTo-WslPath $Deb
  $results['dpkg -i'] = (In-Distro $Name "dpkg -i '$debIn'") -eq 0
  $results['unit active after install'] = (In-Distro $Name 'systemctl is-active --quiet indiansassist-agent') -eq 0
  if ($EnrollConfig -ne '') {
    $cfgIn = ConvertTo-WslPath $EnrollConfig
    [void](In-Distro $Name "install -m 0600 '$cfgIn' /etc/indiansassist/enroll.iaconfig && systemctl restart indiansassist-agent")
    $results['enrolled (config.json has a deviceId)'] = (In-Distro $Name 'for i in $(seq 1 30); do grep -q deviceId /var/lib/indiansassist/config.json 2>/dev/null && exit 0; sleep 1; done; exit 1') -eq 0
  } else {
    $results['enrolled'] = 'not met: no -EnrollConfig'
  }
  [void](In-Distro $Name 'systemctl kill -s SIGKILL indiansassist-agent')
  $results['Restart= brought it back'] = (In-Distro $Name 'sleep 8; systemctl is-active --quiet indiansassist-agent && test "$(systemctl show -p NRestarts --value indiansassist-agent)" -ge 1') -eq 0
  $results['watchdog_restarted recorded'] = (In-Distro $Name 'for i in $(seq 1 20); do journalctl -u indiansassist-agent --no-pager | grep -q "systemd restarted the service" && exit 0; sleep 1; done; exit 1') -eq 0
  if ($DeviceActionScript -ne '') {
    & $DeviceActionScript -Distro $Name
    $results['read-only device action'] = ($LASTEXITCODE -eq 0)
  } else {
    $results['read-only device action'] = 'not run: no -DeviceActionScript'
  }
  $results['dpkg --purge'] = (In-Distro $Name 'dpkg --purge indiansassist-agent') -eq 0
  $results['nothing remains'] = (In-Distro $Name '! test -e /var/lib/indiansassist && ! test -e /etc/indiansassist && ! test -e /usr/lib/indiansassist') -eq 0
} finally {
  if ($imported) {
    Assert-ThrowawayTarget $Name
    & wsl.exe --terminate $Name
    & wsl.exe --unregister $Name
  }
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
$results.GetEnumerator() | ForEach-Object { Write-Output ("  {0}: {1}" -f $_.Key, $_.Value) }
$failed = @($results.Values | Where-Object { $_ -is [bool] -and -not $_ }).Count
if ($failed -eq 0) { exit 0 } else { exit 1 }
