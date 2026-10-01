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

## 落地计划

| 步骤 | 做什么 | 状态 |
| --- | --- | --- |
| 1 | host 插件注册一条 overlay route（极简 HTML + 引入白名单前端脚本），验证插件前端脱离 DSH SPA 能否跑、数据对不对 | ✅ **完成**（渲染 / 数据 / 交互全通过） |
| 2 | 搭 Electron 外壳（复用 DSH 运行时），全屏透明 + 置顶 + 动态穿透，先加载静态页测窗口行为 | 未开始 |
| 3 | 把第 1 步的页面接进 overlay，用带凭据的 URL 打开 | 未开始 |
| 4 | 白名单机制 + 生命周期（谁拉起、DSH 退出怎么收尾） | 未开始 |

## 目录

| 路径 | 放什么 |
| --- | --- |
| `plugin/` | DSH 插件包：注册 overlay 页面路由、拉起外壳、维护白名单 |
| `shell/` | Electron 外壳（主进程 + 页面） |
| `runtime/` | 复用 DSH 运行时的产物（体积大，不入 git） |
