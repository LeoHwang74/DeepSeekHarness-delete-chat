/**
 * dsh-delete-chat 的浏览器半边。
 *
 * 只做一件事：往会话列表的菜单里追加「删除会话」，点下去先确认，再调宿主的
 * `/x-dsh-delete-chat/delete`，成功后让会话列表重新取一遍基线。
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
    /** 宿主端点，前缀与 index.js 的 ROUTE_PREFIX 一致。 */
    const ENDPOINT = '/x-dsh-delete-chat/delete'

    const zh = {
      'menu.delete': '删除会话',
      'menu.failure': '删除会话失败；会话可能正在使用，或目录被占用。',
      'confirm.title': '删除会话「{title}」？',
      'confirm.body': '会话会移入 DSH 的 session-trash 回收目录，可以从磁盘找回；列表里立刻消失。',
      'confirm.untitled': '未命名会话',
      'toast.done': '会话已删除，可在 session-trash 中找回。',
      'toast.gone': '这个会话已经不在了，列表已刷新。',
      'error.network': '宿主没有响应，删除没有执行。',
      'error.internal': '宿主内部错误，删除没有完成。',
    }

    const en = {
      'menu.delete': 'Delete conversation',
      'menu.failure': 'Delete failed; the conversation may be in use or its folder is locked.',
      'confirm.title': 'Delete conversation "{title}"?',
      'confirm.body': 'The conversation moves into DSH’s session-trash folder, so it can be recovered from disk. It disappears from the list immediately.',
      'confirm.untitled': 'Untitled conversation',
      'toast.done': 'Conversation deleted; recoverable from session-trash.',
      'toast.gone': 'That conversation was already gone; the list has been refreshed.',
      'error.network': 'The host did not respond, so nothing was deleted.',
      'error.internal': 'Host error; nothing was deleted.',
    }

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

    return {
      inject: ['contextMenus', 'locale', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-delete-chat: dictionaries')
        const t = ctx.locale.bind(NS)

        /**
         * 执行一次删除：确认 → 调用宿主 → 刷新列表 → 提示结果。
         * @param {string} sessionId - 菜单捕获的会话 id。
         * @param {string} displayTitle - 菜单捕获的显示标题。
         */
        async function removeSession(sessionId, displayTitle) {
          const title = typeof displayTitle === 'string' && displayTitle.trim() !== ''
            ? displayTitle.trim()
            : t('confirm.untitled')
          // 原生确认框：动作不可逆地改变列表，必须让用户点一次「确定」。
          if (!window.confirm(`${t('confirm.title', { title })}\n\n${t('confirm.body')}`)) return
          const result = await postJson(ENDPOINT, { sessionId })
          if (!result || result.ok !== true) {
            throw new Error(typeof result?.message === 'string' ? result.message : t('error.internal'))
          }
          await ctx.sessions.refresh()
          ctx.contextMenus.notify(result.alreadyGone ? t('toast.gone') : t('toast.done'), true)
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
