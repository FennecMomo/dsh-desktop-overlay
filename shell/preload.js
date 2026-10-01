/**
 * dsh-desktop-overlay —— Electron 外壳（preload）
 *
 * 窗口铺满整个工作区，所以**必须常驻鼠标穿透**，否则整个桌面都点不动；
 * 但穿透时页面收不到任何鼠标消息。判断因此由**主进程轮询光标**驱动：
 *
 *   主进程 screen.getCursorScreenPoint()（25Hz）
 *     → IPC 送窗口内坐标
 *     → 这里用 elementFromPoint 判断「该坐标上是不是真有接收指针事件的元素」
 *     → 回报主进程切换 setIgnoreMouseEvents
 *
 * 为什么不用 DOM 的 mousemove：Windows 上 `setIgnoreMouseEvents(true, { forward: true })`
 * 不会把 mousemove 送进渲染进程（实测连真实光标也一样，`movesSeen` 恒为 0），
 * 文档只承诺转发 `mouseleave` 那类事件。穿透只影响输入事件，不影响 IPC —— 所以轮询是通的。
 *
 * 判定故意不按类名匹配：`elementFromPoint` 会自己跳过 `pointer-events:none` 的节点，
 * 所以「命中了某个元素」就等于「这里接收指针事件」，唯一要排除的是页面根节点。
 * 这样外壳不必知道任何插件的类名 —— 白名单换了插件也不影响。
 */
const { contextBridge, ipcRenderer } = require('electron')

const BUILD = 'preload-v4'

let interactive = false
let checks = 0
let lastPoint = null
let lastHit = null
let lastCheckAt = 0

function isInteractiveAt(x, y) {
  const element = document.elementFromPoint(x, y)
  if (element === null || element === undefined) return false
  if (element === document.documentElement || element === document.body) return false
  return true
}

function evaluate(x, y) {
  let hit = isInteractiveAt(x, y)
  if (!hit) {
    /* 边缘容忍：贴着可交互区域挪一两个像素也算命中，免得贴边时点不到。 */
    hit = isInteractiveAt(x + 2, y) || isInteractiveAt(x - 2, y) || isInteractiveAt(x, y + 2) || isInteractiveAt(x, y - 2)
  }
  lastHit = hit
  return hit
}

function apply(next) {
  if (next === interactive) return
  interactive = next
  ipcRenderer.send('overlay:hit', next)
}

ipcRenderer.on('overlay:cursor', (_event, point) => {
  checks += 1
  lastPoint = [point.x, point.y]
  const now = Date.now()
  /* 主进程已经按光标位移去过重，这里再挡一层极端高频。 */
  if (now - lastCheckAt < 8) return
  lastCheckAt = now
  const hit = evaluate(point.x, point.y)
  apply(hit)
  /* 诊断：把结果顶到标签页标题上 —— 标题属于 DOM，主世界读得到、截图也看得到，
     这样能区分「preload 没收到」和「读到的不是同一个 preload 实例」。 */
  try {
    document.title = `checks=${String(checks)} hit=${String(hit)} @${String(point.x)},${String(point.y)}`
  } catch (error) {
    /* 标题写不进去不影响判断 */
  }
})

contextBridge.exposeInMainWorld('dshOverlay', {
  /** 调试用：强制设置穿透状态。 */
  setInteractive(value) {
    apply(value === true)
  },
  quit() {
    ipcRenderer.send('overlay:quit')
  },
  /** 读当前状态（页面自检 / 排查用）。 */
  get state() {
    return { build: BUILD, interactive, checks, lastPoint, lastHit }
  },
})
