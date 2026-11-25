# 卸载 dsh-delete-chat：插件管理器会把包与 bundles 条目一起摘掉。
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
param([string]$Profile = 'desktop')
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
  throw '找不到 dsh 启动器。'
}

& (Resolve-Dsh) plugin --profile $Profile remove dsh-delete-chat

Write-Output '已卸载。退出并重开 DeepSeek Harness 后，「删除会话」菜单消失。'
Write-Output "已经删掉的会话仍在 $env:USERPROFILE\.dsh\session-trash 里，需要的话手工移回 sessions 即可。"
