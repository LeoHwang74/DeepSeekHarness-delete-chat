/**
 * 会话删除的核心实现：只碰磁盘上的会话目录与投影缓存，不动 workspace.json。
 *
 * 为什么不动 workspace.json：`WorkspaceEntity.sessionIds` 的 getter 会按会话 header
 * 索引过滤（`entity.ts` 的 `candidateMatches`），会话日志一旦消失，该 id 就不再出现在
 * 成员列表里；而归档集合里的残留 id 对 unarchive 是显式容忍的（见 dsh-workspace 文档
 * 「恢复只是从归档集合中移除 id」）。反过来，插件进程外改写 workspace.json 会和
 * 运行中的注册表内存状态打架，得不偿失。
 *
 * 删除语义默认是「可恢复」：整个会话目录交给 Windows 回收站（`SHFileOperation` +
 * `FOF_ALLOWUNDO`），在资源管理器里点「还原」就能回到原位；也可以配置成移入
 * `<DSH_HOME>/session-trash/<时间戳>/`（与 dsh-delete-chat.bat 的布局一致）或永久删除。
 */
import { execFile } from 'node:child_process'
import { cp, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 默认删除模式：Windows 上进系统回收站，其它平台进自建 session-trash。 */
export const DEFAULT_MODE = process.platform === 'win32' ? 'recycle' : 'trash'

/** 会话 id 只允许 DSH 自己生成的那一种形状，避免任何路径穿越。 */
export const SESSION_ID_PATTERN = /^session-[A-Za-z0-9][A-Za-z0-9._-]{0,128}$/

/** 会话日志文件名（v1 起带版本号，也可能是 zstd）。仅用于旁路诊断，不参与删除判断。 */
export const SESSION_LOG_PATTERN = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/

/** 删除请求的稳定失败种类；客户端按 kind 给出可操作的提示。 */
export const DELETION_FAILURES = Object.freeze({
  invalid: 'invalid',
  live: 'live',
  missing: 'missing',
  locked: 'locked',
  root: 'root',
  recycle: 'recycle',
  internal: 'internal',
})

/** 带种类与补救建议的删除失败。 */
export class DeleteSessionError extends Error {
  /**
   * @param {string} kind - {@link DELETION_FAILURES} 中的一个。
   * @param {string} message - 面向用户的失败描述。
   * @param {string} [hint] - 补救建议。
   */
  constructor(kind, message, hint) {
    super(message)
    this.name = 'DeleteSessionError'
    this.kind = kind
    this.hint = hint
  }
}

/**
 * 解析 DSH_HOME：显式配置 > DSH_HOME 环境变量 > ~/.dsh。
 * @param {string} [configured] - 插件配置里的 home。
 * @returns {string} 绝对路径。
 */
export function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  const fromEnvironment = process.env.DSH_HOME
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') return resolve(fromEnvironment.trim())
  return join(homedir(), '.dsh')
}

/** 回收站目录名：ISO 时间里的冒号与点在 Windows 上是非法字符。 */
export function trashStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-')
}

/**
 * 校验一个外部传入的会话 id。
 * @param {unknown} value - 请求体里的 sessionId。
 * @returns {string} 合法的 id。
 * @throws {DeleteSessionError} id 非法时。
 */
export function assertSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new DeleteSessionError(DELETION_FAILURES.invalid, '会话 id 不合法。', '请从会话列表重新发起删除。')
  }
  return value
}

/**
 * 在 <home>/sessions/<工作目录槽>/ 下定位会话目录。
 * @param {string} home - DSH_HOME。
 * @param {string} sessionId - 已校验的 id。
 * @returns {Promise<Array<{ dir: string, cwdSlot: string, cwdDir: string }>>} 命中项（正常为 1 个）。
 * @throws {DeleteSessionError} 会话根目录不存在时。
 */
export async function findSessionDirs(home, sessionId) {
  const sessionsRoot = join(home, 'sessions')
  let entries
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new DeleteSessionError(DELETION_FAILURES.root, `找不到会话目录：${sessionsRoot}`, '请确认 DSH_HOME 指向 DeepSeek Harness 的用户目录。')
    }
    throw error
  }
  const matches = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // 槽名是宿主对工作目录路径的编码，可能是任意原文，这里只做拼接后回查真实目录。
    const candidate = join(sessionsRoot, entry.name, sessionId)
    let info
    try {
      info = await stat(candidate)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (info.isDirectory()) matches.push({ dir: candidate, cwdSlot: entry.name, cwdDir: join(sessionsRoot, entry.name) })
  }
  return matches
}

/**
 * 把一次会话目录移入回收站；跨卷时退化为复制后删除。
 * @param {string} dir - 会话目录。
 * @param {string} target - 回收站中的目标目录。
 * @returns {Promise<void>}
 */
async function moveToTrash(dir, target) {
  await mkdir(dirname(target), { recursive: true })
  try {
    await rename(dir, target)
  } catch (error) {
    // EXDEV: 配置的 home 与回收站不在同一卷；EPERM/EBUSY: 目录仍被宿主占用。
    if (error?.code === 'EXDEV') {
      await cp(dir, target, { recursive: true, force: true, errorOnExist: false })
      await rm(dir, { recursive: true, force: true })
      return
    }
    if (error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES') {
      throw new DeleteSessionError(
        DELETION_FAILURES.locked,
        '会话目录被占用，删除没有完成。',
        '该会话可能刚刚被打开或仍有后台任务在写它；请切换到别的会话、等任务结束再试。',
      )
    }
    throw error
  }
}

/**
 * 交给 Windows 回收站的 PowerShell 程序（`SHFileOperation` + `FOF_ALLOWUNDO`）。
 *
 * 整段脚本是常量，目标路径通过环境变量以 base64 传入，因此中文、空格、`~`、引号都不会
 * 参与任何命令行拼接；加了 `FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI`，
 * 后台删除不会弹出任何对话框（对话框会把没有窗口的宿主进程卡死）。
 * 路径超过 MAX_PATH 时 SHFileOperation 会失败，这里如实报错而不是悄悄改成永久删除。
 */
const RECYCLE_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$b64 = $env:DSH_DELETE_CHAT_TARGET
if ([string]::IsNullOrEmpty($b64)) { [Console]::Error.WriteLine('missing target'); exit 3 }
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
Add-Type -Namespace DshDeleteChat -Name Shell -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct SHFILEOPSTRUCT
{
  public IntPtr hwnd;
  public uint wFunc;
  [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
  [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
  public ushort fFlags;
  [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
  public IntPtr hNameMappings;
  [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
}
[DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern int SHFileOperation(ref SHFILEOPSTRUCT lpFileOp);
'@
$operation = New-Object DshDeleteChat.Shell+SHFILEOPSTRUCT
$operation.wFunc = 3
$operation.pFrom = $target + [char]0 + [char]0
$operation.fFlags = 0x40 -bor 0x10 -bor 0x4 -bor 0x400
$code = [DshDeleteChat.Shell]::SHFileOperation([ref]$operation)
[Console]::Out.WriteLine("code=$code aborted=$($operation.fAnyOperationsAborted)")
`

/** Windows 自带的 Windows PowerShell 5.1；不依赖 PATH，也不依赖 pwsh。 */
function windowsPowerShell() {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * 把整个目录移入 Windows 回收站（可还原到原路径）。
 * @param {string} dir - 会话目录。
 * @returns {Promise<void>}
 * @throws {DeleteSessionError} 平台不支持、PowerShell 调用失败或 SHFileOperation 失败时。
 */
async function recycleDirectory(dir) {
  if (process.platform !== 'win32') {
    throw new DeleteSessionError(
      DELETION_FAILURES.recycle,
      '系统回收站模式只支持 Windows。',
      '请把插件配置的 mode 改成 trash 或 permanent。',
    )
  }
  const encoded = Buffer.from(RECYCLE_SCRIPT, 'utf16le').toString('base64')
  let stdout = ''
  try {
    ({ stdout } = await new Promise((resolvePromise, rejectPromise) => {
      execFile(
        windowsPowerShell(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        {
          env: { ...process.env, DSH_DELETE_CHAT_TARGET: Buffer.from(dir, 'utf8').toString('base64') },
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
        },
        (error, out) => {
          if (error) rejectPromise(error)
          else resolvePromise({ stdout: out })
        },
      )
    }))
  } catch (error) {
    throw new DeleteSessionError(
      DELETION_FAILURES.recycle,
      `无法调用系统回收站：${error instanceof Error ? error.message : String(error)}`,
      '请稍后重试；也可以把插件配置的 mode 改成 trash。',
    )
  }

  const parsed = /code=(-?\d+)\s+aborted=(True|False)/i.exec(stdout)
  if (parsed === null) {
    throw new DeleteSessionError(
      DELETION_FAILURES.recycle,
      '系统回收站没有返回可识别的结果。',
      `PowerShell 输出：${stdout.trim().slice(0, 200) || '（空）'}`,
    )
  }
  const code = Number(parsed[1])
  const aborted = parsed[2].toLowerCase() === 'true'
  if (code !== 0 || aborted) {
    const reason = code === 0 ? '操作被取消' : `SHFileOperation 返回 0x${code.toString(16)}`
    throw new DeleteSessionError(
      DELETION_FAILURES.recycle,
      `移入回收站失败（${reason}）。`,
      '会话目录可能仍被占用；请切到别的会话、等任务结束再试。',
    )
  }
  // 成功码不等于目录真的走了：留一道复核，避免界面说「已删除」而文件还在。
  if (await stat(dir).then(() => true, () => false)) {
    throw new DeleteSessionError(
      DELETION_FAILURES.recycle,
      '移入回收站后目录仍然存在，删除没有完成。',
      '请稍后重试；也可以把插件配置的 mode 改成 trash。',
    )
  }
}

/**
 * 删除投影缓存行，避免列表里留下过期提示。
 * @param {string} home - DSH_HOME。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<string[]>} 实际删掉的缓存文件。
 */
async function dropProjectionCache(home, sessionId) {
  const removed = []
  const cacheFile = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    await rm(cacheFile, { force: false })
    removed.push(cacheFile)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return removed
}

/**
 * 删除一个已持久化的会话。
 * 调用方必须先确认会话不再存活——本函数不做存活性判断，只负责磁盘。
 * @param {object} options - 删除参数。
 * @param {string} options.home - DSH_HOME。
 * @param {string} options.sessionId - 会话 id。
 * @param {'recycle' | 'trash' | 'permanent'} [options.mode] - 系统回收站 / 自建 session-trash / 永久删除，默认 {@link DEFAULT_MODE}。
 * @param {Date} [options.now] - session-trash 时间戳来源，测试可注入。
 * @param {(line: string) => void} [options.warn] - 诊断通道。
 * @returns {Promise<{ mode: 'recycle' | 'trash' | 'permanent', removed: Array<{ path: string, cwdSlot: string, trashPath?: string }>, cacheFiles: string[], alreadyGone: boolean }>} 删除结果。
 * @throws {DeleteSessionError} 校验、占用、回收站或根目录失败时。
 */
export async function deleteSession({ home, sessionId, mode = DEFAULT_MODE, now = new Date(), warn }) {
  assertSessionId(sessionId)
  const matches = await findSessionDirs(home, sessionId)
  const cacheFiles = await dropProjectionCache(home, sessionId).catch((error) => {
    warn?.(`[delete-chat] 投影缓存清理失败：${String(error)}`)
    return []
  })
  if (matches.length === 0) {
    return { mode, removed: [], cacheFiles, alreadyGone: true }
  }
  const removed = []
  for (const match of matches) {
    if (mode === 'permanent') {
      await rm(match.dir, { recursive: true, force: false })
      removed.push({ path: match.dir, cwdSlot: match.cwdSlot })
    } else if (mode === 'recycle') {
      await recycleDirectory(match.dir)
      removed.push({ path: match.dir, cwdSlot: match.cwdSlot })
    } else {
      const target = join(home, 'session-trash', trashStamp(now), match.cwdSlot, sessionId)
      await moveToTrash(match.dir, target)
      removed.push({ path: match.dir, cwdSlot: match.cwdSlot, trashPath: target })
    }
  }
  // 空的「工作目录槽」目录留着只会让侧栏分组悬空；rmdir 只在目录为空时成功，
  // 同槽下还有别的会话时它会抛 ENOTEMPTY，这里按预期吞掉。
  for (const match of matches) {
    await rmdir(match.cwdDir).catch(() => {})
  }
  return { mode, removed, cacheFiles, alreadyGone: false }
}
