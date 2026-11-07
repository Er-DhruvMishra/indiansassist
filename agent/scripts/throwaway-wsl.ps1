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
  disk and WSL with --import.

  Enrollment over plain http needs the api reachable as http://127.0.0.1:<port> inside the distro,
  because config.json allows plain http only for localhost. With WSL mirrored networking that holds
  as is. In NAT mode (the default; no `networkingMode=mirrored` in %USERPROFILE%\.wslconfig)
  -NatForward, on by default there, starts a TCP forwarder inside the distro from 127.0.0.1:<port>
  (the port of the enroll config's http://127.0.0.1 or http://localhost origin) to <gateway>:<port>,
  the Windows host as `ip route` shows it, using only the image's own python3 as a transient systemd
  unit (`ia-t2-forward`), and stops it in the finally. Ports 4000, 4100 and 4105 are refused. A
  hidden `wsl.exe ... sleep infinity` keeps the distro running between steps; it is stopped in the
  finally too. Every in-distro command runs from a script file in the temporary directory, so no
  shell text is quoted through wsl.exe.

  -SelfTest runs only the pure rules (names, refusals, the published sha256, the networking mode, the
  forward port and the gateway; no wsl.exe call, no download) and exits 0 when every case passes. It
  is what `pnpm test:scripts` runs; T2 itself is never run by automation.
#>
[CmdletBinding()]
param(
  [switch]$SelfTest,
  [string]$Deb = '',
  [string]$EnrollConfig = '',
  [string]$DeviceActionScript = '',
  [string]$ImageUrl = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz',
  [string]$ImageSha256 = '',
  [string]$Name = '',
  # NAT mode: forward 127.0.0.1:<port> inside the distro to the Windows host. Default: on unless
  # .wslconfig asks for mirrored networking; -NatForward:$false turns it off.
  [switch]$NatForward
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

<# 'mirrored' when the [wsl2] section of a .wslconfig sets networkingMode=mirrored, else 'nat' (WSL's default). #>
function Get-WslNetworkingMode([string]$WslConfigText) {
  $section = ''
  foreach ($raw in (([string]$WslConfigText) -split "`n")) {
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith('#') -or $line.StartsWith(';')) { continue }
    $s = [regex]::Match($line, '^\[([^\]]+)\]$')
    if ($s.Success) { $section = $s.Groups[1].Value.Trim().ToLowerInvariant(); continue }
    $kv = [regex]::Match($line, '^([A-Za-z0-9_.]+)\s*=\s*(.*?)\s*$')
    if ($section -eq 'wsl2' -and $kv.Success -and $kv.Groups[1].Value -ieq 'networkingMode') {
      if ($kv.Groups[2].Value.Trim('"') -ieq 'mirrored') { return 'mirrored' } else { return 'nat' }
    }
  }
  return 'nat'
}

<# Whether to run the NAT forwarder: the explicit -NatForward[:$false] when given, else on unless mirrored. #>
function Resolve-NatForward([bool]$Given, [bool]$Value, [string]$Mode) {
  if ($Given) { return $Value }
  return ($Mode -ne 'mirrored')
}

<#
  The forward plan for an enroll config's apiOrigin: @{ Port = <int>; Refusal = $null } for a plain
  http loopback origin with an explicit port, @{ Port = 0; Refusal = $null } when no forward is needed
  (https), or @{ Port = 0; Refusal = '<why>' }.
#>
function Get-ForwardPlan([string]$ApiOrigin) {
  if ($null -eq $ApiOrigin -or $ApiOrigin -match "[`r`n]") { return @{ Port = 0; Refusal = 'the enroll config names no apiOrigin' } }
  if ($ApiOrigin -cmatch '^https://') { return @{ Port = 0; Refusal = $null } }
  $m = [regex]::Match($ApiOrigin, '^http://(127\.0\.0\.1|localhost):([0-9]{1,5})/?$')
  if (-not $m.Success) { return @{ Port = 0; Refusal = "the origin '$ApiOrigin' is not http://127.0.0.1:<port> or http://localhost:<port>" } }
  $port = [int]$m.Groups[2].Value
  if ($port -lt 1 -or $port -gt 65535) { return @{ Port = 0; Refusal = "the port $port is out of range" } }
  if (@(4000, 4100, 4105) -contains $port) { return @{ Port = 0; Refusal = "refusing to forward port ${port}: 4000, 4100 and 4105 are never used" } }
  return @{ Port = $port; Refusal = $null }
}

<# The IPv4 gateway of `ip route show default` output, or $null. #>
function Find-DefaultGateway([string]$IpRouteText) {
  foreach ($line in (([string]$IpRouteText) -split "`n")) {
    $m = [regex]::Match($line.Trim(), '^default via ((?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3})(?:\s|$)')
    if ($m.Success) { return $m.Groups[1].Value }
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
  Check 'no .wslconfig means NAT' ((Get-WslNetworkingMode '') -eq 'nat')
  Check 'networkingMode=mirrored under [wsl2] means mirrored' ((Get-WslNetworkingMode "[wsl2]`r`nmemory=8GB`r`nnetworkingMode=mirrored`r`n") -eq 'mirrored')
  Check 'the key and value compare case-insensitively' ((Get-WslNetworkingMode "[WSL2]`nNetworkingMode = Mirrored`n") -eq 'mirrored')
  Check 'networkingMode=nat means NAT' ((Get-WslNetworkingMode "[wsl2]`nnetworkingMode=nat`n") -eq 'nat')
  Check 'networkingMode outside [wsl2] is ignored' ((Get-WslNetworkingMode "[experimental]`nnetworkingMode=mirrored`n") -eq 'nat')
  Check 'a commented-out mirrored line is ignored' ((Get-WslNetworkingMode "[wsl2]`n# networkingMode=mirrored`n") -eq 'nat')
  Check 'the forwarder is on by default in NAT mode' (Resolve-NatForward $false $false 'nat')
  Check 'the forwarder is off by default with mirrored networking' (-not (Resolve-NatForward $false $false 'mirrored'))
  Check '-NatForward:$false turns it off in NAT mode' (-not (Resolve-NatForward $true $false 'nat'))
  Check '-NatForward turns it on with mirrored networking' (Resolve-NatForward $true $true 'mirrored')
  Check 'http://127.0.0.1:4160 forwards port 4160' ((Get-ForwardPlan 'http://127.0.0.1:4160').Port -eq 4160)
  Check 'http://localhost:4160/ forwards port 4160' ((Get-ForwardPlan 'http://localhost:4160/').Port -eq 4160)
  Check 'an https origin needs no forward' (((Get-ForwardPlan 'https://in.example.test').Port -eq 0) -and ($null -eq (Get-ForwardPlan 'https://in.example.test').Refusal))
  foreach ($taken in @('4000', '4100', '4105')) {
    Check "refuses to forward port $taken" ($null -ne (Get-ForwardPlan "http://127.0.0.1:$taken").Refusal)
  }
  foreach ($bad in @('http://127.0.0.1', 'http://10.0.0.5:4160', 'http://127.0.0.1:99999', 'http://127.0.0.1:0', "http://127.0.0.1:4160`n", 'http://127.0.0.1:4160/x', 'ftp://127.0.0.1:4160')) {
    Check ("refuses the origin '" + ($bad -replace "`n", '\n') + "'") ($null -ne (Get-ForwardPlan $bad).Refusal)
  }
  Check 'reads the gateway of ip route' ((Find-DefaultGateway "default via 172.23.128.1 dev eth0 proto kernel onlink`n172.23.128.0/20 dev eth0 proto kernel scope link src 172.23.140.7`n") -eq '172.23.128.1')
  Check 'no default route means no gateway' ($null -eq (Find-DefaultGateway '172.23.128.0/20 dev eth0 proto kernel scope link'))
  Check 'an address that is not IPv4 is not a gateway' ($null -eq (Find-DefaultGateway 'default via 300.1.1.1 dev eth0'))
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

function ConvertTo-WslPath([string]$WinPath) {
  $full = (Resolve-Path $WinPath).Path
  '/mnt/' + $full.Substring(0, 1).ToLower() + ($full.Substring(2) -replace '\\', '/')
}

$script:StepCount = 0
$script:StepDir = $null

<# Writes one in-distro command to a script file under the temporary directory (LF, no BOM) and returns its WSL path. #>
function Write-DistroStep([string]$Command) {
  $script:StepCount++
  $file = Join-Path $script:StepDir ('step-{0:d2}.sh' -f $script:StepCount)
  [System.IO.File]::WriteAllText($file, (($Command -replace "`r`n", "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
  ConvertTo-WslPath $file
}

<# Runs a command as root in the throwaway distro from a script file (no shell text is quoted through wsl.exe). #>
function In-Distro([string]$Distro, [string]$Command) {
  Assert-ThrowawayTarget $Distro
  $step = Write-DistroStep $Command
  # The output goes to the console, never into this function's return value (the exit code).
  & wsl.exe -d $Distro -u root -- sh $step | ForEach-Object { [Console]::Out.WriteLine($_) }
  return $LASTEXITCODE
}

<# Like In-Distro, but returns the command's output as one string. #>
function Get-DistroOutput([string]$Distro, [string]$Command) {
  Assert-ThrowawayTarget $Distro
  $step = Write-DistroStep $Command
  $out = & wsl.exe -d $Distro -u root -- sh $step
  (@($out) | ForEach-Object { "$_" }) -join "`n"
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

# NAT mode: which port to forward, decided before anything is imported.
$wslConfigPath = Join-Path $env:USERPROFILE '.wslconfig'
$wslConfigText = if (Test-Path $wslConfigPath) { Get-Content -Raw $wslConfigPath } else { '' }
$networkingMode = Get-WslNetworkingMode $wslConfigText
$forward = Resolve-NatForward $PSBoundParameters.ContainsKey('NatForward') ([bool]$NatForward) $networkingMode
$forwardPort = 0
if ($forward -and $EnrollConfig -ne '') {
  $origin = $null
  try { $origin = [string](Get-Content -Raw $EnrollConfig | ConvertFrom-Json).apiOrigin } catch { $origin = $null }
  $plan = Get-ForwardPlan $origin
  if ($null -ne $plan.Refusal) { Write-Error "linux:throwaway: $($plan.Refusal)" -ErrorAction Continue; exit 2 }
  $forwardPort = $plan.Port
}
Write-Output "linux:throwaway: WSL networking $networkingMode; NAT forwarder $(if ($forwardPort -gt 0) { "127.0.0.1:$forwardPort -> <gateway>:$forwardPort" } else { 'off' })"

# The forwarder, run by the image's own python3 (nothing is installed in the distro).
$forwarderPy = @'
import asyncio, sys
host, port = sys.argv[1], int(sys.argv[2])
async def pipe(r, w):
    try:
        while (data := await r.read(65536)):
            w.write(data)
            await w.drain()
    except Exception:
        pass
    finally:
        w.close()
async def handle(cr, cw):
    try:
        ur, uw = await asyncio.open_connection(host, port)
    except Exception:
        cw.close()
        return
    await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", port)
    print(f"IA_T2_FORWARD 127.0.0.1:{port} -> {host}:{port}", flush=True)
    async with server:
        await server.serve_forever()
asyncio.run(main())
'@
# GET /api/v1/health through the forwarder, retrying for up to 15 s.
$probePy = @'
import sys, time, urllib.request
port = int(sys.argv[1])
for _ in range(30):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/health", timeout=3) as r:
            if r.status == 200:
                print(f"IA_T2_API_HEALTH 200 via 127.0.0.1:{port}")
                sys.exit(0)
    except Exception as e:
        last = e
    time.sleep(0.5)
print(f"IA_T2_API_HEALTH unreachable via 127.0.0.1:{port}")
sys.exit(1)
'@

$temp = Join-Path ([System.IO.Path]::GetTempPath()) $Name
New-Item -ItemType Directory -Path $temp | Out-Null
$script:StepDir = $temp
$results = [ordered]@{}
$imported = $false
$forwardStarted = $false
$keepalive = $null
try {
  # The image, sha256 checked against the SHA256SUMS published beside it.
  $file = Split-Path $ImageUrl -Leaf
  $image = Join-Path $temp $file
  $sumsUrl = ($ImageUrl.Substring(0, $ImageUrl.Length - $file.Length)) + 'SHA256SUMS'
  Write-Output "linux:throwaway: downloading $ImageUrl"
  # Windows PowerShell's progress bar slows a large download many times over; a dropped connection is retried.
  $ProgressPreference = 'SilentlyContinue'
  foreach ($dl in @(@($sumsUrl, (Join-Path $temp 'SHA256SUMS')), @($ImageUrl, $image))) {
    for ($attempt = 1; ; $attempt++) {
      try { Invoke-WebRequest -UseBasicParsing -Uri $dl[0] -OutFile $dl[1]; break } catch {
        if ($attempt -ge 3) { throw }
        Write-Output "linux:throwaway: download attempt $attempt failed ($($_.Exception.Message)); retrying"
        Start-Sleep -Seconds (5 * $attempt)
      }
    }
  }
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
  # Keep the distro running between steps (WSL stops an idle distro, and the agent with it).
  $keepalive = Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $Name, '-u', 'root', '--', 'sleep', 'infinity') -WindowStyle Hidden -PassThru

  if ($forwardPort -gt 0) {
    $gw = Find-DefaultGateway (Get-DistroOutput $Name 'ip route show default')
    if ($null -eq $gw) {
      $results['NAT forwarder'] = 'not met: the distro has no default gateway'
    } else {
      $pyFile = Join-Path $temp 'ia-t2-forward.py'
      $probeFile = Join-Path $temp 'ia-t2-probe.py'
      [System.IO.File]::WriteAllText($pyFile, ($forwarderPy -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
      [System.IO.File]::WriteAllText($probeFile, ($probePy -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
      $pyIn = ConvertTo-WslPath $pyFile
      $probeIn = ConvertTo-WslPath $probeFile
      $forwardStarted = $true
      $code = In-Distro $Name "install -m 0644 '$pyIn' /run/ia-t2-forward.py && systemd-run --unit=ia-t2-forward --collect --quiet /usr/bin/python3 -I -u /run/ia-t2-forward.py $gw $forwardPort"
      $results["NAT forwarder 127.0.0.1:$forwardPort -> ${gw}:$forwardPort started"] = ($code -eq 0)
      $results['api health through the forwarder'] = (In-Distro $Name "/usr/bin/python3 -I '$probeIn' $forwardPort") -eq 0
    }
  }

  $debIn = ConvertTo-WslPath $Deb
  $results['dpkg -i'] = (In-Distro $Name "dpkg -i '$debIn'") -eq 0
  $results['unit active after install'] = (In-Distro $Name 'sleep 2; systemctl is-active --quiet indiansassist-agent') -eq 0
  if ($EnrollConfig -ne '') {
    $cfgIn = ConvertTo-WslPath $EnrollConfig
    [void](In-Distro $Name "install -m 0600 '$cfgIn' /etc/indiansassist/enroll.iaconfig && systemctl restart indiansassist-agent")
    $results['enrolled (config.json has a deviceId)'] = (In-Distro $Name 'for i in $(seq 1 30); do grep -q deviceId /var/lib/indiansassist/config.json 2>/dev/null && exit 0; sleep 1; done; exit 1') -eq 0
    $results['enroll.iaconfig shredded'] = (In-Distro $Name '! test -e /etc/indiansassist/enroll.iaconfig') -eq 0
  } else {
    $results['enrolled'] = 'not met: no -EnrollConfig'
  }
  # Let the enrolled service open its socket and record NRestarts before it is killed.
  Start-Sleep -Seconds 5
  [void](In-Distro $Name 'systemctl kill -s SIGKILL indiansassist-agent')
  $results['Restart= brought it back'] = (In-Distro $Name 'sleep 8; systemctl is-active --quiet indiansassist-agent && test "$(systemctl show -p NRestarts --value indiansassist-agent)" -ge 1') -eq 0
  $results['watchdog_restarted recorded'] = (In-Distro $Name 'for i in $(seq 1 20); do journalctl -u indiansassist-agent --no-pager | grep -q "systemd restarted the service" && exit 0; sleep 1; done; exit 1') -eq 0
  if ($DeviceActionScript -ne '') {
    & $DeviceActionScript -Distro $Name
    $results['read-only device action'] = ($LASTEXITCODE -eq 0)
  } else {
    $results['read-only device action'] = 'not run: no -DeviceActionScript'
  }
  Write-Output 'linux:throwaway: the service journal (last 40 lines)'
  [void](In-Distro $Name 'journalctl -u indiansassist-agent --no-pager -n 40 -o short-monotonic')
  $results['dpkg --purge'] = (In-Distro $Name 'dpkg --purge indiansassist-agent') -eq 0
  $results['nothing remains'] = (In-Distro $Name '! test -e /var/lib/indiansassist && ! test -e /etc/indiansassist && ! test -e /usr/lib/indiansassist') -eq 0
} catch {
  $results['error'] = $_.Exception.Message
} finally {
  if ($imported -and $forwardStarted) {
    try {
      $results['NAT forwarder stopped'] = (In-Distro $Name 'systemctl stop ia-t2-forward 2>/dev/null; rm -f /run/ia-t2-forward.py; ! systemctl is-active --quiet ia-t2-forward') -eq 0
    } catch {
      $results['NAT forwarder stopped'] = "not confirmed: $($_.Exception.Message) (the unregister below ends it)"
    }
  }
  if ($null -ne $keepalive -and -not $keepalive.HasExited) { Stop-Process -Id $keepalive.Id -Force -ErrorAction SilentlyContinue }
  if ($imported) {
    Assert-ThrowawayTarget $Name
    & wsl.exe --terminate $Name
    & wsl.exe --unregister $Name
    $results['unregistered'] = -not (@(Get-WslDistroNames) -icontains $Name)
  }
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
$results.GetEnumerator() | ForEach-Object { Write-Output ("  {0}: {1}" -f $_.Key, $_.Value) }
$failed = @($results.Values | Where-Object { $_ -is [bool] -and -not $_ }).Count
if ($failed -eq 0 -and -not $results.Contains('error')) { exit 0 } else { exit 1 }
