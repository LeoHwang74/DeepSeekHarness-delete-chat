# Install dsh-delete-chat into a DSH profile.
#
# Usage (defaults to the desktop profile of the desktop app):
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -DshHome 'H:\DeepSeek Harness\data'
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
#
# How DSH discovers a bundle: the profile manifest lists the package name in
# dsh.profile.bundles and its location in dependencies, and node_modules\<name>
# points at the package directory. This script edits exactly those two places.
#
# It deliberately does not call `dsh plugin add`. That command runs pnpm inside the
# profile; on a profile whose node_modules was moved between drives pnpm refuses
# with ERR_PNPM_UNEXPECTED_STORE - and the official command would have removed the
# working link before failing. A `link:` install needs no package manager at all.
param(
  [string]$Profile = 'desktop',
  [string]$PluginDir = $PSScriptRoot,
  [string]$DshHome,
  [switch]$Uninstall,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-delete-chat'

function Resolve-Dsh {
  $command = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -ne $command) { return $command.Source }
  foreach ($candidate in @(
    'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
    "$env:ProgramFiles\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd",
    "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
  )) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

# <root>\app\resources\runtime\cli\bin\dsh.cmd -> <root>\app
function Get-AppDir([string]$Launcher) {
  $app = Split-Path -Parent $Launcher
  for ($i = 0; $i -lt 4; $i += 1) { $app = Split-Path -Parent $app }
  return $app
}

# Candidate DSH_HOMEs, most specific first:
#   1. -DshHome   2. $env:DSH_HOME   3. the desktop layout's <root>\data   4. ~\.dsh
# ~\.dsh is the CLI default. On this machine it no longer exists (the junction to
# the desktop layout's data directory was removed), so the <root>\data candidate is
# what keeps the install aimed at the profile the app actually loads.
function Get-DshHomeCandidates([string]$Launcher) {
  $candidates = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($DshHome)) { $candidates.Add($DshHome) }
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $candidates.Add($env:DSH_HOME) }
  if (-not [string]::IsNullOrWhiteSpace($Launcher)) {
    $candidates.Add((Join-Path (Split-Path -Parent (Get-AppDir $Launcher)) 'data'))
  }
  $candidates.Add((Join-Path $env:USERPROFILE '.dsh'))
  return ($candidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
}

# The app ships a Node runtime; it is only used to rewrite the profile manifest
# without the PowerShell 5.1 JSON formatting quirks.
function Resolve-Node([string]$Launcher) {
  if (-not [string]::IsNullOrWhiteSpace($Launcher)) {
    $candidate = Join-Path (Get-AppDir $Launcher) 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($null -ne $command) { return $command.Source }
  throw 'No Node runtime found: expected one inside the DeepSeek Harness app directory.'
}

<#
  Adds (or removes) the package in a profile manifest. Kept in Node so the file
  keeps 2-space JSON formatting and the exact property order.
#>
$ManifestEditor = @'
const fs = require('node:fs')
const [mode, file, spec] = process.argv.slice(2)
const name = 'dsh-delete-chat'
const raw = fs.readFileSync(file, 'utf8')
const data = JSON.parse(raw)
data.dsh = data.dsh || {}
data.dsh.profile = data.dsh.profile || {}
const bundles = Array.isArray(data.dsh.profile.bundles) ? data.dsh.profile.bundles : []
const dependencies = data.dependencies || {}
let changed = false
if (mode === 'install') {
  if (!bundles.includes(name)) { bundles.push(name); changed = true }
  if (dependencies[name] !== spec) {
    data.dependencies = data.dependencies || {}
    data.dependencies[name] = spec
    changed = true
  }
} else {
  const index = bundles.indexOf(name)
  if (index >= 0) { bundles.splice(index, 1); changed = true }
  if (Object.prototype.hasOwnProperty.call(dependencies, name)) {
    delete data.dependencies[name]
    changed = true
  }
}
data.dsh.profile.bundles = bundles
if (!changed) { console.log('manifest unchanged'); process.exit(0) }
fs.copyFileSync(file, file + '.bak-' + Date.now())
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
console.log('manifest updated (previous copy kept as .bak-<timestamp>)')
'@

function Edit-Manifest([string]$Node, [string]$ManifestPath, [string]$Mode, [string]$Spec) {
  $scriptPath = Join-Path $env:TEMP ("dsh-delete-chat-manifest-{0}.js" -f [guid]::NewGuid().ToString('N'))
  Set-Content -LiteralPath $scriptPath -Value $ManifestEditor -Encoding UTF8
  try {
    & $Node $scriptPath $Mode $ManifestPath $Spec
    if ($LASTEXITCODE -ne 0) { throw "manifest edit failed (exit $LASTEXITCODE)" }
  } finally {
    Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
  }
}

# Returns 'unchanged', 'symlink' or 'junction'.
function Set-PluginLink([string]$LinkPath, [string]$Target) {
  $existing = Get-Item -LiteralPath $LinkPath -Force -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    $current = @($existing.Target) | Select-Object -First 1
    if ($null -ne $current -and [string]::Equals([IO.Path]::GetFullPath($current), [IO.Path]::GetFullPath($Target), 'OrdinalIgnoreCase')) {
      return 'unchanged'
    }
    cmd /c rmdir "$LinkPath" | Out-Null
    if (Test-Path -LiteralPath $LinkPath) { throw "cannot replace existing node_modules\$PackageName (not a link?)" }
  }
  try {
    New-Item -ItemType SymbolicLink -Path $LinkPath -Target $Target -ErrorAction Stop | Out-Null
    return 'symlink'
  } catch {
    New-Item -ItemType Junction -Path $LinkPath -Target $Target -ErrorAction Stop | Out-Null
    return 'junction'
  }
}

$dsh = Resolve-Dsh
$candidates = @(Get-DshHomeCandidates $dsh)
$dshHome = $null
foreach ($candidate in $candidates) {
  if (Test-Path -LiteralPath (Join-Path $candidate "profiles\$Profile")) { $dshHome = $candidate; break }
}
if ($null -eq $dshHome) {
  throw "profile '$Profile' not found. Tried: $($candidates -join '; '). Pass -DshHome <dir> to point at the DSH user directory."
}

$profileDir = Join-Path $dshHome "profiles\$Profile"
$manifestPath = Join-Path $profileDir 'package.json'
$nodeModules = Join-Path $profileDir 'node_modules'
$linkPath = Join-Path $nodeModules $PackageName
$spec = "link:$($PluginDir -replace '\\', '/')"

Write-Output "== DSH_HOME: $dshHome"
Write-Output "== profile:  $profileDir"
Write-Output "== plugin:   $PluginDir"
Write-Output "== spec:     $spec"

if ($DryRun) {
  $current = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
  $linkState = if ($null -eq $current) { 'missing' } else { "$($current.LinkType) -> $($current.Target)" }
  Write-Output "== dry run: link now: $linkState"
  if ($Uninstall) {
    Write-Output '== dry run: would drop the bundles entry, the link: dependency and the node_modules link'
  } else {
    Write-Output '== dry run: would add the bundles entry, the link: dependency and the node_modules link if missing'
  }
  exit 0
}

if ($Uninstall) {
  if (Test-Path -LiteralPath $linkPath) {
    $current = Get-Item -LiteralPath $linkPath -Force
    if ($null -eq $current.LinkType) {
      throw "$linkPath is a real directory, not a link: refusing to delete it. Remove it by hand if it really is the plugin copy."
    }
    cmd /c rmdir "$linkPath" | Out-Null
    Write-Output '== link:     removed'
  } else {
    Write-Output '== link:     already absent'
  }
  Edit-Manifest (Resolve-Node $dsh) $manifestPath 'remove' $spec
  Write-Output ''
  Write-Output 'Uninstalled. Quit and reopen DeepSeek Harness and the "Delete conversation" menu is gone.'
  Write-Output "Already deleted conversations are untouched: the Recycle Bin, or $dshHome\session-trash for mode: trash."
  exit 0
}

Edit-Manifest (Resolve-Node $dsh) $manifestPath 'install' $spec

if (-not (Test-Path -LiteralPath $nodeModules)) { New-Item -ItemType Directory -Path $nodeModules | Out-Null }
$linkState = Set-PluginLink $linkPath $PluginDir
Write-Output "== link:     $linkState"

$resolved = Join-Path $linkPath 'package.json'
if (-not (Test-Path -LiteralPath $resolved)) { throw "install failed: $linkPath does not resolve to the plugin package" }
$version = (Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json).version
Write-Output "== installed dsh-delete-chat $version"

Write-Output ''
Write-Output 'Done. Fully quit DeepSeek Harness (tray icon -> Quit, then confirm nothing is left in Task Manager) and reopen it.'
Write-Output 'After reopening, a session row offers "Delete conversation" in its "..." menu and in the right-click menu.'
