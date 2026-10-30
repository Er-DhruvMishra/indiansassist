/**
 * The Phase C starter catalogue (docs/specs/phase-c-contracts.md section 8.6), seeded for a new org on a P3 plan and
 * by `scripts/seed-playbooks.mjs` for existing orgs. The bodies are byte-identical (LF line ends) to
 * `scripts/playbooks/*`; test/playbooks.test.ts asserts it so shipped and catalogue hashes agree. They take no
 * parameters (a parameterised body would read `$env:IA_PARAM_*` or a quoted `set`, section 8.1).
 */
import type { PlaybookInterpreter } from '@indiansassist/shared';

export type StarterPlaybook = {
  file: string;
  name: string;
  description: string;
  interpreter: PlaybookInterpreter;
  requiresElevation: boolean;
  timeoutSec: number;
  body: string;
};

const CLEAR_TEMP = [
  '# IndiansAssist starter playbook: Clear temp files.',
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$targets = @($env:TEMP, (Join-Path $env:SystemRoot 'Temp'))",
  '$freed = 0',
  'foreach ($dir in $targets) {',
  '  if (-not (Test-Path -LiteralPath $dir)) { continue }',
  '  Get-ChildItem -LiteralPath $dir -Force -Recurse -File | ForEach-Object {',
  '    $size = $_.Length',
  '    Remove-Item -LiteralPath $_.FullName -Force',
  '    if (-not (Test-Path -LiteralPath $_.FullName)) { $freed += $size }',
  '  }',
  '}',
  'Write-Output ("Freed {0:N1} MB" -f ($freed / 1MB))',
  '',
].join('\n');

const FLUSH_DNS = ['@echo off', 'rem IndiansAssist starter playbook: Flush DNS cache.', 'ipconfig /flushdns', ''].join('\n');

const RESTART_SPOOLER = [
  '# IndiansAssist starter playbook: Restart Print Spooler (needs elevation).',
  "$ErrorActionPreference = 'Stop'",
  'Restart-Service -Name Spooler -Force',
  'Get-Service -Name Spooler | Format-List Name, Status, StartType',
  '',
].join('\n');

const COLLECT_LOGS = [
  '# IndiansAssist starter playbook: Collect logs (zip), then offer the file to the Desk (never auto-sent).',
  "$ErrorActionPreference = 'Stop'",
  "$root = Join-Path $env:LOCALAPPDATA 'IndiansAssist'",
  "$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'",
  '$work = Join-Path $root "logs-$stamp"',
  'New-Item -ItemType Directory -Path $work -Force | Out-Null',
  '$since = (Get-Date).AddHours(-24)',
  "foreach ($log in 'System', 'Application') {",
  '  Get-WinEvent -FilterHashtable @{ LogName = $log; StartTime = $since } -ErrorAction SilentlyContinue |',
  '    Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, Message |',
  '    Export-Csv -LiteralPath (Join-Path $work "$log.csv") -NoTypeInformation -Encoding UTF8',
  '}',
  "ipconfig /all | Out-File -LiteralPath (Join-Path $work 'ipconfig.txt') -Encoding UTF8",
  "systeminfo | Out-File -LiteralPath (Join-Path $work 'systeminfo.txt') -Encoding UTF8",
  '$zip = "$work.zip"',
  "Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zip -Force",
  'Remove-Item -LiteralPath $work -Recurse -Force',
  'Write-Output "IA_FILE_OFFER $zip"',
  '',
].join('\n');

export const STARTER_PLAYBOOKS: readonly StarterPlaybook[] = [
  {
    file: 'clear-temp.ps1',
    name: 'Clear temp files',
    description: 'Removes files in the user and Windows temp folders (best effort) and reports the space freed.',
    interpreter: 'powershell',
    requiresElevation: false,
    timeoutSec: 120,
    body: CLEAR_TEMP,
  },
  {
    file: 'flush-dns.cmd',
    name: 'Flush DNS cache',
    description: 'Runs ipconfig /flushdns.',
    interpreter: 'cmd',
    requiresElevation: false,
    timeoutSec: 30,
    body: FLUSH_DNS,
  },
  {
    file: 'restart-spooler.ps1',
    name: 'Restart Print Spooler',
    description: 'Restarts the Print Spooler service and prints its status. Needs elevation.',
    interpreter: 'powershell',
    requiresElevation: true,
    timeoutSec: 60,
    body: RESTART_SPOOLER,
  },
  {
    file: 'collect-logs.ps1',
    name: 'Collect logs (zip)',
    description:
      'Exports 24 h of System and Application event logs plus ipconfig /all and systeminfo into a zip, then asks the Desk to send it.',
    interpreter: 'powershell',
    requiresElevation: false,
    timeoutSec: 180,
    body: COLLECT_LOGS,
  },
];
