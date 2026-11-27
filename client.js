/**
 * dsh-delete-chat 的浏览器半边。
 *
 * 只做一件事：往会话列表的菜单里追加「删除会话」，点下去先确认，再调宿主的
 * `/api/x-dsh-delete-chat/delete`，成功后让会话列表重新取一遍基线。
 * 文件系统、路径校验、存活性判断全在宿主进程里，浏览器不碰。
 *
 * 菜单用 `contextMenus.register({ target: 'session' })` 结构化注册，因此同一个动作
 * 同时出现在行尾「⋯」菜单与右键菜单里，和官方 归档/重命名 一样走 `danger` 样式。
 */
window.__ModuleLoader__.load({
  id: 'dsh-delete-chat',
  factory(require) {
    /** 词典命名空间。 */
    const NS = 'deleteChat'
    /** 宿主删除端点，前缀与 index.js 的 ROUTE_PREFIX 一致。 */
    const ENDPOINT = '/api/x-dsh-delete-chat/delete'
    /** 诊断端点：只用来读当前的删除模式，好让确认框说真话。 */
    const STATUS_ENDPOINT = '/api/x-dsh-delete-chat/status'

    const zh = {
      'menu.delete': '删除会话',
      'menu.failure': '删除会话失败；会话可能正在使用，或目录被占用。',
      'confirm.title': '删除会话「{title}」？',
      'confirm.body.recycle': '删除后，整个会话目录会移入 Windows 回收站，可以在资源管理器里「还原」；列表里立刻消失。',
      'confirm.body.trash': '删除后，整个会话目录会移入 DSH 的 session-trash 目录，可以从磁盘找回；列表里立刻消失。',
      'confirm.body.permanent': '这个会话会被永久删除，不能恢复；列表里立刻消失。',
      'confirm.untitled': '未命名会话',
      'toast.recycle': '会话已删除，可在 Windows 回收站里还原。',
      'toast.trash': '会话已删除，可在 session-trash 中找回。',
      'toast.permanent': '会话已永久删除。',
      'toast.gone': '这个会话已经不在了，列表已刷新。',
      'error.network': '宿主没有响应或拒绝了这次请求，删除没有执行。',
      'error.internal': '宿主内部错误，删除没有完成。',
    }

    const en = {
      'menu.delete': 'Delete conversation',
      'menu.failure': 'Delete failed; the conversation may be in use or its folder is locked.',
      'confirm.title': 'Delete conversation "{title}"?',
      'confirm.body.recycle': 'The whole conversation folder moves into the Recycle Bin, where you can restore it from Explorer. It disappears from the list immediately.',
      'confirm.body.trash': 'The whole conversation folder moves into DSH’s session-trash directory, so it can be recovered from disk. It disappears from the list immediately.',
      'confirm.body.permanent': 'This conversation is deleted for good and cannot be recovered. It disappears from the list immediately.',
      'confirm.untitled': 'Untitled conversation',
      'toast.recycle': 'Conversation deleted; restore it from the Recycle Bin.',
      'toast.trash': 'Conversation deleted; recoverable from session-trash.',
      'toast.permanent': 'Conversation deleted permanently.',
      'toast.gone': 'That conversation was already gone; the list has been refreshed.',
      'error.network': 'The host did not answer or rejected the request, so nothing was deleted.',
      'error.internal': 'Host error; nothing was deleted.',
    }

    /** 宿主当前的删除模式；先按 Windows 默认值假设，读到状态后再校正。 */
    let mode = 'recycle'

    /** POST JSON；响应必须是 JSON，否则按 HTTP 错误抛出。 */
    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const raw = await response.text()
      if (raw === '') throw new Error(`HTTP ${String(response.status)}`)
      try {
        return JSON.parse(raw)
      } catch {
        throw new Error(`HTTP ${String(response.status)}`)
      }
    }

    /** 读一次宿主的删除模式；读不到就沿用默认文案，删除本身不受影响。 */
    async function loadMode() {
      try {
        const response = await fetch(STATUS_ENDPOINT, { headers: { accept: 'application/json' } })
        if (!response.ok) return
        const payload = await response.json()
        if (payload?.ok === true && ['recycle', 'trash', 'permanent'].includes(payload.mode)) {
          mode = payload.mode
        }
      } catch {
        // 诊断端点不可用不是错误：删除结果里的 mode 才是权威值。
      }
    }

    return {
      inject: ['contextMenus', 'locale', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-delete-chat: dictionaries')
        const t = ctx.locale.bind(NS)
        void loadMode()

        /**
         * 执行一次删除：确认 → 调用宿主 → 刷新列表 → 提示结果。
         *
         * 失败必须是「说清楚为什么」：菜单的 failureLabel 只是一句通用兜底，
         * 真正的原因（会话还在用、目录被占用、回收站调用失败）只有宿主知道，
         * 所以这里把宿主的 message + hint 原样交给使用者，而不是一律抛回通用文案。
         * @param {string} sessionId - 菜单捕获的会话 id。
         * @param {string} displayTitle - 菜单捕获的显示标题。
         */
        async function removeSession(sessionId, displayTitle) {
          const title = typeof displayTitle === 'string' && displayTitle.trim() !== ''
            ? displayTitle.trim()
            : t('confirm.untitled')
          // 原生确认框：动作不可逆地改变列表，必须让用户点一次「确定」。
          if (!window.confirm(`${t('confirm.title', { title })}\n\n${t(`confirm.body.${mode}`)}`)) return
          const report = (text) => ctx.contextMenus.notify(text, false)
          let result
          try {
            result = await postJson(ENDPOINT, { sessionId })
          } catch (error) {
            // fetch 被拒或响应不是 JSON（例如 401/404 的纯文本/HTML 页）：删除没有执行。
            const detail = error instanceof Error && error.message !== '' ? ` (${error.message})` : ''
            report(`${t('error.network')}${detail}`)
            return
          }
          if (!result || result.ok !== true) {
            const message = typeof result?.message === 'string' && result.message !== ''
              ? result.message
              : t('error.internal')
            const hint = typeof result?.hint === 'string' && result.hint !== '' ? ` ${result.hint}` : ''
            report(`${message}${hint}`)
            return
          }
          await ctx.sessions.refresh()
          const done = result.mode === 'recycle'
            ? 'toast.recycle'
            : result.mode === 'permanent'
              ? 'toast.permanent'
              : 'toast.trash'
          ctx.contextMenus.notify(result.alreadyGone ? t('toast.gone') : t(done), true)
        }

        ctx.effect(() => ctx.contextMenus.register({
          id: 'delete-chat.delete',
          target: 'session',
          // 排在官方 归档(600) 之后、最底部，作为危险动作与常规操作隔开。
          order: 700,
          resolve: (target) => [{
            id: 'delete',
            label: t('menu.delete'),
            danger: true,
            separatorBefore: true,
            failureLabel: t('menu.failure'),
            run: () => removeSession(target.sessionId, target.displayTitle),
          }],
        }), 'dsh-delete-chat: session menu')
      },
    }
  },
})
