# dsh-windows-notify

给 DeepSeek Harness 加「**需要你操作**」的 Windows 原生通知，并且**点通知就回到 DSH**。

- 对话卡在**要权限**（命令/文件操作需要批准）时弹通知：`pwsh 想执行一条命令，需要你确认权限`
  —— 而且是**可直接回答的通知**：上面两个按钮「**允许 / 拒绝**」，点一下这次审批就结算了，
  不必再切回 DSH 界面
- 对话卡在**要你回答**（AI 提问 / 计划确认）时弹通知，带选项预览
- 可选：**一轮回复结束**、**会话出错**时弹通知（默认只开错误）
- 通知走 Windows 10/11 的 Toast（操作中心可见、可设**显示时间限制**自动消失）
- 点击通知（或点通知上的「打开 DSH」按钮）→ 唤起 DSH 主窗口：最小化会还原、后台会置前
- 给 AI 一个**写通知的 API**：模型工具 `notify_user`、HTTP 接口、`ctx.windowsNotify` 服务

## 触发时机

| 状态 | DSH 事件 | 默认 |
| --- | --- | --- |
| 需要授权（沙箱升级 / 工具需要批准） | `approval/request` | 开（**带允许 / 拒绝按钮**） |
| AI 向你提问（含计划确认） | `user-questions/request` | 开 |
| 一轮回复结束 | `agent/turn-stopping` | 关（`notifyTurnEnd` 打开） |
| 会话出错 | `agent/error` | 开 |

同类通知会按 `tag` 互相替换，并有去重（同一 tag 4 秒内不重复）与限流（默认每分钟 20 条），
避免刷屏；但**带按钮的权限通知每条一个独立 tag**——两个待你回答的审批必须是两条通知，
否则会互相覆盖、没法分别回答。

## 安装

### 从 GitHub（推荐）

```powershell
# 浏览器 / 带 profile CLI 的部署（web profile 等）
dsh plugin --profile <profile> add https://github.com/airenburen/dsh-windows-notify

# 桌面端（Electron）跑保留 profile desktop，CLI 被硬拒，只能用 GUI：
#   侧栏「插件」→ 安装 → 填同一个 git 地址
```

装完**重启宿主**（客户端半边是已构建的 bundle，宿主会缓存模块），然后：
设置 → 左侧导航「通知」（或按下面的其它入口）。

### 从本地目录（开发用）

`tools/install-desktop.mjs` 会把本目录以 `link:` 方式装进 desktop profile：

```powershell
cd <本目录>
node tools/install-desktop.mjs
```

它做的事：备份 profile 配置 → `pnpm add link:<本目录>`（失败则退回目录联接）→ 写
`dsh.profile.bundles` → 从 profile 里真实 `import` 一次插件 → 跑 `test/smoke.mjs`。

装好之后，`~/.dsh/profiles/desktop/package.json` 里会有：

```json
"dependencies": { "dsh-windows-notify": "link:<本目录>" },
"dsh": { "profile": { "bundles": [ "...", "dsh-windows-notify" ] } }
```

> **开发时的一个坑**：以 `link:` 装进来时，Node 会按真实路径解析裸导入，所以要给本目录做一个
> `node_modules` 目录联接（指向 profile 的 `node_modules`）才能找到
> `@deepseek-ai/schemastery` 等依赖；`install-desktop.mjs` 会自动处理。
>
> pnpm 11 默认的 `minimumReleaseAge` 供应链校验会拿**既有 lockfile 里已装好的**条目报错并中断收尾，
> 脚本因此带 `--config.minimumReleaseAge=0`（只影响这次安装，不会下载任何新包）。

## 配置

**主入口：设置 → 左侧导航「通知」**（DSH 原生设置页，order 55，排在「插件市场」后面）。

> 这是 DSH 自己的槽位机制：客户端半边注册一格
> `settings.section`（`{ id: 'dsh-windows-notify', order: 55, label }`）就多一页 ——
> `dsh-market` 的「插件市场」页是同一套做法。**用自己的 id**：复用别人的 id 会把对方那一页顶掉。
> 这一格不依赖任何第三方插件，better-sidebar 卸了也照样在。

**另一处入口：设置 → 侧边栏卡片 → 找到「通知」卡片 → 卡片上的齿轮**（DSH-better-sidebar 的设置页）。

> better-sidebar 给每个注册的 tab 类型在它的设置页放一张卡片，卡片的齿轮渲染
> `settings.render`；所以插件用
> `ctx.betterSidebar.registerTab({ ..., hidden: true, settings: { render } })` 把**同一份面板**
> 也挂在那里。`hidden: true` 是编辑器 / diff 内置类型的同一套路：**有设置卡片，但不往 DSH 原生
> 「+」菜单里添一个用不上的侧栏页**。
>
> 没装 better-sidebar 的部署会**自动退回**插件行配置页（侧栏「插件」→ 已安装 →
> `dsh-windows-notify` → 行上的「配置」）。三处入口共用同一个面板与同一份配置。

面板里的字段（全部 `.volatile()`，改完立即生效）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 状态通知总开关（不影响 AI/脚本的显式通知） |
| `notifyApproval` | `true` | 要权限时通知 |
| `notifyQuestion` | `true` | AI 提问时通知 |
| `notifyTurnEnd` | `false` | 一轮回复结束时通知 |
| `notifyError` | `true` | 会话出错时通知 |
| `agentTool` | `true` | 注册 `notify_user` 工具（改后需重载插件） |
| `httpApi` | `true` | 开启 `/plugins/dsh-windows-notify/*` 路由 |
| `focusOnClick` | `true` | 点击通知回到 DSH |
| `sound` | `true` | 提示音 |
| `displaySeconds` | `10` | **显示时间限制**：到点自动从屏幕与操作中心移除；`0` = 不限制 |
| `sticky` | `false` | 状态通知用系统「提醒」样式常驻（**仅当 `displaySeconds = 0` 时生效**） |
| `decisionButtons` | `true` | 权限通知带「允许 / 拒绝」按钮 |
| `decisionSeconds` | `300` | 按钮可点窗口（也会写进通知的显示时限）；`0` = 跟随 `displaySeconds` |
| `decisionButtonsFor` | `safe-only` | 哪些审批带按钮：`safe-only` = 高危的 `danger-full-access` **不发按钮**（只提示去界面确认），`all` = 全都发 |
| `whenFocused` | `silent` | **DSH 在前台时**怎么办：`silent` = 只进操作中心（`SuppressPopup`：不弹横幅、不响铃）、`skip` = 完全不发（历史仍记录）、`notify` = 照常弹。只作用于自动状态通知，`notify_user`/HTTP 的显式通知照常弹 |
| `language` | `zh` | `zh` / `en` |
| `aumid` | `com.deepseek.dsh` | 通知来源 AppUserModelID（桌面版开始菜单里的 AppID） |
| `dedupeMs` | `4000` | 同 tag 去重窗口 |
| `maxPerMinute` | `20` | 每分钟上限 |
| `debugLog` | `false` | 打印每条通知的调试日志 |

### 前后台：DSH 在前台时不打扰（`whenFocused`）

宿主是**独立 Node 进程**（`ELECTRON_RUN_AS_NODE`），拿不到 Electron 的窗口状态，`webServer`
也不暴露窗口信息——所以判定来自**渲染进程**：客户端半边监听 `focus`/`blur`/
`visibilitychange`，每次焦点变化上报一次，平时每 15 秒心跳一次
（`POST /plugins/dsh-windows-notify/focus`，只接受本机回环）。

「前台」= `visibilityState === 'visible' && document.hasFocus()`；宿主侧 **45 秒**
（`FOCUS_TTL_MS`）收不到消息就当作后台——页面关掉、崩溃、换机器都不会把通知永久压住。
多窗口各报各的，取「有一个在前台」。

命中前台时按 `whenFocused` 处理：

- **`silent`（默认）**：给 toast 设 `ToastNotification.SuppressPopup = $true`——**不弹横幅、
  不响铃，但通知照旧进操作中心**（它上面的按钮也照旧可用）。既不看横幅、又不会漏，还顺手
  消掉了「横幅弹在光标下被误点」的隐患。
- **`skip`**：完全不发，历史里记一条 `skipped: "foreground"`（侧栏「通知」页能看到）。
- **`notify`**：回到老行为，一律弹。

只有 4 类**自动状态通知**受这个策略约束；`notify_user`、HTTP `/send`、
`ctx.windowsNotify.send` 这类**显式**通知永远照常弹（那是「我就是要提醒你」）。
`/status` 里的 `focus` 字段（`foreground` / `policy` / `windows` / `ttlMs`）可以在侧栏
「通知」页直接看到当前判定。

### 显示时间限制是怎么做到的

Windows 里两件事是分开的：`duration` 只决定**横幅**在屏幕上停多久（short ≈ 7 秒 / long ≈ 25 秒），
而 `scenario="reminder"`（「提醒」样式）根本不自动下屏——这正是之前通知「一直显示」的原因。
真正能把通知撤掉的是 `ToastNotification.ExpirationTime`：到点后系统把它从屏幕**和操作中心**一并移除。

所以：

- `displaySeconds > 0`（默认 10）→ 给每条 toast 设 `ExpirationTime = now + N`；同时**强制关掉**
  「提醒」样式（否则它会顶掉时限），`N > 25` 时用 `long` 横幅，否则 `short`。
- `displaySeconds = 0` → 不设 `ExpirationTime`，此时 `sticky` 才起作用（状态通知用「提醒」
  样式，一直挂在屏幕上等你处理）。
- 这个上限对**所有**通知生效，包括 AI 主动调 `notify_user(..., sticky=true)` 的那条。

`node test/windows.mjs --expire` 会发两条真通知（一条设 6 秒时限、一条不设），12 秒后回读
操作中心，验证设了时限的那条已被移除、对照那条还在。

### 「允许 / 拒绝」按钮是怎么把答案传回来的

通知上的按钮只能激活一个 URI，所以链路是这样接的：

1. 审批通知渲染成 `<actions>` 里两个按钮：`dsh-notify:allow/<16位随机token>` /
   `dsh-notify:reject/<token>`，按钮配色用 `hint-button-style`（允许=Success / 拒绝=Critical），
   点通知正文仍然是回到 DSH（`dsh://open`）。
2. 插件把宿主半边注册的 `dsh-notify:` 协议指向一个隐藏 PowerShell 启动器
   （`%LOCALAPPDATA%\dsh-windows-notify\decision.ps1`）——它把 URI 解析成
   `POST <宿主地址>/plugins/dsh-windows-notify/decision?token=…&choice=allow|reject`。
   这条通道**独立于**回 DSH 用的 `dsh:` 协议，所以两边互不影响。
   启动器脚本里要写死宿主地址，而这个地址**只能从请求上取**：`webServer` 服务不暴露端口，
   宿主进程里也没有 `DSH_WEB_URL`（那是 DSH 注入给 shell 子进程的）。所以插件在每条路由里
   记下 `req.socket.localPort`（服务端监听端口，比 Host 头可靠——桌面端页面的请求是
   Electron 主进程转发过来的），客户端半边在页面加载时还会 ping 一次 `/hello`，
   把地址尽早送过来。
3. 宿主维护「待回传」表：token 一次性、默认 300 秒（`decisionSeconds`）后作废，回传口只接受
   本机回环请求。审批监听器把「GUI 里的回答」和「通知按钮的回答」**赛跑**：
   谁先到用谁，另一边随即作废，并把那条通知从操作中心撤掉。
4. 只在通道**注册成功**时才给按钮——不知道自身地址、注册失败、或 `decisionButtons=false`
   时都退化成普通通知（否则点下去系统会弹「选择打开方式」）。
5. **顺手把 GUI 里那张「等待审批」卡也收掉**。那张卡是客户端自己在 `approval/request`
   瀑布里创建的 pending interaction，只有**它自己**结束（`answer`/`delegate`/`abort`）时
   才会消失——宿主返回的答案它看不到，所以之前点完通知按钮，卡片还杵在那儿等人点。
   现在宿主每完成一次「从通知按钮结算」就记一条事实
   （`GET /plugins/dsh-windows-notify/decisions?since=<seq>`），客户端半边拿它做两件事：
   - **A（首选）**：从 `ctx.uiSession.sessionStatus` 的快照里找到那个 pending 实例，
     直接调它的公开 `answer(outcome)` → 卡片随它的 `finally` 一起消失。这次迟到的回答会被
     瀑布丢弃（宿主早已落盘），实例自带的 already-settled 守卫也拦住重复结算。
   - **B（兜底）**：拿不到可结算的实例时，按文案在 DOM 里找卡上的「允许一次 / 拒绝」
     （Allow once / Reject）按钮点它——不依赖任何内部 API，代价是换文案/换皮会失效。
   客户端只在**本地真的有待审批**时才拉这条增量，空闲时零请求；`since` 基线在每次进入
   「有待审批」时重新对齐，避免旧事实误伤新卡片。

安全性：token 16 位十六进制随机、只能用一次；回传口只认回环地址；即使 token 泄漏，最坏结果
也只是替你答了一次本来就在等你的审批，而它同时仍受 DSH 自己的授权策略约束。

**高危审批默认不发按钮**（`decisionButtonsFor = safe-only`）：通知上的「允许」太容易误点，
而 `danger-full-access` 一旦放行就不再受工作区限制。这类审批只弹一条正文带
「高危权限，请到 DSH 界面确认」的普通通知，必须回界面点。低危的（如升级到
`workspace-write`）照旧带按钮。想恢复「全都给按钮」就把它设成 `all`。

**每次按钮激活都有审计**：`%LOCALAPPDATA%\dsh-windows-notify\decision.log`，一行一次
`时间 | 允许/拒绝 | token | 拉起它的父进程 | 父进程命令行`。父进程能区分来源——
真人点通知走的是 Windows 通知平台（`svchost.exe -s WpnUserService`），
而程序里 `Start-Process "dsh-notify:…"` 的父进程是 `powershell.exe`。
（现场验证过：一条没人点的通知挂 10 分钟不会有任何回传，不会自己触发。）
`node tools/peek-toast.mjs` 则用来查看操作中心里那条通知实际带了哪些按钮参数。

`node tools/test-decision.mjs` 会起一个替身宿主、用真实注册表协议和
`Start-Process "dsh-notify:allow/<token>"`（就是系统点按钮时做的事）验完整条链路，
跑完恢复原来的协议注册。

`node tools/demo-buttons.mjs` 是「人点一下」的现场演示：起替身宿主 + 注册真实协议 +
发一条**真的**带按钮通知，点哪个都会把 token/choice 打在终端里，用来确认 Windows
确实渲染了这两个按钮、点下去也确实回传（演示结束会把协议恢复原样）。

面板顶部还有**发送测试通知**：点一次就能验证「弹得出来 + 点击能回到 DSH」。

另外注册了一个 `hidden` 的 tab 类型（正常看不到，只有被显式打开时才出现）：它显示通知通道
状态、最近发出的通知（宿主保留最近 50 条，`GET /plugins/dsh-windows-notify/recent`）和测试按钮。
想让它出现在 DSH 侧栏的「+」菜单里，把 `lib/client.js` 里的 `hidden: true` 改成 `false` 即可。

不想用界面也行：同一份配置等价地存在 profile 的 `cordis.patch.yml`（entry id `windows-notify`）
里，直接改文件效果一样——界面写的就是它（经 DSH 的 settings 服务）。

界面靠宿主半边这两个路由读写配置（**写入只允许本机回环**）：
`GET /plugins/dsh-windows-notify/config`、`POST /plugins/dsh-windows-notify/config`。

## 给 AI / 脚本用的 API

**1. 模型工具 `notify_user`**（AI 直接调用）

```
notify_user(title="构建完成", message="产物在 dist/", tag="build", sticky=false)
→ { delivered: true, title: "构建完成", body: "产物在 dist/" }
```

**2. HTTP 接口**（任何脚本 / 外部 AI）

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19387/plugins/dsh-windows-notify/send `
  -ContentType 'application/json' `
  -Body '{"title":"部署完成","message":"v0.1.0 已上线","tag":"deploy"}'

# 自检 / 状态 / 最近通知
Invoke-RestMethod http://127.0.0.1:19387/plugins/dsh-windows-notify/status
Invoke-RestMethod 'http://127.0.0.1:19387/plugins/dsh-windows-notify/recent?limit=10'
# 「已从通知按钮结算」的增量事实（客户端半边用它收掉 GUI 的审批卡）
Invoke-RestMethod 'http://127.0.0.1:19387/plugins/dsh-windows-notify/decisions?since=0'
```

**3. 插件服务 `ctx.windowsNotify`**（其它 DSH 插件）

```js
const notify = ctx.get('windowsNotify');
await notify.send({ title: '标题', message: '正文', tag: 'x', sticky: false });
await notify.status();
notify.recent(10);   // 最近发出的通知
```

## 点击通知是怎么回到 DSH 的

1. 通知 XML 用 `activationType="protocol"`，点击/按钮都激活一个 URI。
2. 桌面端优先用 **DSH 自己注册的 `dsh:` 协议**（Electron 的 `setAsDefaultProtocolClient("dsh")`），
   URI 是 `dsh://open`。系统执行 `"D:\DSH\DeepSeek Harness.exe" "dsh://open"`，
   应用因单实例锁把这次启动转成 `second-instance` → `restore() + show() + focus()` 主窗口。
   —— 这条路**不改注册表**。
3. 若 `dsh:` 没注册（或宿主是 `dsh web` 浏览器模式），插件才退回到自己注册的
   `HKCU\Software\Classes\dsh-notify`：桌面端指向应用本体，浏览器模式指向一个
   `%LOCALAPPDATA%\dsh-windows-notify\open-dsh.cmd`（打开本会话地址）。
4. 注册表读取失败、`focusOnClick` 关闭等情况统统只降级：通知照发，只是不带激活。

## 自检与排错

```powershell
cd <本目录>
node test/windows.mjs          # XML/协议/文案的单测（不需要 DSH）
node test/windows.mjs --toast  # 额外发一条真通知，并回读操作中心历史
node test/smoke.mjs            # 假 ctx 驱动宿主半边：4 类状态、去重限流、工具、HTTP/配置路由
node test/client.mjs           # 假 React + 假 __ModuleLoader__ 驱动客户端半边（设置页）
node tools/test-decision.mjs   # 「点通知按钮 → 隐藏脚本 → POST 回宿主」端到端（真注册表协议）
node tools/compare-define-tool.mjs   # 本地 defineTool 与 DSH 自带实现逐字段对照
node tools/register-protocol.mjs --check   # 看 dsh-notify: 注册成了什么
node tools/test-activate.ps1   # 最小化 DSH → 触发 dsh://open → 确认窗口被还原
```

| 现象 | 排查 |
| --- | --- |
| 完全没有通知 | 系统「设置 → 系统 → 通知」里允许通知、关掉专注助手；`/status` 看 `available` 是否为 true |
| 通知来源显示不对 | `aumid` 保持 `com.deepseek.dsh`（桌面版开始菜单里的 AppID，`Get-StartApps` 可查） |
| 点了没反应 | `node tools/register-protocol.mjs --check`；桌面端应存在 `HKCU\Software\Classes\dsh\...\command` |
| 有通知但没声音 | 配置里 `sound`，以及系统通知的提示音设置 |
| 权限通知上没有按钮 | 说明按钮通道没建好（日志里会有 `decision channel unavailable`）：浏览器模式（没有 `DSH_WEB_URL`）或 `decisionButtons` 关掉了；此时会退化成普通通知。可跑 `node tools/register-protocol.mjs --check` 看 `dsh-notify:` 指向哪 |
| 点「允许 / 拒绝」没反应 | 跑 `node tools/test-decision.mjs` 验证链路；它跑完会把协议恢复成原来的命令，之后插件会在下次启动时重新注册 |
| 点了通知按钮、审批**已结算**，但界面上那张「等待审批」卡还在 | 卡片清理走客户端半边：确认 DSH 界面已刷新（客户端 bundle 换代后要重新加载页面）；`/decisions` 里应能看到那条事实。两分钟内没消失说明该 DSH 版本的 `uiSession` 面变了，B 兜底的文案也可能变了——把现象发我，我更新匹配规则 |
| 不确定是不是「自己点到的」/ 审批怎么就被批准了 | 看 `%LOCALAPPDATA%\dsh-windows-notify\decision.log`：一行一次激活，含时间、允许/拒绝、以及拉起它的父进程（真人点击 = 通知平台 `WpnUserService`；脚本触发 = `powershell.exe`）。当前默认高危审批不发按钮，也能从源头少踩这个坑 |
| 设置页里找不到「通知」卡片 | 卡片在**设置 → 侧边栏卡片 → 侧边栏内容**一组的**最后**（`hidden` 类型排在末尾）；没有的话先确认 `dsh-better-sidebar` 在运行，客户端半边改动需要**重启宿主**才生效 |
| 想看插件日志 | 配置 `debugLog=true`，再在会话日志里找 `windows-notify:` 前缀 |

## 卸载

```powershell
# 1) 从 profile 移除
cd ~/.dsh/profiles/desktop
<DSH 自带 node> <DSH 自带 pnpm> remove dsh-windows-notify
# 2) 从 package.json 的 dsh.profile.bundles 里删掉 "dsh-windows-notify"
# 3) 可选：删掉 HKCU\Software\Classes\dsh-notify（仅当用过兜底协议）
```

## 目录

```
lib/index.js         插件宿主半边：事件监听、通知编排、按钮回传（允许/拒绝）、模型工具、
                     HTTP 路由、配置桥、通知历史、ctx.windowsNotify
lib/client.js        客户端半边（手写的已构建 bundle）：注册 DSH 原生设置页（settings.section）+
                     better-sidebar 设置卡片 + plugins.row.config 兜底页；前后台上报、审批卡清理
lib/win-toast.js     WinRT Toast 发送器（Windows PowerShell 5.1 + -EncodedCommand）+ 撤下通知
lib/protocol.js      点击目标 / 按钮回传的协议推导与注册（dsh://open 优先，dsh-notify: 兜底）
lib/messages.js      4 类状态的文案与载荷防御式解析（zh/en）
lib/define-tool.js   defineTool 的等价实现（避免依赖 @deepseek-ai/dsh-tools 的裸导入解析）
cordis.patch.yml     profile 挂载层（insert 一个 loader entry）
tools/               安装、协议注册、按钮链路端到端、defineTool 对照、激活测试、演示通知
test/                自检
```

**开发说明**：本目录下的 `node_modules` 是一个指向
`~/.dsh/profiles/desktop/node_modules` 的**目录联接**。原因是插件以 `link:` 方式装进 profile 时，
Node 按**真实路径**解析插件内部的裸导入，`@deepseek-ai/schemastery` 会从本目录往上找；
没有这个联接，插件在加载期就会 `ERR_MODULE_NOT_FOUND`。`package.json` 的 `files` 白名单
不包含 `node_modules`，所以它不会被当成包内容发布。
