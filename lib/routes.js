/**
 * 浏览器侧 HTTP 端点：只做请求校验、存活性判断与响应序列化。
 *
 * 路由由 DSH 的 connection 层完成浏览器鉴权与信任边界，因此这里不再判一次身份；
 * 真正的文件操作全部在 delete-session.js 里，便于单测。
 */
import {
  DeleteSessionError,
  DELETION_FAILURES,
  deleteSession,
  assertSessionId,
  findSessionDirs,
} from './delete-session.js'

/**
 * 本插件的路由前缀。
 *
 * 必须挂在宿主的共享 `/api` 通道下：`ctx.connection.fetch.register()` 注册的是「精确路由」，
 * connection 用 `endpointFromPath('/api', path)` 校验路径，只有 `/api/<段>[/<段>]` 才合法，
 * 否则 apply 直接抛 `connection: invalid exact Fetch route`，整个宿主半边挂不起来（界面只剩 404）。
 */
export const ROUTE_PREFIX = '/api/x-dsh-delete-chat'

/** 请求体上限；一个删除请求只有 id，远小于它。 */
const MAX_BODY_BYTES = 8 * 1024

/**
 * JSON 响应，禁止缓存。
 * @param {unknown} value - 响应体。
 * @param {number} [status] - HTTP 状态码。
 * @returns {Response} 响应。
 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * 读取并校验 JSON 请求体。
 * @param {Request} request - 已鉴权的请求。
 * @returns {Promise<Record<string, unknown>>} 解析出的对象。
 * @throws {DeleteSessionError} 请求体不是 JSON 对象或过大时。
 */
async function readBody(request) {
  let text
  try {
    text = await request.text()
  } catch {
    throw new DeleteSessionError(DELETION_FAILURES.invalid, '无法读取请求体。', '请重试。')
  }
  if (text.length > MAX_BODY_BYTES) {
    throw new DeleteSessionError(DELETION_FAILURES.invalid, '请求体过大。', '请重试。')
  }
  let parsed
  try {
    parsed = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new DeleteSessionError(DELETION_FAILURES.invalid, '请求体不是合法 JSON。', '请重试。')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DeleteSessionError(DELETION_FAILURES.invalid, '请求体必须是 JSON 对象。', '请重试。')
  }
  return parsed
}

/**
 * 失败种类到 HTTP 状态码的映射；除参数错误外一律 200，让界面统一渲染语气一致的提示。
 * @param {string} kind - 失败种类。
 * @returns {number} HTTP 状态码。
 */
function statusFor(kind) {
  switch (kind) {
    case DELETION_FAILURES.invalid:
      return 400
    case DELETION_FAILURES.live:
    case DELETION_FAILURES.locked:
      return 409
    case DELETION_FAILURES.recycle:
      return 500
    default:
      return 200
  }
}

/**
 * 构造端点处理函数。
 * @param {object} deps - 依赖。
 * @param {() => string} deps.home - 当前 DSH_HOME。
 * @param {() => 'recycle' | 'trash' | 'permanent'} deps.mode - 配置的删除模式。
 * @param {(sessionId: string) => boolean} deps.isLive - 会话是否仍存活于本进程。
 * @param {(line: string) => void} [deps.warn] - 诊断通道。
 * @returns {{ delete: (request: Request) => Promise<Response>, status: (request: Request) => Promise<Response> }} 端点处理函数。
 */
export function createRouteHandlers({ home, mode, isLive, warn }) {
  /**
   * 把一个异常转成响应；未知异常只记日志，不回显内部细节。
   * @param {unknown} error - 抛出的异常。
   * @returns {Response} 响应。
   */
  const fail = (error) => {
    if (error instanceof DeleteSessionError) {
      return json({ ok: false, kind: error.kind, message: error.message, hint: error.hint }, statusFor(error.kind))
    }
    const message = error instanceof Error ? error.message : String(error)
    warn?.(`[delete-chat] ${message}`)
    return json({
      ok: false,
      kind: DELETION_FAILURES.internal,
      message: '删除失败，宿主返回了未预期的错误。',
      hint: message,
    })
  }

  return {
    /**
     * 删除一个会话。会话仍存活时拒绝——删掉一个正在被 Agent 写入的目录只会两头落空。
     * @param {Request} request - 已鉴权的请求。
     * @returns {Promise<Response>} 响应。
     */
    delete: async (request) => {
      try {
        const body = await readBody(request)
        const sessionId = assertSessionId(body.sessionId)
        if (isLive(sessionId)) {
          throw new DeleteSessionError(
            DELETION_FAILURES.live,
            '这个会话正在使用中，无法删除。',
            '先切换到其他会话（或在侧栏归档它），让它的 Agent 退出后再删。',
          )
        }
        const targetMode = mode()
        const result = await deleteSession({
          home: home(),
          sessionId,
          mode: targetMode,
          warn,
        })
        return json({
          ok: true,
          sessionId,
          mode: result.mode,
          alreadyGone: result.alreadyGone,
          removed: result.removed,
          cacheFiles: result.cacheFiles,
        })
      } catch (error) {
        return fail(error)
      }
    },

    /**
     * 面板/诊断用：当前 home、删除模式、以及某个会话是否还能找到（不做任何写入）。
     * @param {Request} request - 已鉴权的请求。
     * @returns {Promise<Response>} 响应。
     */
    status: async (request) => {
      try {
        const url = new URL(request.url)
        const sessionId = url.searchParams.get('sessionId')
        const found = sessionId === null ? null : (await findSessionDirs(home(), assertSessionId(sessionId))).map(item => item.dir)
        return json({
          ok: true,
          home: home(),
          mode: mode(),
          sessionId,
          live: sessionId === null ? null : isLive(sessionId),
          locations: found,
        })
      } catch (error) {
        return fail(error)
      }
    },
  }
}
