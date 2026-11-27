# Uninstall dsh-delete-chat from a DSH profile.
#
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Profile web
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -DshHome 'H:\DeepSeek Harness\data'
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -DryRun
#
# The work is done by install.ps1 -Uninstall (manifest + node_modules link), so both
# directions resolve DSH_HOME and edit the same two places. This keeps the profiles'
# package.json formatting intact and never runs pnpm.
param(
  [string]$Profile = 'desktop',
  [string]$DshHome,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$arguments = @{ Profile = $Profile; Uninstall = $true; DryRun = [bool]$DryRun }
if (-not [string]::IsNullOrWhiteSpace($DshHome)) { $arguments['DshHome'] = $DshHome }
& (Join-Path $PSScriptRoot 'install.ps1') @arguments
exit $LASTEXITCODE
