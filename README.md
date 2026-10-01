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

- Windows 上**透明窗口 + 硬件加速**历来有闪烁 / 合成问题，可能要为稳定牺牲一点性能。
- 全屏置顶窗口**不要在启动时抢焦点**，否则会打断用户正在做的事。
- 插件的弹出面板若大过窗口会被裁 —— 这也是窗口取"整个工作区"的原因。

## 落地计划

| 步骤 | 做什么 | 状态 |
| --- | --- | --- |
| 1 | host 插件注册一条 overlay route（极简 HTML + 引入白名单前端脚本），**用普通浏览器**验证插件前端脱离 DSH SPA 能否跑、数据对不对 | 未开始 |
| 2 | 搭 Electron 外壳（复用 DSH 运行时），全屏透明 + 置顶 + 动态穿透，先加载静态页测窗口行为 | 未开始 |
| 3 | 把第 1 步的页面接进 overlay，用带凭据的 URL 打开 | 未开始 |
| 4 | 白名单机制 + 生命周期（谁拉起、DSH 退出怎么收尾） | 未开始 |

## 目录

| 路径 | 放什么 |
| --- | --- |
| `plugin/` | DSH 插件包：注册 overlay 页面路由、拉起外壳、维护白名单 |
| `shell/` | Electron 外壳（主进程 + 页面） |
| `runtime/` | 复用 DSH 运行时的产物（体积大，不入 git） |
