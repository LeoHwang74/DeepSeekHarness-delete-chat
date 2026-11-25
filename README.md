# dsh-delete-chat

中文（本页默认语言） · [English](#english)

给 DeepSeek Harness（DSH）的会话列表加一个「**删除会话**」动作：在某一行的「⋯」菜单或右键菜单里点它，确认后把这次对话连同它的磁盘日志一起移出列表，推进 `$DSH_HOME/session-trash/<时间戳>/`，可以随时从磁盘捡回来。

DSH 本身只有「归档」——归档只是把会话藏起来，日志还在。本插件补的是真正意义上的删除，同时保留了可恢复性。

## 为什么不是又一个离线脚本

同目录过去有一个 `dsh-delete-chat.bat`：它要求先**彻底退出** DSH，否则内存会话登记会和磁盘打架。插件的意义在于把同一套语义搬进运行时——不用退出、不用管理员权限、删完列表立刻消失。

## 你会看到什么

- 位置：会话行尾的「⋯」按钮与右键菜单里的 `contextMenu` 家族，和其它动作同一套渲染。
- 排序：`order: 700`，排在官方「归档会话（600）」之后，`separatorBefore: true` + `danger: true`，危险动作单独成组。
- 确认：点下去先弹一次原生确认框，写明「会移入 session-trash，可从磁盘找回」。
- 结果：成功后列表重新拉基线，该行消失，右下角一条成功提示；重复删除同一个已消失的会话不算错误。
- 拒绝：当前正在使用（Agent 还活着）的会话会收到明确拒绝与补救建议，磁盘一点不动。

## 结构

```
dsh-delete-chat/
├─ package.json         # dsh.bundle.patch + dsh.client（web 半边与依赖包）
├─ cordis.patch.yml     # 往 profile 插一行 `dsh-delete-chat`
├─ index.js             # 宿主半边：装配端点、判存活、注册路由
├─ lib/
│  ├─ routes.js         # 请求校验、错误到 HTTP 的映射、诊断端点
│  └─ delete-session.js # 纯文件逻辑：定位、rename、缓存清理、回收站布局
├─ client.js            # 浏览器半边：注册菜单、确认、调端点、刷新列表
├─ install.ps1 / uninstall.ps1
└─ test/                # node --test，15 个用例
```

数据流只有一条：

```
会话行菜单 (client.js)
  → POST /x-dsh-delete-chat/delete   { sessionId }
    → 宿主判存活（ctx.sessions.get）
    → 定位 <home>/sessions/<槽>/<sessionId>
    → rename 到 <home>/session-trash/<stamp>/<槽>/<sessionId>（跨卷退化为 cp+rm）
    → 删 <home>/storages/session_projcache/sessions/<sessionId>.json
  ← { ok, mode, removed, alreadyGone }
→ ctx.sessions.refresh() → 列表消失 → contextMenus.notify
```

## 关键设计决定

1. **不写 `workspace.json`。** 工作区成员表里的 `sessionIds` 由 `WorkspaceEntity` 的 getter 按会话 header 索引过滤（`candidateMatches`），日志一消失，该 id 自然会从成员列表里掉出去；归档集合里的残留 id 对 `unarchiveSession` 是显式容忍的。反过来，从另一个进程改写运行中的注册表文件，会和它的内存状态互相覆盖——这正是旧 bat 脚本必须「先退出 DSH」的原因。
2. **只删冷会话。** 存活会话的目录正被 Agent 的写句柄握着；在 Windows 上要么 rename 失败，要么删完之后内存里的日志和磁盘分叉。与其做「先停止、再等待、再删」的时序编排，不如明确拒绝并给出下一步（切走 / 归档）。
3. **整目录 rename，而不是逐个文件 unlink。** 一次原子操作就完成「会话消失」，也顺手保住了 `session.lock`、zstd 分帧日志等实现细节的完整性；回收站布局与 bat 脚本一致，互相兼容。
4. **投影缓存一起清。** 列表行有 `sessionListMetadata` 投影提示，留着过期缓存会让侧栏闪一下幽灵行。
5. **浏览器不碰文件系统。** 路径校验、DSH_HOME 解析、rename 全在宿主；浏览器只发一个 id。路由挂在 `ctx.connection.fetch` 上，复用 DSH 的浏览器鉴权与信任边界。
6. **id 白名单。** `session-[A-Za-z0-9][A-Za-z0-9._-]{0,128}`，且以目录名精确回查，杜绝 `../` 之类穿越。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `home` | `$DSH_HOME` → `~/.dsh` | DSH 用户目录；只影响删哪个库 |
| `mode` | `trash` | `trash` 进回收站；`permanent` 直接 `rm -rf` 式删除 |

在 profile 的 `cordis.patch.yml` 里给 `delete-chat` 这一行写 `config` 即可。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

底层就是官方的 `dsh plugin --profile desktop add link:<本目录>`——它会把包链进 profile 的 `node_modules`，并把 `dsh-delete-chat` 追加进 `dsh.profile.bundles`。装完**完全退出** DSH 再打开。

卸载：`.\uninstall.ps1`（包与 bundles 条目一起摘掉，回收站内容不动）。

## 验证

```powershell
node --check client.js; node --check index.js
node --test test/delete-session.test.mjs test/host-smoke.test.mjs
```

当前状态：

- 15 个用例全绿：id 白名单、trash/permanent 两种模式、幂等重删、非法 id、home 缺失、配置优先级、HTTP 400/409 映射、诊断端点。
- 宿主端用例走的是真实 `Request`/`Response` 与真实临时目录，只用桩件替换 Cordis 的 `effect`/`connection`/`sessions`。
- 组合验证：把 desktop profile 复制成 `desktop-verify` 后 `dsh --profile desktop-verify --dump-config`，输出里出现
  `# == dsh-delete-chat` / `- id: delete-chat` / `name: dsh-delete-chat`，说明 bundle 补丁被 loader 正确展开。

没做的验证：真实桌面版里的点击流程（需要人点一次「确定」），以及 Windows 上「会话目录仍被短暂占用」时的重试体验。

## 已知限制

- 当前会话不能删：它是存活的。先切到别的会话，或先归档再删。
- 确认框用 `window.confirm`：够用但和 DSH 的 Modal 家族风格不一致，后续可以换成 slot 里的对话框组件。
- 回收站没有界面：恢复靠手工把目录移回 `sessions/<槽>/`。要界面的话，加一个 `list-trash` / `restore` 端点即可，回收站布局已经为此留好了。
- 只覆盖 jsonl 持久化后端（当前桌面版默认）。换后端时 `delete-session.js` 的定位逻辑需要跟着换。
- 删掉子代理会话时，父会话目录里可能短暂保留一条 subagent 目录行，直到下一次列表基线。

## License

MIT，见 [LICENSE](LICENSE)。

---

## English

Adds a **Delete conversation** action to the DeepSeek Harness (DSH) session list: pick it from a row's `⋯` menu or the context menu, confirm, and the conversation plus its on-disk log leaves the list — moved into `$DSH_HOME/session-trash/<timestamp>/`, where you can always pick it back up.

DSH ships **Archive** only, and archiving just hides a session while its log stays on disk. This plugin does the actual deletion without giving up recoverability.

### Why not another offline script

The old `dsh-delete-chat.bat` next to it demanded a **full quit** of DSH first; otherwise the in-memory session registry and the disk file would overwrite each other. The point of the plugin is to move the same semantics into the runtime: no quitting, no admin rights, and the row disappears the moment the delete succeeds.

### What you will see

- Placement: the `⋯` button at the end of a session row and the right-click menu both render from the same `contextMenu` family, so the action looks exactly like the built-ins.
- Order: `order: 700`, right after the built-in Archive (600), with `separatorBefore: true` + `danger: true` so the risky action sits in its own group.
- Confirm: a native confirmation dialog first, stating that the session moves into session-trash and remains recoverable from disk.
- Result: the list re-baselines, the row disappears, and a success toast appears; deleting an already-gone session is not treated as an error.
- Refusal: a session still in use (its Agent is alive) gets an explicit refusal plus the next step, and nothing on disk is touched.

### Layout

```
dsh-delete-chat/
├─ package.json         # dsh.bundle.patch + dsh.client (the web half and its dependency packages)
├─ cordis.patch.yml     # inserts one `dsh-delete-chat` row into the profile
├─ index.js             # host half: wires endpoints, checks liveness, registers routes
├─ lib/
│  ├─ routes.js         # request validation, error-to-HTTP mapping, the diagnostic endpoint
│  └─ delete-session.js # pure file logic: locate, rename, cache cleanup, trash layout
├─ client.js            # browser half: registers the menu, confirms, calls the endpoint, refreshes the list
├─ install.ps1 / uninstall.ps1
└─ test/                # node --test, 15 cases
```

There is exactly one data flow:

```
session row menu (client.js)
  → POST /x-dsh-delete-chat/delete   { sessionId }
    → host checks liveness (ctx.sessions.get)
    → locate <home>/sessions/<slot>/<sessionId>
    → rename to <home>/session-trash/<stamp>/<slot>/<sessionId> (cp+rm across volumes)
    → delete <home>/storages/session_projcache/sessions/<sessionId>.json
  ← { ok, mode, removed, alreadyGone }
→ ctx.sessions.refresh() → row disappears → contextMenus.notify
```

### Design decisions

1. **No `workspace.json` writes.** A workspace entity's `sessionIds` getter filters by the session header index (`candidateMatches`), so once the log is gone the id drops out of the membership list by itself; leftover ids in the archived set are explicitly tolerated by `unarchiveSession`. Conversely, rewriting a live registry file from another process fights its in-memory state — which is exactly why the old bat script required quitting DSH.
2. **Cold sessions only.** A live session's directory is held by the Agent's write handle; on Windows the rename either fails or the in-memory log diverges from disk after the delete. Rather than choreographing "stop, wait, delete", the plugin refuses clearly and tells you the next step (switch away / archive).
3. **Directory rename, not per-file unlink.** One atomic operation makes the session disappear, and it keeps implementation details such as `session.lock` and zstd-framed logs intact; the trash layout matches the bat script, so the two are interchangeable.
4. **The projection cache goes with it.** List rows carry `sessionListMetadata` projection hints, and a stale cache makes the sidebar flash a ghost row.
5. **The browser never touches the filesystem.** Path validation, DSH_HOME resolution and the rename all live in the host; the browser only sends an id. Routes hang off `ctx.connection.fetch`, reusing DSH's browser authentication and trust boundary.
6. **Id whitelist.** `session-[A-Za-z0-9][A-Za-z0-9._-]{0,128}`, re-checked against the actual directory name, so nothing like `../` gets through.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `home` | `$DSH_HOME` → `~/.dsh` | The DSH user directory; only decides which store gets pruned |
| `mode` | `trash` | `trash` moves to the trash folder; `permanent` deletes outright |

Write a `config` block on the `delete-chat` row in the profile's `cordis.patch.yml`.

### Install

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Under the hood it is the official `dsh plugin --profile desktop add link:<this dir>`, which links the package into the profile's `node_modules` and appends `dsh-delete-chat` to `dsh.profile.bundles`. **Fully quit** DSH afterwards, then reopen it.

To uninstall: `.\uninstall.ps1` (removes the package and the bundle entry; the trash contents are left alone).

### Verification

```powershell
node --check client.js; node --check index.js
node --test test/delete-session.test.mjs test/host-smoke.test.mjs
```

Current state:

- 15 tests green: id whitelist, both trash and permanent modes, idempotent re-delete, invalid id, missing home, configuration precedence, HTTP 400/409 mapping, the diagnostic endpoint.
- The host tests use real `Request`/`Response` objects and real temp directories; only Cordis's `effect`/`connection`/`sessions` are stubbed.
- Composition check: copying the desktop profile to `desktop-verify` and running `dsh --profile desktop-verify --dump-config` prints
  `# == dsh-delete-chat` / `- id: delete-chat` / `name: dsh-delete-chat`, which means the loader expanded the bundle patch correctly.

Not verified: the click-through flow in the real desktop app (someone has to press that Confirm button), and the retry experience on Windows when the session directory is still briefly held open.

### Known limitations

- The current session cannot be deleted: it is live. Switch to another session, or archive it first.
- The confirmation uses `window.confirm`: serviceable, but not the DSH Modal family; a slot-based dialog can replace it later.
- There is no UI over the trash: recovery means moving the directory back into `sessions/<slot>/` by hand. A `list-trash` / `restore` endpoint would be enough for a UI, and the trash layout already allows it.
- Only the jsonl persistence backend is covered (the current desktop default). Switching backends means changing the location logic in `delete-session.js`.
- Deleting a subagent session may leave a subagent directory row in the parent for a moment, until the next list baseline.

### License

MIT, see [LICENSE](LICENSE).

[↑ 中文](#dsh-delete-chat)
