# dsh-delete-chat 安装与使用指南

> 适用版本：插件 **0.3.0**，Windows 上的 DeepSeek Harness **桌面版**（当前 0.2.2-rc.5 已验证）。
> 作用：给会话列表加一个「删除会话」动作——把整个会话目录移入 **Windows 回收站**，列表里立刻消失，随时可以还原。

## 目录

- [1. 它做什么，不做什么](#1-它做什么不做什么)
- [2. 安装前确认](#2-安装前确认)
- [3. 安装](#3-安装)
- [4. 验证安装](#4-验证安装)
- [5. 日常使用](#5-日常使用)
- [6. 删掉的会话去哪了，怎么恢复](#6-删掉的会话去哪了怎么恢复)
- [7. 配置：三种删除模式](#7-配置三种删除模式)
- [8. 卸载](#8-卸载)
- [9. 故障排查](#9-故障排查)
- [10. 常见问题](#10-常见问题)
- [11. 位置速查与版本记录](#11-位置速查与版本记录)

## 1. 它做什么，不做什么

**做**：

- 在会话行的「⋯」菜单和右键菜单里加一条红色的「删除会话」；
- 确认后把 `sessions\<工作目录槽>\<会话 id>\` 这整个目录移入 Windows 回收站（默认），列表立刻少一行；
- 同时清掉该会话的投影缓存，避免侧栏闪一下幽灵行。

**不做**：

- 不碰 `workspace.json`（DSH 的会话登记表），不改归档状态；
- 不删 DSH 账号里的任何东西——会话日志只在本机 `DSH_HOME` 里；
- 不删正在使用的会话（Agent 还开着），会明确拒绝。

和「归档」的区别：归档只是把会话藏起来、日志还在；本插件是真的把日志目录移走，但保留「可从回收站还原」。

## 2. 安装前确认

1. DeepSeek Harness 桌面版能正常打开，左侧栏能看到「插件」。
2. 插件目录在本机一个**固定位置**，例如：

   ```
   C:\Users\Administrator\Doubao\chats\2026-11-26\new-chat-1\dsh-delete-chat
   ```

   不要放在会被清理的临时目录；以后移动了目录，重新跑一次安装脚本即可。

3. 认识两个目录：

   | 名称 | 本机路径 | 说明 |
   |---|---|---|
   | 插件源码 | `C:\Users\Administrator\Doubao\chats\2026-11-26\new-chat-1\dsh-delete-chat` | 要改代码就改这里 |
   | DSH 数据目录（`DSH_HOME`） | `H:\DeepSeek Harness\data` | 会话、profile、配置都在这 |

   > ℹ️ `C:\Users\Administrator\.dsh` 原本是指向 `H:\DeepSeek Harness\data` 的**联接（junction）**，已于 2026-11-28 按要求移除（只删了指针，H: 的数据完好）。
   > 影响：现在从命令行直接跑 `dsh` 会新建一个空的 `~/.dsh` 并使用里面的 profile。**涉及这台机器的 profile 时，先设置** `$env:DSH_HOME = 'H:\DeepSeek Harness\data'`，或直接用本目录的 `install.ps1`（它会自动解析）。
   > 想恢复那个联接：`New-Item -ItemType Junction -Path C:\Users\Administrator\.dsh -Target 'H:\DeepSeek Harness\data'`。

## 3. 安装

### 3.1 最省事：双击一键安装脚本

如果拿到的是 `安装 dsh-delete-chat.bat`，把它放在桌面双击即可：

- 11 个插件文件以 base64 内嵌在脚本本身里，双击后解压到 `%LOCALAPPDATA%\dsh-delete-chat`；
- 随后按本指南同样的规则写 profile 清单、建 `node_modules` 链接（复用解压出来的 `install.ps1`）；
- 已经指向这份副本时只提示「无需重装」；要强制重装，在命令行带 `-Force` 运行该脚本；
- 全程不联网、不写注册表、不跑 pnpm；失败时窗口不会自动关闭，能看清原因。

### 3.2 命令行安装脚本

```powershell
cd C:\Users\Administrator\Doubao\chats\2026-11-26\new-chat-1\dsh-delete-chat
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本只做两件事（`link:` 安装不需要包管理器）：

1. 在 profile 清单 `<DSH_HOME>\profiles\desktop\package.json` 里补上 `dsh-delete-chat`：`dsh.profile.bundles` 增加一行，`dependencies` 写入 `link:<插件目录>`；
2. 在 `<DSH_HOME>\profiles\desktop\node_modules\dsh-delete-chat` 建一个指向插件目录的链接。

写入清单前会自动备份成 `package.json.bak-<时间戳>`；重复运行是幂等的（已安装就只报告 `manifest unchanged` / `link: unchanged`）。

**常用参数**：

| 参数 | 作用 |
|---|---|
| `-DryRun` | 只打印将要做什么，不落盘 |
| `-Profile web` | 装进另一个 profile（默认 `desktop`） |
| `-DshHome "D:\other-dsh"` | 指定另一个 DSH 数据目录 |

### 3.3 备选：官方插件命令

如果你更喜欢官方入口，等价命令是：

```powershell
dsh plugin --profile desktop add "link:C:/Users/Administrator/Doubao/chats/2026-11-26/new-chat-1/dsh-delete-chat"
```

它内部会跑 pnpm。**如果 profile 的 `node_modules` 曾经在不同盘之间搬过家**，pnpm 会报 `ERR_PNPM_UNEXPECTED_STORE`，更适合直接用 3.1 的脚本（脚本不走 pnpm，也不会在失败前先删掉已有的链接）。

### 3.4 装完必须重启

完全退出 DeepSeek Harness（托盘图标 → 退出，再到任务管理器确认没有 `DeepSeek Harness.exe` 残留），然后重新打开。只刷新页面不够：插件的宿主半边是在进程启动时挂载的。

## 4. 验证安装

1. **插件列表**：左侧栏「插件」→ 能看到 `dsh-delete-chat 0.3.0`，开关为开；没有「加载失败 / 未激活」的提示。
2. **菜单**：任意会话行尾的「⋯」或右键菜单，最底部应有单独的红色「删除会话」。
3. **命令行核对**（可选）：

   ```powershell
   $env:DSH_HOME = 'H:\DeepSeek Harness\data'   # 见第 2 节：~/.dsh 联接已移除
   dsh --profile desktop --dump-config | Select-String delete-chat
   ```

   能搜到 `- id: delete-chat` / `name: dsh-delete-chat` 说明 bundle 补丁被 loader 正确展开。

如果三步里有任何一步不成立，直接看[第 9 节](#9-故障排查)。

## 5. 日常使用

1. 在会话行点「⋯」（或右键）。
2. 选「删除会话」。
3. 确认框会写明去向，例如：
   > 删除会话「登录 sg-sgp11 服务器」？
   > 删除后，整个会话目录会移入 Windows 回收站，可以在资源管理器里「还原」；列表里立刻消失。
4. 点「确定」→ 该行消失，右下角提示「会话已删除，可在 Windows 回收站里还原。」

特殊情况：

- **正在使用的会话**会被拒绝：「这个会话正在使用中，无法删除。先切换到其他会话（或在侧栏归档它），让它的 Agent 退出后再删。」
- **重复删同一个会话**不算错误：提示「这个会话已经不在了，列表已刷新。」
- 删除失败时，提示会带上宿主的真实原因（被占用、回收站调用失败、HTTP 401/404 等），不是一句笼统的「失败」。

## 6. 删掉的会话去哪了，怎么恢复

| 模式 | 位置 | 恢复方式 |
|---|---|---|
| `recycle`（默认） | Windows 回收站 | 资源管理器 → 回收站 → 找到 `session-<id>` → 右键「还原」 |
| `trash` | `<DSH_HOME>\session-trash\<时间戳>\<工作目录槽>\<session-id>\` | 把该目录移回 `<DSH_HOME>\sessions\<工作目录槽>\`（目录名保持原样） |
| `permanent` | 无 | 不可恢复 |

要点：

- 回收站按**卷**存放：删 H: 上的会话，条目在 H: 的回收站里（`H:\$RECYCLE.BIN`），资源管理器的「回收站」会把各卷的条目列在一起。
- 从回收站还原时会连父目录一起重建；还原后回到侧栏可能需要按 F5 刷新，或重开 DSH。
- 会话 id 可以在行菜单「复制 Session ID」里拿到；它同时也是磁盘上的目录名。
- 想让删除**默认进回收站**（当前默认），保持 `mode: recycle` 即可；见下一节。

## 7. 配置：三种删除模式

在 profile 的 `cordis.patch.yml`（`<DSH_HOME>\profiles\desktop\cordis.patch.yml`）里，给 `delete-chat` 这一行追加配置：

```yaml
- id: delete-chat
  name: dsh-delete-chat
  config:
    mode: recycle        # recycle（默认）| trash | permanent
    # home: D:\other-dsh # 只有想删另一个 DSH 数据目录时才需要
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `recycle`（Windows） | `recycle`：整目录进 Windows 回收站；`trash`：进 `session-trash` 目录；`permanent`：直接删除 |
| `home` | `$DSH_HOME`，再退到 `~/.dsh` | 只影响去哪个数据目录找会话 |

保存后重启 DSH（或在「插件」页把 `dsh-delete-chat` 关掉再打开）生效。确认框和成功提示的文案会跟着模式变，不会说错地方。

> 注意：`recycle` 依赖 Windows 自身行为——如果该卷关掉了回收站，或目录超过回收站配额，Windows 会直接永久删除，插件拦不住。需要「绝对可恢复」时用 `mode: trash`。

## 8. 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

它会摘掉 `node_modules` 里的链接，并从 profile 清单里移除 `dsh-delete-chat`（同样先备份 `package.json`）；`-DryRun` 可先预览。之后重启 DSH，「删除会话」菜单消失。

卸载不会动已经删掉的会话：回收站里的、`session-trash` 里的都原样保留。想连插件源码一起清掉，直接删插件目录即可。

## 9. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 菜单里没有「删除会话」 | 插件没装、没启用，或装到了另一个 profile | 「插件」页确认 `dsh-delete-chat` 存在且为开；`install.ps1 -DryRun` 核对 profile 路径；重启 DSH |
| 「插件」页显示加载失败 | 宿主半边 apply 失败（例如旧版本的非法路由前缀） | 升级到 0.3.0 后重启；仍失败看该行的诊断文字 |
| 点确定后提示 `(HTTP 404)` | 宿主端路由没挂上，浏览器打到了不存在的端点 | 同上：确认版本 ≥ 0.3.0 并重启 |
| 提示 `(HTTP 401)` | 页面鉴权过期 | 关掉页面，用 DSH 给出的地址重新打开；或重启 DSH |
| 「这个会话正在使用中，无法删除」 | 会话仍被 Agent 持有 | 切到别的会话、等任务结束，或先归档再删 |
| 「会话目录被占用，删除没有完成」 | 有进程占着目录（Agent、杀毒、资源管理器预览） | 等一会儿重试；关掉占用它的程序 |
| 「移入回收站失败（SHFileOperation 返回 0x…）」 | 目录被占用、路径过长、该卷回收站不可用 | 重试；或在配置里改成 `mode: trash` |
| 「系统回收站模式只支持 Windows」 | 非 Windows 平台 | 改成 `mode: trash` 或 `permanent` |
| 删除成功但列表还在 | 列表基线没刷新 | F5；仍不行重启 DSH |
| 装完重启后插件不见了 | profile 清单被别的操作覆盖，或链接断了 | 重跑 `install.ps1`（幂等），确认 `node_modules\dsh-delete-chat` 能解析到插件目录 |

需要看细节时：

- 插件页那一行会显示 `failed` 及诊断文字；
- profile 的插件管理器日志在 `<DSH_HOME>\profiles\desktop\.plugin-manager\logs\`；
- 安装脚本会打印它实际使用的 `DSH_HOME`、profile 路径和链接状态——排查「装错地方」最快。

## 10. 常见问题

**Q：删错了能恢复吗？**
默认可以：回收站里找 `session-<id>` 还原。用 `permanent` 模式则不能。

**Q：会影响云端或其他设备吗？**
不会。插件只移动本机 `DSH_HOME\sessions` 下的目录。

**Q：回收站里找不到？**
依次确认：是否改成了 `trash` 模式（那就在 `session-trash`）；是否清空过回收站；是否是别的卷（H: 的条目在 H: 的回收站里）。

**Q：能一次删多个吗？**
插件界面一次一个。批量清理可以用同目录的 `dsh-delete-chat.bat`（需要先完全退出 DSH），它默认清理归档会话和空会话。

**Q：子代理会话删除后父会话里还留一行？**
父会话目录里可能短暂保留一条 subagent 目录行，下一次列表基线刷新就没了。

**Q：换了数据目录 / 换了电脑？**
插件按 `DSH_HOME` 定位会话；`install.ps1 -DshHome <目录>` 装到对应 profile，或在配置里写 `home`。

**Q：会把 `workspace.json` 改坏吗？**
不会，插件刻意不写它——列表成员是按会话 header 动态过滤的，日志没了，行自然消失。

## 11. 位置速查与版本记录

| 内容 | 位置 |
|---|---|
| 插件源码 | `C:\Users\Administrator\Doubao\chats\2026-11-26\new-chat-1\dsh-delete-chat` |
| profile 链接 | `H:\DeepSeek Harness\data\profiles\desktop\node_modules\dsh-delete-chat` |
| profile 清单 | `H:\DeepSeek Harness\data\profiles\desktop\package.json` |
| profile 配置覆盖 | `H:\DeepSeek Harness\data\profiles\desktop\cordis.patch.yml` |
| 会话日志 | `H:\DeepSeek Harness\data\sessions\<工作目录槽>\<会话 id>\` |
| 自建回收目录（`mode: trash`） | `H:\DeepSeek Harness\data\session-trash\<时间戳>\` |
| 测试 | `node --test test\delete-session.test.mjs test\host-smoke.test.mjs`（18 个用例） |

版本记录：

- **0.3.0**：默认改为整目录进 Windows 回收站（`SHFileOperation` + `FOF_ALLOWUNDO`），新增 `mode: recycle`；失败提示直接显示宿主原因。
- **0.2.2**：修复宿主端路由前缀（精确 Fetch 路由必须挂在 `/api` 通道下），此前表现为点「确定」后提示删除失败。
- **0.2.1**：首个可用版本（`session-trash` 回收目录）。
