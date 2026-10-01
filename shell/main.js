/**
 * dsh-desktop-overlay —— Electron 外壳（主进程）
 *
 * 职责：
 *
 *   1. 开一个「透明 + 无边框 + 铺满工作区 + 置顶 + 不进任务栏」的窗口，尺寸锁死不可调。
 *   2. **跟着 DSH 走**：DSH 最小化 / 进托盘 → 浮出来；DSH 恢复 → 藏起来；DSH 退出 → 自己也退。
 *      监听交给 `watch-dsh.ps1`（常驻 PowerShell，300ms 看一次窗口状态，只在变化时打一行）。
 *      为什么要从外面看：DSH 的 host 没有任何窗口事件，而且**持有窗口的进程不是 host 所在的进程**
 *      （Electron 主进程持有窗口，两者都叫 "DeepSeek Harness.exe"），所以按进程名匹配 + 排除自己。
 *   3. **浮出来之前先把页面刷一遍**（`showFresh()`）：插件前端只在启动时读一次配置，桌面这半和
 *      DSH 那半各存各的内存副本。刷新 = 前端重新初始化 = 读到最新配置。
 *      **时序是关键**：这一刻窗口还是隐藏的，所以这次重新加载用户根本看不见 —— 露出来的时候
 *      已经是最新的了，没有闪烁。
 *
 *      这条思路是**时机驱动**而不是"逐个适配插件"：不需要知道任何插件的配置文件叫什么、
 *      也不需要它把设置和数据分开存。任何「独立型」前端重新初始化都会重读自己的配置。
 *   4. **常驻鼠标穿透**，只有指针落在可交互区域时才临时关掉（判断在渲染进程做）。
 *      用 `screen.getCursorScreenPoint()` 主动轮询驱动 —— 不能靠 DOM 的 mousemove：
 *      Windows 上 `setIgnoreMouseEvents(true, { forward: true })` 不会把 mousemove 送进渲染进程。
 *   5. 先建立会话再加载页面：DSH 的 token **只在 index 请求上生效**（会 303 + Set-Cookie），
 *      所以先拿 login URL 换 cookie，再导航到真正的 overlay 页面。
 *
 * 运行时复用 DSH 自带的那份 Electron 44（见 README），Chromium 行为与 DSH 完全一致。
 *
 * ⚠️ 用宿主进程拉起这个外壳时，必须清掉继承来的 `ELECTRON_RUN_AS_NODE`，
 *    否则 exe 会以 Node 模式启动并报 `bad option` 直接退出（exit 9）。
 * ⚠️ 传参必须用 `--login=<url>` 这种带等号的形式：裸参数会被 Electron 当成 app 路径。
 * ⚠️ watch-dsh.ps1 的参数不能叫 `$Pid`（PowerShell 只读内置变量），所以是 `-TargetPid`。
 */
const { app, BrowserWindow, ipcMain, screen, session, net, globalShortcut } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

/** 光标轮询间隔：25Hz 足够跟手，又不至于把 CPU 吃满。 */
const CURSOR_POLL_MS = 40
/** 重新加载后等这么久再露面，让挂件把首屏铺上（DOM 是同步建的，这点时间够图片/样式就位）。 */
const SHOW_SETTLE_MS = 400
const STATUS_FILE = path.join(__dirname, '.shell-status.json')

/**
 * ⚠️ 不要用固定的 `slice(N)` 切参数。
 *
 * 打包后的 Electron app 里 **argv[1] 就是第一个用户参数**（没有 app 路径那一项），
 * 而开发模式下 argv[1] 是 app 路径。固定切片会**吃掉第一个开关** —— 踩过的表现：
 * `--login=` 恰好排在前面被切掉，外壳拿不到 token，`establishSession` 根本没被调用
 * （状态文件里 `via: 'none'`），于是它起来了、也显示了，却永远取不到数据。
 *
 * 从 argv[1] 开始扫：exe 之后若还有 app 路径，它不是 `--` 开头，option() 会自然忽略。
 */
const argv = process.argv.slice(1)

/**
 * 取一个开关的值，`--name value` 与 `--name=value` 两种写法都支持。
 *
 * ⚠️ 调用方**必须**用 `--name=value`：Electron 会把命令行里的**裸参数**（没有 `--` 前缀的
 * 那个）当作 app 路径去加载，于是 `--login <url>` 里的 URL 会变成"app 路径"，
 * 外壳直接静默退出（stdout/stderr 什么都没有）。
 */
function option(name, fallback) {
  const prefix = `${name}=`
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (current === name) {
      const next = argv[index + 1]
      return next !== undefined && !next.startsWith('--') ? next : fallback
    }
    if (current.startsWith(prefix)) return current.slice(prefix.length)
  }
  return fallback
}

const LOGIN_URL = option('--login', process.env.DSH_OVERLAY_LOGIN ?? '')
const PAGE_URL = option('--page', process.env.DSH_OVERLAY_PAGE ?? '')
const TEST_MODE = argv.includes('--test')

/* 监视默认开启；测试模式或显式 --no-watch 时关掉（那时窗口一直显示）。 */
const WATCH = !TEST_MODE && !argv.includes('--no-watch')
/* 外壳和 DSH 是同一个 exe，所以进程名直接取自自己。 */
const WATCH_NAME = path.basename(process.execPath).replace(/\.exe$/i, '')

let win = null
let winBounds = null
let bootInfo = {}
let interactive = false
let cursorTimer = null
let statusTimer = null
let watcher = null
let lastCursor = null
let cursorSends = 0
let watchState = WATCH ? 'starting' : 'off'
let overlayVisible = false
let reloads = 0
let showing = false

/* GUI 子系统的程序在 Windows 上拿不到 stdout（管道会被丢掉），所以状态一律落文件，
   否则排查时只剩「窗口没出现」这一条线索。 */
function writeStatus() {
  try {
    fs.writeFileSync(
      STATUS_FILE,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          ...bootInfo,
          watch: { enabled: WATCH, name: WATCH_NAME, state: watchState },
          overlayVisible,
          interactive,
          cursorSends,
          lastCursor,
          reloads,
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch {
    /* 写不进去就算了，不影响运行。 */
  }
}

/** 用 net 请求换会话 cookie —— 不渲染 DSH 的 SPA，只是把 Set-Cookie 收进 session。 */
async function establishSession(url) {
  let origin
  try {
    const parsed = new URL(url)
    origin = `${parsed.protocol}//${parsed.host}`
  } catch {
    return { ok: false, cookies: 0, via: 'bad-url' }
  }

  const existing = await session.defaultSession.cookies.get({ url: origin })
  if (existing.length > 0) return { ok: true, cookies: existing.length, via: 'existing' }

  try {
    await new Promise((resolve, reject) => {
      const request = net.request({
        url,
        session: session.defaultSession,
        /* 关键：默认 false 时用的是内存 cookie，Set-Cookie 不会进 session。 */
        useSessionCookies: true,
        redirect: 'follow',
      })
      request.on('response', (response) => {
        response.on('data', () => {}) // 丢掉 body，我们只要 cookie
        response.on('end', resolve)
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end()
    })
  } catch (error) {
    console.error('[shell] net 换 cookie 失败：', String(error?.message ?? error))
  }

  const after = await session.defaultSession.cookies.get({ url: origin })
  return { ok: after.length > 0, cookies: after.length, via: 'net' }
}

function createWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea

  win = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    /* 全屏置顶窗不要在启动时抢焦点，否则会打断用户正在做的事。 */
    focusable: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.setSkipTaskbar(true)

  /* 监视模式下先不露面：等 watcher 报出 DSH 已经最小化再浮出来。
     不监视（测试模式）就直接显示。 */
  win.once('ready-to-show', () => {
    if (!WATCH) setOverlayVisible(true)
  })

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[shell] 页面加载失败 ${String(code)} ${description} ${url}`)
  })

  return { x, y, width, height }
}

function setOverlayVisible(next) {
  const value = next === true
  if (win === null || win.isDestroyed() || value === overlayVisible) return
  overlayVisible = value
  if (value) {
    /* showInactive：浮出来但不抢焦点。 */
    win.showInactive()
  } else {
    win.hide()
    setInteractive(false)
  }
  writeStatus()
}

/** 重新加载页面，等它加载完（外加一点铺首屏的时间）。窗口此刻可以是隐藏的。 */
function reloadAndWait(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (win === null || win.isDestroyed()) {
      resolve()
      return
    }
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      setTimeout(resolve, SHOW_SETTLE_MS)
    }
    win.webContents.once('did-finish-load', done)
    setTimeout(done, timeoutMs)
    reloads += 1
    win.webContents.reload()
  })
}

/**
 * 露出来之前先把插件前端刷一遍 —— **这是整套东西的通用换配置机制**。
 *
 * 为什么不用"监视配置文件"那条路：那要求知道每个插件把配置写在哪、叫什么名字，
 * 还得区分"设置"和"高频数据"，等于要一个个适配过去。而"重新加载页面"对任何
 * 「独立型」前端都成立：它一定会重新初始化、重新读自己的配置。
 *
 * 时序：这里窗口**还是隐藏的**，重载用户看不见；刷完再 showInactive，
 * 所以露出来的时候已经是最新的，没有闪烁。
 */
async function showFresh() {
  if (win === null || win.isDestroyed() || showing) return
  showing = true
  try {
    if (!win.isVisible()) await reloadAndWait()
    setOverlayVisible(true)
  } finally {
    showing = false
  }
}

/** 起一个常驻 PowerShell 看 DSH 的窗口状态，按行读它的 stdout。 */
function startWatcher() {
  if (!WATCH) return
  const script = path.join(__dirname, 'watch-dsh.ps1')
  watcher = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-ProcessName',
      WATCH_NAME,
      '-ExcludePid',
      String(process.pid),
      '-IntervalMs',
      '300',
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let buffer = ''
  watcher.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line !== '') handleWatchState(line)
      index = buffer.indexOf('\n')
    }
  })
  watcher.stderr.on('data', (chunk) => console.error('[shell] watcher:', String(chunk).trim()))
  watcher.on('exit', (code) => {
    console.error(`[shell] watcher 退出：${String(code)}`)
    if (watchState !== 'gone') {
      watchState = 'gone'
      writeStatus()
      app.quit()
    }
  })
}

function handleWatchState(state) {
  watchState = state
  if (state === 'gone') {
    /* DSH 没了（关掉或进托盘后进程结束）：overlay 也退，否则没人喂数据。 */
    app.quit()
    return
  }
  if (state === 'hidden') {
    void showFresh()
  } else {
    setOverlayVisible(false)
  }
  writeStatus()
}

/** 轮询光标，把窗口内坐标发给渲染进程，由它回答「这里该不该可交互」。 */
function startCursorWatch() {
  if (cursorTimer !== null) clearInterval(cursorTimer)
  cursorTimer = setInterval(() => {
    if (win === null || win.isDestroyed() || winBounds === null) return
    /* 藏起来的时候不用算。 */
    if (!win.isVisible()) return
    const point = screen.getCursorScreenPoint()
    if (lastCursor !== null && point.x === lastCursor.x && point.y === lastCursor.y) return
    lastCursor = { x: point.x, y: point.y }
    const inside =
      point.x >= winBounds.x &&
      point.y >= winBounds.y &&
      point.x < winBounds.x + winBounds.width &&
      point.y < winBounds.y + winBounds.height
    if (!inside) {
      setInteractive(false)
      return
    }
    cursorSends += 1
    win.webContents.send('overlay:cursor', { x: point.x - winBounds.x, y: point.y - winBounds.y })
  }, CURSOR_POLL_MS)
}

/** 每秒把运行状态落盘，用来判断「主进程到底有没有在发」。 */
function startStatusWatch() {
  if (statusTimer !== null) clearInterval(statusTimer)
  statusTimer = setInterval(writeStatus, 1000)
}

function setInteractive(next) {
  const value = next === true
  if (win === null || win.isDestroyed() || value === interactive) return
  interactive = value
  win.setIgnoreMouseEvents(!value, { forward: true })
}

async function boot() {
  winBounds = createWindow()

  let sessionInfo = { ok: false, cookies: 0, via: 'none' }
  if (LOGIN_URL !== '') sessionInfo = await establishSession(LOGIN_URL)

  if (!sessionInfo.ok && LOGIN_URL !== '' && !TEST_MODE) {
    /* 兜底：net 那条路没拿到 cookie，就真的加载一次 login（会短暂显示 DSH 界面）。 */
    console.warn('[shell] net 没拿到会话 cookie，退回 loadURL(login)')
    await win.loadURL(LOGIN_URL).catch(() => {})
    const cookies = await session.defaultSession.cookies.get({ url: LOGIN_URL }).catch(() => [])
    sessionInfo = { ok: cookies.length > 0, cookies: cookies.length, via: 'loadURL' }
  }

  const target = TEST_MODE ? `file://${path.join(__dirname, 'test.html').replace(/\\/g, '/')}` : PAGE_URL

  if (target !== '') {
    try {
      await win.loadURL(target)
    } catch (error) {
      console.error('[shell] 加载失败：', String(error?.message ?? error))
    }
  }

  bootInfo = { shell: 'main-v5', bounds: winBounds, session: sessionInfo, page: target, pid: process.pid }
  startCursorWatch()
  startStatusWatch()
  startWatcher()
  writeStatus()

  console.log(
    `[shell] 窗口 ${String(winBounds.width)}x${String(winBounds.height)} @ ${String(winBounds.x)},${String(winBounds.y)}` +
      ` | 会话 ${sessionInfo.ok ? 'ok' : 'no'}(${String(sessionInfo.cookies)} cookies via ${sessionInfo.via})` +
      ` | 监视 ${WATCH ? `on(${WATCH_NAME})` : 'off'} | 页面 ${target}`,
  )
}

/* 渲染进程回答「当前指针位置可不可交互」。 */
ipcMain.on('overlay:hit', (_event, value) => setInteractive(value === true))

/* 调试用：强制设置穿透状态。 */
ipcMain.on('overlay:interactive', (_event, value) => setInteractive(value === true))

/* 页面里主动请求退出（调试期很好用）。 */
ipcMain.on('overlay:quit', () => app.quit())

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    await boot()
    /* 调试逃生口：Ctrl+Alt+Q 关掉 overlay。 */
    globalShortcut.register('Control+Alt+Q', () => {
      console.log('[shell] Ctrl+Alt+Q -> 退出')
      app.quit()
    })
    /* 手动刷新：想在桌面版里立刻拿到最新配置时按一下。 */
    globalShortcut.register('Control+Alt+R', () => {
      console.log('[shell] Ctrl+Alt+R -> 重载页面')
      void reloadAndWait()
    })
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    if (watcher !== null) {
      try {
        watcher.kill()
      } catch {
        /* 已经没了就算了 */
      }
    }
  })
}
