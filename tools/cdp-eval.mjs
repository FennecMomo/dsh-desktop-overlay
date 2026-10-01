/**
 * tools/cdp-eval.mjs —— 通用 CDP 小工具：连上一个已经开着调试端口的 Chromium（Edge / Electron），
 * 在页面里求值、可选截图。用来验证 overlay 外壳里的真实渲染状态。
 *
 * 用法：
 *   CDP_PORT=9223 EXPR='1+1' node tools/cdp-eval.mjs
 *   CDP_PORT=9223 EXPR='document.title' OUT_PNG=shot.png node tools/cdp-eval.mjs
 */
import { writeFileSync } from 'node:fs'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const EXPR = process.env.EXPR ?? '1'
const OUT_PNG = process.env.OUT_PNG ?? ''
const AWAIT = process.env.AWAIT !== '0'
const PICK = process.env.PICK ?? '' // 按 URL 子串挑 target
const BASE = `http://127.0.0.1:${String(PORT)}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = await (await fetch(`${BASE}/json/list`)).json()
const pages = targets.filter((t) => t.type === 'page')
const page = PICK === '' ? pages[0] : pages.find((t) => String(t.url).includes(PICK))
if (page === undefined) {
  console.error('没有匹配的 page target；现有：')
  for (const t of targets) console.error(` - [${t.type}] ${String(t.url).slice(0, 120)}`)
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
})

let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) rej(new Error(JSON.stringify(msg.error)))
    else res(msg.result)
  }
})
function send(method, params = {}) {
  const id = nextId++
  return new Promise((res, rej) => {
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

await send('Runtime.enable')

/* VIEWPORT="1920x1032" —— 强制页面视口，好让不同环境的尺寸对比是同一基准
   （不依赖窗口边框、标题栏这些会把视口改小一圈的东西）。 */
const VIEWPORT = process.env.VIEWPORT ?? ''
if (VIEWPORT !== '') {
  const [vw, vh] = VIEWPORT.split('x').map((v) => Number(v.trim()))
  if (Number.isFinite(vw) && Number.isFinite(vh)) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: vw,
      height: vh,
      deviceScaleFactor: 1,
      mobile: false,
    })
  }
}

/* MOUSE_MOVES="x,y;x,y" —— 用浏览器**真实输入管线**移动指针。
   注意不能靠页面里 dispatchEvent 合成 MouseEvent：preload 跑在隔离世界（isolated world），
   主世界合成的 isTrusted=false 事件不会传到那边的 listener，只有真实输入才会。 */
const MOUSE_MOVES = process.env.MOUSE_MOVES ?? ''
if (MOUSE_MOVES !== '') {
  for (const pair of MOUSE_MOVES.split(';')) {
    const [x, y] = pair.split(',').map((v) => Number(v.trim()))
    if (Number.isFinite(x) && Number.isFinite(y)) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
      await sleep(500)
    }
  }
}

const evaluated = await send('Runtime.evaluate', {
  expression: EXPR,
  returnByValue: true,
  awaitPromise: AWAIT,
})
const value = evaluated.result?.value ?? evaluated.result?.description ?? null
console.log(JSON.stringify({ url: page.url, value }, null, 2))

if (OUT_PNG !== '') {
  await sleep(300)
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(OUT_PNG, Buffer.from(shot.data, 'base64'))
  console.log(`screenshot -> ${OUT_PNG}`)
}

ws.close()
