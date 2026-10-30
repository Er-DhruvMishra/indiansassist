# IndiansAssist starter playbook: Restart Print Spooler (needs elevation).
$ErrorActionPreference = 'Stop'
Restart-Service -Name Spooler -Force
Get-Service -Name Spooler | Format-List Name, Status, StartType
