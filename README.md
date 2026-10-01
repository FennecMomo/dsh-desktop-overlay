# dsh-desktop-overlay

把 DSH 插件的前端搬到**桌面 overlay 窗口**里：一个透明、置顶、覆盖整个工作区的独立窗口，
跟 DSH 主窗口毫无关系 —— 所以 DSH 最小化、被遮挡、甚至关掉，挂件都还浮在桌面上。

## 为什么需要它

- DSH 页面里的挂件（例如余额小鲸鱼）活在 DSH 的窗口里。窗口一最小化，Windows 就不再绘制它，
  页面里做什么都白搭。
- client 半边插件拿不到窗口级权限：它的全部 builtin 只有受限 `ctx`、`React`、
  `host.call`、`styles.insert`、`console`；client service 也只有 panel/sidebar 那类页面布局。
  不能置顶、不能透明、不能拦最小化。
- 唯一能做到"桌面级悬浮"的路，是**另起一个不属于 DSH 的窗口**。

## 架构

```
DSH host 半边（插件）                    桌面 overlay（Electron 外壳）
├── webServer.register(route)  ──提供──▶  透明 / 置顶 / 全屏 / 动态穿透的窗口
│     └── 极简 HTML + 白名单前端脚本           └── 加载那条带凭据的 URL
├── connection.authenticatedUrl(base)          └── 页面同源 → 插件的相对路径
└── subprocess.spawn 拉起外壳                       `/xxx/*` 请求全部通过
```

两个关键点：

1. **overlay 的页面必须由 DSH 自己的 webServer 提供**。插件的路由带信任栅栏，外部页面直接
   请求会被 401/403；而页面若从 DSH 的 origin 出来，前端脚本里的相对路径请求就是同源的，
   插件前端**一行都不用改**。
2. **长期运行的子进程用 `subprocess.spawn` 拉起**，不能用 `ctx.shell`
   （它在命令结束时回收整棵进程树，进程会安静地死掉）。

## 白名单能放什么

| 前端形态 | 能不能搬 | 判断依据 |
| --- | --- | --- |
| **独立型** | ✅ | 自己 `createElement`、自己挂 `body`、只用相对路径 `fetch`、不依赖 DSH 特有全局 |
| **插槽型** | ❌ | 通过 `slots.register` 或 React 组件挂进 DSH 的 UI 树，离开 slot 运行时就没法渲染 |

首个适配对象是 `dsh-whale-widget`（独立型：全部请求走 `/dsh-whale/*` 相对路径，不依赖
`__DSH_BOOT__` 之类全局，自己建 DOM 挂 `body`）。

## 窗口选型

- **Electron 44.0.0** —— 与 DSH 桌面端同一个大版本（安装目录的 `version` 文件就是它），
  Chromium 渲染、透明窗口行为、字体渲染全部一致。
- 运行时**不另外下载**：Electron 查找 app 的顺序是 `resources/app.asar` → `resources/app`
  → 内置 `default_app.asar`。所以复制一份 DSH 的运行时目录、把 `resources/app.asar` 换成
  自己的 `resources/app/`，用同一个 exe 启动即可。
  - 同一卷内可用**硬链接**，磁盘成本接近零；跨卷（`E:\` → `D:\`）不能硬链接。
- 窗口参数：`transparent`、`frame: false`、`resizable: false`、`alwaysOnTop`、
  `skipTaskbar`、`hasShadow: false`，尺寸 `setBounds` 到工作区（留意 DPI 缩放与多显示器）。

## 全屏透明窗口必须做动态穿透

窗口覆盖整个工作区，如果不穿透，**整个桌面都点不动**（连 DSH 自己都点不了）。做法：

1. 窗口常驻 `setIgnoreMouseEvents(true, { forward: true })`；
2. 渲染进程监听 `mousemove`，判断指针是否落在可交互区域（挂件本体 / 弹出的面板）；
3. 落上了就用 IPC 让主进程临时关掉穿透，离开再打开。

比 `SetWindowRgn` 更省心：DOM 布局变了不用重算 region。

## 已知风险

- **改了 host 半边必须重启 DSH 客户端。** 用 `set_bundle` 禁用再启用**不会**加载新代码：
  Node 的 ESM 缓存按 specifier 命中，重新实例化执行的还是旧模块（现象：改动像没生效，
  但文件时间戳确实被更新了，因为旧模块的 `apply` 又跑了一遍）。
- Windows 上**透明窗口 + 硬件加速**历来有闪烁 / 合成问题，可能要为稳定牺牲一点性能。
- 全屏置顶窗口**不要在启动时抢焦点**，否则会打断用户正在做的事。
- 插件的弹出面板若大过窗口会被裁 —— 这也是窗口取"整个工作区"的原因。

## 鉴权链（已验证）

DSH 的 web 认证是 **token 形式的 URL**，而 token **只在 index 请求上生效**：

```
GET /?token=<process token>   →  303 See Other, location: ./
                                 set-cookie: dsh-auth-<id>=v1.<payload>.<sig>
                                             (HttpOnly; SameSite=Strict; Max-Age=30d)
```

拿到这条 `dsh-auth-*` cookie 之后，**同源**的所有请求（包含插件自己的路由）都放行：

| 请求 | 裸请求 | 带会话 cookie |
| --- | --- | --- |
| `/dsh-overlay` | 200（本插件未加栅栏） | 200 |
| `/dsh-whale/balance.json` | 401 | **200**（真实余额/今日已用） |
| `/dsh-whale/widget.js` | 401 | **200** |

所以 overlay 的正确打开顺序是「**先 login、再 page**」；Electron 外壳里同理：
在同一个 session 里先 `loadURL(login)` 再 `loadURL(page)`。

## 启动闸门（必须知道）

挂件脚本有一条**页面自检**：只在 `#root` 里存在 composer 时初始化
（`textarea` / `[contenteditable]` / `[data-composer-input]` / `[data-composer-seat]` …），
检测到之前**一行 DOM 都不碰**，只挂 `MutationObserver` 无限等 —— 表现为「无报错、也不渲染」。

这条自检是作者为躲开「插件页（`plugins` 面板）」加的：那是同一个 SPA 的另一个视图，
用 React portal 渲染到 `document.body`，挂件在那儿初始化会干扰 React 渲染树。

overlay 页面里没有 DSH 的 SPA，所以必须放一个**隐藏的假 composer** 顶过这道闸门
（见 `plugin/page/index.html`）。

⚠️ **这是脆弱点**：等于利用了作者的实现细节。上游若把判据改严，闸门会**静默**失效
（又变回「无报错、也不渲染」）。长期方案是给上游提 issue 要一个正式的「独立运行」入口，
或者在本地 fork 里改成「检测到独立环境就跳过」。

## 怎么验证（可自动化）

`tools/cdp-probe.mjs` 用 CDP 驱动一个**独立的**无头 Edge 实例（独立 `--user-data-dir`，
不碰用户自己开着的浏览器）：走 login 拿会话 cookie → 打开 overlay 页面 → 注入闸门 →
收集诊断 → 从页面内部 `fetch` 数据 → 点击角色 → 截图。

```powershell
# 1) 起一个带调试端口的无头 Edge
msedge.exe --headless=new --remote-debugging-port=9222 `
  --user-data-dir=$env:TEMP\dshe2e-profile --no-first-run --window-size=1280,800 about:blank

# 2) 跑探针
$env:LOGIN_URL='http://127.0.0.1:<port>/?token=<token>'
$env:PAGE_URL='http://127.0.0.1:<port>/dsh-overlay'
$env:OUT_PNG="$env:TEMP\overlay-shot.png"
node tools/cdp-probe.mjs
```

## 步骤 1 的验证结果（已完成）

| 检查项 | 结果 |
| --- | --- |
| 挂件脚本初始化 | ✅ `init: true`，建出 225 个挂件节点 |
| 鲸鱼图片 | ✅ `/dsh-whale/image.png` 加载成功 |
| **页面内部**数据请求 | ✅ `fetch('/dsh-whale/balance.json')` → 200，真实余额与今日已用 |
| 交互 | ✅ 点击角色弹出泡泡，显示余额 / 今日已用 / 峰谷倒计时 |
| 会话凭据 | ✅ login 后 11 条 cookie，同源请求全部放行 |

结论：**「独立型」前端脱离 DSH 的 SPA 之后功能完整** —— 它对 DSH 页面结构的依赖，只有启动闸门那一处。
（证据截图：`docs/step1-rendered.png`、`docs/step1-clicked.png`，不入 git。）

## 步骤 2 的验证结果（外壳，已完成）

外壳跑起来了（复用 DSH 那份 Electron 44），窗口铺满工作区（1920×1032），标志位实测：

| 检查项 | 结果 |
| --- | --- |
| `WS_EX_LAYERED`（透明） | ✅ True |
| `WS_EX_TOPMOST`（置顶） | ✅ True |
| `WS_EX_TRANSPARENT`（穿透，随光标切换） | ✅ 随判定实时变化 |
| 窗口尺寸 | ✅ 铺满工作区，`resizable:false` 锁死 |
| 动态穿透 | ✅ 光标在角色上 → 关穿透；在空白处 → 开穿透 |
| **真实点击** | ✅ 真实光标 + `mouse_event` 点击角色，页面计数器 0 → 2 |

### 坑 1：继承 `ELECTRON_RUN_AS_NODE` 会让外壳以 Node 模式启动

DSH 派生的子进程带着 `ELECTRON_RUN_AS_NODE=1`，于是 `DeepSeek Harness.exe` 被当成 node 跑，
报 `bad option: --remote-debugging-port=…` 后 exit 9 —— 看起来像「窗口起不来」，
其实根本没进 Electron。**拉起外壳前必须清掉这个变量**（第 4 步用宿主插件 spawn 时同理）。

### 坑 2：Windows 上 `setIgnoreMouseEvents(true, { forward: true })` 不转发 mousemove

这条最要命。文档只承诺转发 `mouseleave` 那类事件，实测**渲染进程收不到 mousemove**
（`movesSeen` 恒为 0，真实光标也一样，与 CDP 注入无关）。也就是说「靠 DOM 事件驱动穿透」
在 Windows 上不成立。

改用**主进程轮询**：`screen.getCursorScreenPoint()` 25Hz → IPC 送窗口内坐标 →
preload 用 `elementFromPoint` 判断 → 回报切换穿透。穿透只影响**输入事件**，
不影响 **IPC** 和渲染，所以这条路是通的。

> 顺带一个诊断陷阱：CDP 的 `Input.dispatchMouseEvent` 注入的事件**只到主世界**，
> 到不了 preload 的隔离世界（`checks` 不动）；而且页面 reload 后
> `window.dshOverlay.state` 可能读到旧实例，显示成 `checks: 0` 的假象 ——
> 判断 preload 是否真的在工作，看**主进程侧的状态文件**和页面 `document.title` 更靠谱。

### 小瑕疵

`skipTaskbar: true` 没让 `WS_EX_TOOLWINDOW` 生效（任务栏仍会出现图标），
后续显式调一次 `win.setSkipTaskbar(true)` 再看。

## 步骤 3 的验证结果（真实页面，已完成）

外壳以真实模式启动（`--login=<带 token 的 index URL>` `--page=<overlay 页面>`）：

| 检查项 | 结果 |
| --- | --- |
| 会话 | ✅ `net + useSessionCookies` 换到 `dsh-auth-*`（1 条），**不渲染 DSH 的 SPA** |
| 挂件初始化 | ✅ 229 个挂件节点，`.dshwv-root` 就位 |
| 页面内数据 | ✅ `fetch('/dsh-whale/balance.json')` → 200，真实余额 / 今日已用 |
| 每轮消耗提示 | ✅ 截图里泡泡显示「上一轮对话消耗 ¥0.01 · 今日已用 ¥1.52」 |
| 穿透判定 | ✅ 光标在鲸鱼上 → `elementFromPoint` 命中 `IMG.dshwv-img` → 关穿透；移到空白 → 开穿透 |

证据截图：`docs/step3-overlay-real.png`（不入 git）。

### 坑 3：Electron 会把「裸参数」当成 app 路径

`--login <url>` 这种写法里，那个 URL 是**游离参数**，Electron 把它当 app 路径去加载，
于是外壳**静默退出**（stdout / stderr 全空、exit 奇怪且无输出）——排查时极具误导性。

**必须用 `--login=<url>` / `--page=<url>` 这种带等号的形式**（`main.js` 的 `option()` 两种都吃，
但调用方要给等号形式）。

## 步骤 4 的验证结果（跟随 DSH，已完成）

`watch-dsh.ps1`（常驻 PowerShell，300ms 看一次 DSH 窗口状态，只在变化时往 stdout 打一行）
+ 外壳联动，实测：

| 场景 | 结果 |
| --- | --- |
| DSH 正常显示 | `watch.state=visible` → `overlayVisible=false`（鲸鱼藏着，不打扰） |
| **最小化 DSH** | `IsIconic=true` → `watch.state=hidden` → `overlayVisible=true`（**鲸鱼自动浮出来**，229 个挂件节点） |
| 恢复 DSH | `watch.state=visible` → `overlayVisible=false`（鲸鱼藏回去） |
| DSH 退出 | watcher 报 `gone` → 外壳自己也退出（没人喂数据就别留着） |

证据截图：`docs/step4-minimized.png`（不入 git）。

### 坑 4：持有窗口的进程，不是 host 所在的进程

DSH 的 host 跑在一个进程里，**窗口却属于另一个进程**（Electron 主进程），而两个都叫
`DeepSeek Harness.exe`。所以「把 `process.pid` 当窗口 PID 传下去」是错的——host 的 pid
根本找不到窗口。

外壳改为**按进程名匹配 + 排除自己**（`-ProcessName` + `-ExcludePid`），进程名直接从自己的
`process.execPath` 推导（外壳和 DSH 是同一个 exe，天然一致）。

### 坑 5：PowerShell 的参数不能叫 `$Pid`

`$PID` 是 PowerShell 的只读自动变量，`param([int]$Pid)` 一绑定就失败：
`Cannot overwrite variable Pid because it is read-only or constant`。改叫 `-TargetPid`。

## 挂件尺寸：为什么不一定是「两边一样大」

挂件自己的尺寸公式（前端 CSS）：

```
--dshw-base: clamp(122px, calc(min(250px, min(100vw, 100vh) * 0.28) * var(--dshw-scale)), 625px)
```

`min(250px, …)` 是**上限保护**：只有视口最小边 ≥ 893px 时才顶到 250。

- overlay 窗口**永远铺满工作区**（本机 1920×1032）→ 恒为 `250 × scale`；
- DSH 窗口若**不是最大化**（最小边 < 893）→ 退化成 `视口 × 0.28 × scale`，会小一圈。

实测对照（同一份挂件、视口都锁 1920×1032、DPR 1、`.dshw-size.json` 里 scale=1.5）：

| 环境 | `--dshw-scale` | `.dshwv-root` 实测宽度 |
| --- | --- | --- |
| overlay 页面 | 1.5 | **375px** |
| DSH 页面 | 1.5 | **375px** |

顺带排除的嫌疑：两边 DPI 都是 96（100% 缩放）、`devicePixelRatio` 都是 1、
都没有 Chromium 的 per-host zoom、DSH 主进程命令行里也没有 `--force-device-scale-factor`。

**结论：两边的尺寸规则完全相同；「桌面版大一圈」通常来自 DSH 窗口没有最大化。**

## 坑 6：按命令行子串过滤进程，会匹配到自己

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*某个关键字*' }
```

会连**正在执行这条命令的进程自己**一起匹配到 —— 尤其是 DSH 的 subprocess runner
（进程名同样是 `DeepSeek Harness.exe`，而命令行里还印着整段脚本内容）。

表现：命令报 `subprocess-local: Windows Job runner exited with exit code 4294967295`，
其实是那条命令**把自己的 runner 杀了**。所以：过滤时务必再限定进程名
（如 `Name='msedge.exe'`），也**不要用会出现在自己命令行里的关键字去杀进程**。

### 坑 7：固定 `argv.slice(N)` 会吃掉第一个开关

打包后的 Electron app 里 `process.argv[1]` **就是第一个用户参数**（没有 app 路径那一项），
开发模式下 `argv[1]` 才是 app 路径。写死 `slice(2)` 会把第一个开关整个丢掉。

踩到的表现极其隐蔽：插件传 `--login=… --page=…`，`--login` 排在头一个被切掉 →
外壳照样启动、窗口照样在、照样跟着 DSH 显示与隐藏，但 `establishSession` 压根没被调用
（状态文件里 `via: 'none'`）→ **永远取不到数据，而且它自己不报错**。

修法：从 `argv[1]` 开始扫，`--` 前缀的判断交给 `option()`。

（第 3 步手动验证时没暴露纯属运气：那时第一个参数是 `--remote-debugging-port=…`，切掉无妨。）

### 坑 8：别把 `connection` 当成可选依赖

`ctx.get('connection')` 在 DSH 启动过程中可能返回 `undefined`（插件加载早于 service 注册），
于是 `authenticatedUrl()` 用不上，login URL 退化成不带 token 的裸地址 —— 又是同一个哑症。
把 `connection` 放进 `inject` 数组，Cordis 会等它就绪再加载本插件。

## 步骤 6：露面之前先把插件刷一遍（已完成）

**问题**：插件前端只在**启动时读一次**配置，之后各存各的内存副本。于是会出现「在 DSH 里把鲸鱼
调到 10 档、桌面版还显示 6 档」——两边各说各话，除非刷新。

**做法：时机驱动，不是文件驱动。**

> 这里一开始走错了路：去监视"哪些配置文件变了"。那要求知道每个插件把配置写在哪、叫什么，
> 还得区分"设置"和"高频数据"（账本每轮对话都写），等于要一个个适配过去。
>
> 正确做法是**挑时机**：`showFresh()` 在浮出来之前先 `reload()` 页面 —— 插件前端重新初始化，
> 自然重读自己的配置。**这对任何「独立型」前端都成立**，不需要知道它的文件长什么样。

**时序是关键**：这次重载发生在窗口**仍然隐藏**的时候，用户看不见；刷完再 `showInactive()`
露面，所以看到时已经是最新配置，**没有任何闪烁**。

另外留了 `Ctrl+Alt+R` 手动刷新兜底。

**验证**：连续两次最小化 DSH，状态文件里 `reloads` 从 0 → 1 → 2，每次都刷。

反向的那一半没有做，原因见下方「已知限制」。

## ⚠️ 已知限制：桌面期间改的配置，不会自动同步回 DSH

**症状**：在桌面版里把鲸鱼调成 6 档，回到 DSH 界面，里面的挂件还是老样子（10 档）。
（反方向——DSH 改的、桌面版跟上——已经修好了，下次露面自动就是最新的。）

**根因**：插件前端只在**启动时读一次**配置，DSH 的页面和桌面窗口各存各的内存副本。
桌面这半我们能在「露面之前」悄悄重载页面；但 **DSH 那半的挂件是插件自己往 index 页面注入的，
既拦不到也换不掉**，所以没法用同样干净的手法刷它。

**评估过、但都没采用的三条路**（代价都比"手动按一下 F5"大）：

| 方案 | 为什么不用 |
| --- | --- |
| DSH 恢复可见时整页刷新 | 通用彻底，但会丢聊天滚动位置，输入框里没发出去的草稿也可能丢 |
| 只在"确实改过设置"时才刷（拦写请求 + dirty 标记） | 能把打扰限制在真改过的那一次，但那一次仍要整页重载，代价同上 |
| 把 DSH 那半的挂件换成可控的 iframe 容器 | 最干净、无副作用，但挂件是插件自己注入的，除非动上游插件，否则换不掉 |

**当前的手动兜底**：在 DSH 界面里按 **F5 / Ctrl+R** 刷一次页面，挂件就会读到最新配置。
反向（DSH 改 → 桌面版）不需要手动，下次露面时自动就是最新的。

**什么时候这个限制会消失**：如果哪天插件把「设置」和「数据」分开存，或者提供一个
"重新读配置"的接口，就能做定向刷新而不用整页重载 —— 那时把它接进来即可。

## 落地计划

| 步骤 | 做什么 | 状态 |
| --- | --- | --- |
| 1 | host 插件注册一条 overlay route（极简 HTML + 引入白名单前端脚本），验证插件前端脱离 DSH SPA 能否跑、数据对不对 | ✅ **完成** |
| 2 | 搭 Electron 外壳（复用 DSH 运行时），全屏透明 + 置顶 + 动态穿透 | ✅ **完成** |
| 3 | 把第 1 步的页面接进 overlay，用带凭据的 URL 打开 | ✅ **完成** |
| 4 | 跟随 DSH：最小化/进托盘 → 浮出，恢复 → 藏起，退出 → 收尾 | ✅ **完成** |
| 5 | host 插件随 DSH 启动自动拉起外壳；白名单集中在 `WHITELIST` | ✅ **完成**（重启后实测通过） |
| 6 | 露面之前先重载页面（时机驱动，读最新配置）；`Ctrl+Alt+R` 兜底 | ✅ **完成**（DSH → 桌面 单向） |
| 7 | 反向同步：桌面期间改的配置让 DSH 那半也跟上 | ❌ **不做**（三条路的代价都不划算，见「已知限制」；手动 F5 兜底） |

## 目录

| 路径 | 放什么 |
| --- | --- |
| `plugin/` | DSH 插件包：注册 overlay 页面路由、拉起外壳、维护白名单 |
| `shell/` | Electron 外壳（主进程 + 页面） |
| `runtime/` | 复用 DSH 运行时的产物（体积大，不入 git） |
