# 把 dsh-delete-chat 装进一个 DSH profile。
#
# 用法（默认装进桌面版的 desktop profile）：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web
#
# 官方插件管理器 `dsh plugin add link:<目录>` 会同时做两件事：
#   1. 在 profile 的 node_modules 里放一个指向本目录的链接
#   2. 把包名追加进 package.json 的 dsh.profile.bundles（loader 才会读它的 cordis.patch.yml）
# 本脚本只补一件管理器不做的事：清掉可能残留的、指向已消失目录的同名旧链接。
param(
  [string]$Profile = 'desktop',
  [string]$PluginDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'

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
  throw '找不到 dsh 启动器：请把 DeepSeek Harness 装在默认位置，或把 dsh 加进 PATH。'
}

$dsh = Resolve-Dsh
$profileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') $Profile
if (-not (Test-Path -LiteralPath $profileDir)) { throw "profile 不存在：$profileDir" }

Write-Output "== dsh: $dsh"
Write-Output "== profile: $profileDir"
Write-Output "== plugin: $PluginDir"

# 清掉可能残留的、指向已消失目录的同名链接（插件目录搬家后很常见）。
$link = Join-Path $profileDir 'node_modules\dsh-delete-chat'
if (Test-Path -LiteralPath $link) {
  $item = Get-Item -LiteralPath $link -Force
  if ($null -ne $item.LinkType) {
    Write-Output "== 移除旧链接：$($item.Target)"
    if ($item.LinkType -eq 'SymbolicLink') { cmd /c rmdir "$link" } else { Remove-Item -LiteralPath $link -Force }
  }
}

& $dsh plugin --profile $Profile add "link:$($PluginDir -replace '\\','/')"
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（exit $LASTEXITCODE）" }

$manifestPath = Join-Path $profileDir 'package.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (@($manifest.dsh.profile.bundles) -notcontains 'dsh-delete-chat') {
  Write-Warning "bundles 里没有 dsh-delete-chat：请手动把这一行加进 $manifestPath 的 dsh.profile.bundles。"
} else {
  Write-Output '== bundles 已包含 dsh-delete-chat'
}

Write-Output ''
Write-Output '装好了。完全退出 DeepSeek Harness（托盘图标 → 退出，再到任务管理器确认没有残留），重新打开。'
Write-Output '打开后：会话列表某一行的「⋯」或右键菜单里会出现「删除会话」。'
