/**
 * dsh-delete-chat 的宿主半边。
 *
 * 分工：本文件只做装配——解析配置、判断会话存活性、注册浏览器端点；
 * 文件操作在 [lib/delete-session.js](lib/delete-session.js)，请求校验在 [lib/routes.js](lib/routes.js)。
 * 浏览器半边（package.json 的 `dsh.client`）在聊天列表里注册「删除会话」动作。
 *
 * 以工作区目录安装时（profile 里是指向本目录的链接），链接目录的真实路径在 profile 之外，
 * 裸包名解析不到随 DSH 发布的 `@deepseek-ai/*`，因此这里只 import 相对路径与 node 内置模块。
 */
import { createRouteHandlers, ROUTE_PREFIX } from './lib/routes.js'
import { DEFAULT_MODE, resolveDshHome } from './lib/delete-session.js'

/** 插件名，loader 诊断用。 */
export const name = 'delete-chat'

/** 硬依赖：会话服务决定「还能不能删」，没有它不许半挂载。 */
export const inject = ['connection', 'sessions']

/** 默认删除模式（Windows 进系统回收站）；见 lib/delete-session.js 的 `DEFAULT_MODE`。 */
export { DEFAULT_MODE }

/** 允许的删除模式；配置写错时退回默认值，而不是把未知值一路传到文件操作里。 */
const MODES = new Set(['recycle', 'trash', 'permanent'])

/**
 * 读取一行配置。
 * @param {unknown} config - loader 传入的配置。
 * @returns {{ home: () => string, mode: () => 'recycle' | 'trash' | 'permanent' }} 归一化后的访问器。
 */
function settings(config) {
  const options = config !== null && typeof config === 'object' ? config : {}
  return {
    // 每次请求现读：loader 改本行配置会重挂插件，但现读让值永远不滞后。
    home: () => resolveDshHome(typeof options.home === 'string' ? options.home : undefined),
    mode: () => (typeof options.mode === 'string' && MODES.has(options.mode) ? options.mode : DEFAULT_MODE),
  }
}

/**
 * 装配宿主端点。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {Record<string, unknown>} [config] 本行配置。
 */
export function apply(ctx, config) {
  const options = settings(config)
  const warn = (line) => {
    try {
      ctx.logger?.warn?.(line)
    } catch {
      // 诊断通道缺失不应成为故障源。
    }
  }

  const handlers = createRouteHandlers({
    home: options.home,
    mode: options.mode,
    // 存活会话的目录正被 Agent 写盘：先删文件会让内存状态与磁盘分叉，直接拒绝最安全。
    isLive: (sessionId) => ctx.sessions.get(sessionId) !== undefined,
    warn,
  })

  ctx.effect(() => {
    const disposers = [
      ctx.connection.fetch.register({
        path: `${ROUTE_PREFIX}/delete`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handlers.delete,
      }),
      ctx.connection.fetch.register({
        path: `${ROUTE_PREFIX}/status`,
        methods: ['GET'],
        fetch: handlers.status,
      }),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          void dispose()
        } catch {
          // 撤销失败留在 fiber 侧兜底，不阻断卸载。
        }
      }
    }
  }, 'delete-chat: browser routes')
}
