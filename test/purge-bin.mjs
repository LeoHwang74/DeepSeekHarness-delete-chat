/**
 * 测试辅助：把测试自己丢进系统回收站的临时目录彻底清掉。
 *
 * 回收站是用户的真实空间，测试不能留下垃圾；这里按名字精确匹配，只删 $R/$I 这一对文件，
 * 不动回收站里的其它条目，也不依赖资源管理器的本地化动词（还原/删除的措辞随语言变）。
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** Windows PowerShell 5.1；与插件运行期用的是同一个解释器。 */
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const PURGE_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$name = $env:DSH_PURGE_ITEM
if ([string]::IsNullOrEmpty($name)) { exit 2 }
$shell = New-Object -ComObject Shell.Application
$item = $shell.Namespace(10).Items() | Where-Object { $_.Name -eq $name } | Select-Object -First 1
if ($null -eq $item) { exit 0 }
$recycled = $item.Path
$leaf = Split-Path -Leaf $recycled
$info = Join-Path (Split-Path -Parent $recycled) ('$I' + $leaf.Substring(2))
Remove-Item -LiteralPath $recycled -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $info -Force -ErrorAction SilentlyContinue
exit 0
`

/**
 * 从回收站里彻底删除一个条目。
 * @param {string} name - 回收站中显示的文件夹名。
 * @returns {Promise<void>}
 */
export async function purgeRecycled(name) {
  if (process.platform !== 'win32') return
  const encoded = Buffer.from(PURGE_SCRIPT, 'utf16le').toString('base64')
  await new Promise((resolvePromise, rejectPromise) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: { ...process.env, DSH_PURGE_ITEM: name }, windowsHide: true, timeout: 30_000, encoding: 'utf8' },
      (error) => {
        if (error) rejectPromise(error)
        else resolvePromise()
      },
    )
  })
}
