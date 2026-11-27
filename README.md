# dsh-delete-chat

中文（本页默认语言） · [English](#english)

给 DeepSeek Harness（DSH）的会话列表加一个「**删除会话**」动作：在某一行的「⋯」菜单或右键菜单里点它，确认后把这次对话连同它的磁盘日志一起移出列表：整个会话目录进 Windows 回收站（默认），需要时从回收站「还原」即可；也可以配置成移入 `$DSH_HOME/session-trash/<时间戳>/`。

DSH 本身只有「归档」——归档只是把会话藏起来，日志还在。本插件补的是真正意义上的删除，同时保留了可恢复性。

## 为什么不是又一个离线脚本

同目录过去有一个 `dsh-delete-chat.bat`：它要求先**彻底退出** DSH，否则内存会话登记会和磁盘打架。插件的意义在于把同一套语义搬进运行时——不用退出、不用管理员权限、删完列表立刻消失。

## 你会看到什么

- 位置：会话行尾的「⋯」按钮与右键菜单里的 `contextMenu` 家族，和其它动作同一套渲染。
- 排序：`order: 700`，排在官方「归档会话（600）」之后，`separatorBefore: true` + `danger: true`，危险动作单独成组。
- 确认：点下去先弹一次原生确认框，写明「整目录移入 Windows 回收站，可从回收站还原」（配置成 trash/permanent 时文案跟着变）。
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
│  └─ delete-session.js # 纯文件逻辑：定位、系统回收站、rename、缓存清理
├─ client.js            # 浏览器半边：注册菜单、确认、调端点、刷新列表
├─ install.ps1 / uninstall.ps1
└─ test/                # node --test，18 个用例
```

数据流只有一条：

```
会话行菜单 (client.js)
  → POST /api/x-dsh-delete-chat/delete   { sessionId }
    → 宿主判存活（ctx.sessions.get）
    → 定位 <home>/sessions/<槽>/<sessionId>
    → 默认把整目录交给 Windows 回收站（SHFileOperation + FOF_ALLOWUNDO）
    → mode: trash 时 rename 到 <home>/session-trash/<stamp>/<槽>/<sessionId>（跨卷退化为 cp+rm）
    → 删 <home>/storages/session_projcache/sessions/<sessionId>.json
  ← { ok, mode, removed, alreadyGone }
→ ctx.sessions.refresh() → 列表消失 → contextMenus.notify
```

## 关键设计决定

1. **不写 `workspace.json`。** 工作区成员表里的 `sessionIds` 由 `WorkspaceEntity` 的 getter 按会话 header 索引过滤（`candidateMatches`），日志一消失，该 id 自然会从成员列表里掉出去；归档集合里的残留 id 对 `unarchiveSession` 是显式容忍的。反过来，从另一个进程改写运行中的注册表文件，会和它的内存状态互相覆盖——这正是旧 bat 脚本必须「先退出 DSH」的原因。
2. **只删冷会话。** 存活会话的目录正被 Agent 的写句柄握着；在 Windows 上要么回收站操作失败，要么删完之后内存里的日志和磁盘分叉。与其做「先停止、再等待、再删」的时序编排，不如明确拒绝并给出下一步（切走 / 归档）。
3. **整目录移动，而不是逐个文件 unlink。** 默认用 `SHFileOperation` + `FOF_ALLOWUNDO` 把整个会话目录交给 Windows 回收站：会话一次性消失，`session.lock`、zstd 分帧日志等细节原样保留，还原时连父目录一起重建；`mode: trash` 则退化成整目录 rename，布局与 bat 脚本一致。
4. **投影缓存一起清。** 列表行有 `sessionListMetadata` 投影提示，留着过期缓存会让侧栏闪一下幽灵行。
5. **浏览器不碰文件系统。** 路径校验、DSH_HOME 解析、rename 全在宿主；浏览器只发一个 id。路由挂在 `ctx.connection.fetch` 上，复用 DSH 的浏览器鉴权与信任边界；**精确路由只能注册在共享 `/api` 通道下**（connection 用 `endpointFromPath('/api', path)` 校验，`/x-...` 这种自造前缀会直接让宿主半边 apply 失败，界面只剩 404）。
6. **id 白名单。** `session-[A-Za-z0-9][A-Za-z0-9._-]{0,128}`，且以目录名精确回查，杜绝 `../` 之类穿越。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `home` | `$DSH_HOME` → `~/.dsh` | DSH 用户目录；只影响删哪个库 |
| `mode` | `recycle`（Windows）/`trash` | `recycle` 整目录进 Windows 回收站（可还原）；`trash` 进 `session-trash` 目录；`permanent` 直接删除 |

在 profile 的 `cordis.patch.yml` 里给 `delete-chat` 这一行写 `config` 即可。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本自己解析 `DSH_HOME`（`-DshHome` → 环境变量 → 桌面版 `<root>\data` → `~\.dsh`），然后在 profile 里做两件事：把 `dsh-delete-chat` 补进 `dsh.profile.bundles` 与 `link:` 依赖，并在 `node_modules` 下建指向本目录的链接。**不走 pnpm**——`dsh plugin add` 在搬过家的 profile 上会因 `ERR_PNPM_UNEXPECTED_STORE` 失败，而且它失败前会先删掉旧链接。清单改动前会备份 `package.json`，重复运行是幂等的。装完**完全退出** DSH 再打开。

完整步骤（含验证、使用、恢复、模式配置、卸载、排查）见 [docs/GUIDE.md](docs/GUIDE.md)。

卸载：`.\uninstall.ps1`（摘掉链接与清单条目，回收站内容不动）。

## 验证

```powershell
node --check client.js; node --check index.js
node --test test/delete-session.test.mjs test/host-smoke.test.mjs
```

当前状态：

- 18 个用例全绿：id 白名单、recycle/trash/permanent 三种模式、幂等重删、非法 id、home 缺失、配置优先级、HTTP 400/409/500 映射、诊断端点。
- `recycle` 用例真的把临时会话目录交给系统回收站（Windows），并断言原目录消失。
- 宿主端用例走的是真实 `Request`/`Response` 与真实临时目录，只用桩件替换 Cordis 的 `effect`/`connection`/`sessions`。
- 组合验证：把 desktop profile 复制成 `desktop-verify` 后 `dsh --profile desktop-verify --dump-config`，输出里出现
  `# == dsh-delete-chat` / `- id: delete-chat` / `name: dsh-delete-chat`，说明 bundle 补丁被 loader 正确展开。

没做的验证：真实桌面版里由人点「确定」的点击流程；「会话目录仍被短暂占用」时的重试体验。回收站还原由资源管理器完成，已手工确认过「父目录被删掉也能还原」。

## 已知限制

- 当前会话不能删：它是存活的。先切到别的会话，或先归档再删。
- 确认框用 `window.confirm`：够用但和 DSH 的 Modal 家族风格不一致，后续可以换成 slot 里的对话框组件。
- 恢复靠系统：默认模式下在资源管理器「回收站」里还原即可；`mode: trash` 才是手工把目录移回 `sessions/<槽>/`（插件不提供还原界面）。
- 回收站模式依赖 Windows 自身行为：如果该卷关掉了回收站，或者目录大过回收站配额，Windows 会直接永久删除，插件拦不住。需要绝对可恢复时用 mode: trash。
- 只覆盖 jsonl 持久化后端（当前桌面版默认）。换后端时 `delete-session.js` 的定位逻辑需要跟着换。
- 删掉子代理会话时，父会话目录里可能短暂保留一条 subagent 目录行，直到下一次列表基线。

## License

MIT，见 [LICENSE](LICENSE)。

---

## English

Adds a **Delete conversation** action to the DeepSeek Harness (DSH) session list: pick it from a row's `⋯` menu or the context menu, confirm, and the conversation plus its on-disk log leaves the list — the whole session folder goes to the Windows Recycle Bin by default (configurable to `$DSH_HOME/session-trash/<timestamp>/`), where you can restore it.

DSH ships **Archive** only, and archiving just hides a session while its log stays on disk. This plugin does the actual deletion without giving up recoverability.

### Why not another offline script

The old `dsh-delete-chat.bat` next to it demanded a **full quit** of DSH first; otherwise the in-memory session registry and the disk file would overwrite each other. The point of the plugin is to move the same semantics into the runtime: no quitting, no admin rights, and the row disappears the moment the delete succeeds.

### What you will see

- Placement: the `⋯` button at the end of a session row and the right-click menu both render from the same `contextMenu` family, so the action looks exactly like the built-ins.
- Order: `order: 700`, right after the built-in Archive (600), with `separatorBefore: true` + `danger: true` so the risky action sits in its own group.
- Confirm: a native confirmation dialog first, stating that the whole session folder moves into the Recycle Bin and can be restored from there (the wording follows the configured mode).
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
│  └─ delete-session.js # pure file logic: locate, Recycle Bin, rename, cache cleanup
├─ client.js            # browser half: registers the menu, confirms, calls the endpoint, refreshes the list
├─ install.ps1 / uninstall.ps1
└─ test/                # node --test, 18 cases
```

There is exactly one data flow:

```
session row menu (client.js)
  → POST /api/x-dsh-delete-chat/delete   { sessionId }
    → host checks liveness (ctx.sessions.get)
    → locate <home>/sessions/<slot>/<sessionId>
    → by default hand the whole folder to the Windows Recycle Bin (SHFileOperation + FOF_ALLOWUNDO)
    → with mode: trash, rename to <home>/session-trash/<stamp>/<slot>/<sessionId> (cp+rm across volumes)
    → delete <home>/storages/session_projcache/sessions/<sessionId>.json
  ← { ok, mode, removed, alreadyGone }
→ ctx.sessions.refresh() → row disappears → contextMenus.notify
```

### Design decisions

1. **No `workspace.json` writes.** A workspace entity's `sessionIds` getter filters by the session header index (`candidateMatches`), so once the log is gone the id drops out of the membership list by itself; leftover ids in the archived set are explicitly tolerated by `unarchiveSession`. Conversely, rewriting a live registry file from another process fights its in-memory state — which is exactly why the old bat script required quitting DSH.
2. **Cold sessions only.** A live session's directory is held by the Agent's write handle; on Windows the Recycle Bin call either fails or the in-memory log diverges from disk after the delete. Rather than choreographing "stop, wait, delete", the plugin refuses clearly and tells you the next step (switch away / archive).
3. **Whole-directory move, not per-file unlink.** By default `SHFileOperation` + `FOF_ALLOWUNDO` hands the entire session folder to the Windows Recycle Bin: the session disappears in one step, details such as `session.lock` and zstd-framed logs stay intact, and restoring recreates the parent folders; `mode: trash` degrades to a directory rename with the bat script's layout.
4. **The projection cache goes with it.** List rows carry `sessionListMetadata` projection hints, and a stale cache makes the sidebar flash a ghost row.
5. **The browser never touches the filesystem.** Path validation, DSH_HOME resolution and the rename all live in the host; the browser only sends an id. Routes hang off `ctx.connection.fetch`, reusing DSH's browser authentication and trust boundary; **an exact route must live under the shared `/api` channel** (connection validates it with `endpointFromPath('/api', path)`, and a self-invented prefix such as `/x-...` fails the whole host half at apply time, leaving the UI with 404s).
6. **Id whitelist.** `session-[A-Za-z0-9][A-Za-z0-9._-]{0,128}`, re-checked against the actual directory name, so nothing like `../` gets through.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `home` | `$DSH_HOME` → `~/.dsh` | The DSH user directory; only decides which store gets pruned |
| `mode` | `recycle` (Windows) / `trash` | `recycle` sends the whole folder to the Windows Recycle Bin; `trash` moves it into `session-trash`; `permanent` deletes outright |

Write a `config` block on the `delete-chat` row in the profile's `cordis.patch.yml`.

### Install

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The script resolves `DSH_HOME` itself (`-DshHome` → env var → desktop `<root>\data` → `~\.dsh`) and then does two things in the profile: it adds the `link:` dependency plus the `dsh-delete-chat` entry in `dsh.profile.bundles`, and it creates the `node_modules` link to this directory. It does **not** run pnpm: `dsh plugin add` fails with `ERR_PNPM_UNEXPECTED_STORE` on a profile whose `node_modules` was moved between drives, and it removes the working link before failing. The manifest is backed up before any change, and re-running is idempotent. **Fully quit** DSH afterwards, then reopen it.

Full walkthrough (verify, use, recovery, modes, uninstall, troubleshooting): [docs/GUIDE.md](docs/GUIDE.md).

To uninstall: `.\uninstall.ps1` (removes the link and the manifest entries; the trash contents are left alone).

### Verification

```powershell
node --check client.js; node --check index.js
node --test test/delete-session.test.mjs test/host-smoke.test.mjs
```

Current state:

- 18 tests green: id whitelist, all three modes (recycle/trash/permanent), idempotent re-delete, invalid id, missing home, configuration precedence, HTTP 400/409/500 mapping, the diagnostic endpoint.
- The `recycle` case really hands a temp session folder to the system Recycle Bin (Windows) and asserts the original folder is gone.
- The host tests use real `Request`/`Response` objects and real temp directories; only Cordis's `effect`/`connection`/`sessions` are stubbed.
- Composition check: copying the desktop profile to `desktop-verify` and running `dsh --profile desktop-verify --dump-config` prints
  `# == dsh-delete-chat` / `- id: delete-chat` / `name: dsh-delete-chat`, which means the loader expanded the bundle patch correctly.

Not verified: the click-through flow in the real desktop app (someone has to press that Confirm button), and the retry experience on Windows when the session directory is still briefly held open. Restoring from the Recycle Bin is Explorer's job; restoring after the empty parent folder was removed was checked by hand.

### Known limitations

- The current session cannot be deleted: it is live. Switch to another session, or archive it first.
- The confirmation uses `window.confirm`: serviceable, but not the DSH Modal family; a slot-based dialog can replace it later.
- Recovery is the OS's job: in the default mode restore the folder from the Recycle Bin in Explorer; with `mode: trash` move it back into `sessions/<slot>/` by hand (the plugin has no restore UI).
- Recycle Bin mode relies on Windows itself: if the bin is disabled for that volume, or the folder exceeds the bin quota, Windows deletes it permanently, and the plugin cannot intercept that. Use mode: trash when you need an absolute recovery guarantee.
- Only the jsonl persistence backend is covered (the current desktop default). Switching backends means changing the location logic in `delete-session.js`.
- Deleting a subagent session may leave a subagent directory row in the parent for a moment, until the next list baseline.

### License

MIT, see [LICENSE](LICENSE).

[↑ 中文](#dsh-delete-chat)
