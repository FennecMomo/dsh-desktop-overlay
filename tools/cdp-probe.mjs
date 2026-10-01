/**
 * tools/cdp-probe.mjs —— 用 CDP 驱动一个**独立的** Edge 实例，验证 overlay 页面里的挂件
 * 能不能启动、能不能渲染，并截图留证。
 *
 * 它连的是 `--remote-debugging-port` 上的那个实例（通常是无头启动的），不会碰用户自己
 * 开着的浏览器。
 *
 * 用法：
 *   LOGIN_URL='http://127.0.0.1:<port>/?token=...' \
 *   PAGE_URL='http://127.0.0.1:<port>/dsh-overlay' \
 *   OUT_PNG='...png' \
 *   node tools/cdp-probe.mjs
 */
import { writeFileSync } from 'node:fs'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const LOGIN_URL = process.env.LOGIN_URL ?? ''
const PAGE_URL = process.env.PAGE_URL ?? ''
const OUT_PNG = process.env.OUT_PNG ?? 'cdp-shot.png'
const BASE = `http://127.0.0.1:${String(PORT)}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function json(path, method = 'GET') {
  const response = await fetch(BASE + path, { method })
  if (!response.ok) throw new Error(`${method} ${path} -> ${String(response.status)}`)
  return await response.json()
}

/** 极简 CDP client：一条 WebSocket，id 配对 + 事件收集。 */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    const events = []
    let nextId = 1

    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++
          return new Promise((res, rej) => {
            pending.set(id, { res, rej })
            ws.send(JSON.stringify({ id, method, params }))
          })
        },
        events,
        close: () => ws.close(),
      })
    })
    ws.addEventListener('error', (event) => reject(new Error(`websocket error: ${String(event?.message ?? '')}`)))
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(JSON.stringify(msg.error)))
        else res(msg.result)
        return
      }
      if (msg.method) events.push(msg)
    })
  })
}

/** 等到页面加载完成（或超时），只看一次 load。 */
async function navigateAndSettle(cdp, url, settleMs = 2500) {
  const before = cdp.events.length
  await cdp.send('Page.navigate', { url })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const hit = cdp.events.slice(before).some((e) => e.method === 'Page.loadEventFired')
    if (hit) break
    await sleep(150)
  }
  await sleep(settleMs)
}

const targets = await json('/json/list')
let page = targets.find((t) => t.type === 'page')
if (page === undefined) page = await json('/json/new?about:blank', 'PUT')

const cdp = await connect(page.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')

const report = { steps: [] }

/* 1) 先走 login：它 303 到干净路径并种下 dsh-auth-* 会话 cookie。 */
if (LOGIN_URL !== '') {
  await navigateAndSettle(cdp, LOGIN_URL)
  const cookies = await cdp.send('Network.getAllCookies').catch(() => null)
  report.steps.push({ step: 'login', url: LOGIN_URL, cookies: cookies?.cookies?.length ?? null })
}

/* 2) 打开 overlay 页面。 */
await navigateAndSettle(cdp, PAGE_URL)

/* 3) 注入启动闸门（旧版页面没有 #root；重启客户端后页面自带）。 */
const inject =
  "if(!document.getElementById('root'))document.body.insertAdjacentHTML('afterbegin','<div id=\"root\"><div data-composer-input=\"true\"></div></div>');'injected'"
report.inject = (await cdp.send('Runtime.evaluate', { expression: inject, returnByValue: true })).result?.value

await sleep(3000)

/* 4) 收集诊断。 */
const diagExpr = `JSON.stringify({
  scriptLoaded: !!window.__dshWhaleWidget,
  init: !!window.__dshWhaleInit,
  root: !!document.getElementById('root'),
  composer: !!document.querySelector('[data-composer-input]'),
  widgetNodes: document.querySelectorAll('[class*=dshwv]').length,
  rootNodes: document.querySelectorAll('.dshwv-root').length,
  title: document.title,
  bodyChildren: document.body.children.length,
  whaleImg: (function(){var i=document.querySelector('.dshwv-root img');return i?i.getAttribute('src'):null})(),
  balanceText: (function(){var n=document.querySelector('[class*=dshwv]');
    return n?String(n.textContent||'').replace(/\\s+/g,' ').slice(0,200):null})()
})`
const diag = await cdp.send('Runtime.evaluate', { expression: diagExpr, returnByValue: true })
report.diag = JSON.parse(diag.result?.value ?? '{}')

/* 4b) 从**页面内部**验证数据链路：这个 fetch 会带上 login 得到的会话 cookie。 */
const apiProbe = await cdp.send('Runtime.evaluate', {
  expression: `(async function(){try{
    var r=await fetch('/dsh-whale/balance.json',{cache:'no-store'});
    var j=await r.json();
    return JSON.stringify({status:r.status,ok:j.ok,totalBalance:j.totalBalance,todayUsage:j.todayUsage,source:j.balanceSource});
  }catch(e){return 'ERR '+String(e)}})()`,
  awaitPromise: true,
  returnByValue: true,
})
report.pageFetch = apiProbe.result?.value

/* 4c) 点一下角色，看泡泡里有没有真数字。 */
const box = await cdp.send('Runtime.evaluate', {
  expression: `(function(){var i=document.querySelector('.dshwv-root img');if(!i)return null;
    var b=i.getBoundingClientRect();return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)})})()`,
  returnByValue: true,
})
report.roleBox = box.result?.value
if (box.result?.value) {
  const point = JSON.parse(box.result.value)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
  await sleep(1500)
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const out2 = OUT_PNG.replace(/\.png$/, '-clicked.png')
  writeFileSync(out2, Buffer.from(shot2.data, 'base64'))
  report.screenshot2 = out2
  const after = await cdp.send('Runtime.evaluate', {
    expression: `String(document.querySelector('.dshwv-root')?.textContent||'').replace(/\\s+/g,' ').slice(0,300)`,
    returnByValue: true,
  })
  report.roleTextAfterClick = after.result?.value
}

/* 5) 截图。 */
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT_PNG, Buffer.from(shot.data, 'base64'))
report.screenshot = OUT_PNG

cdp.close()
console.log(JSON.stringify(report, null, 2))
