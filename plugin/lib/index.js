/**
 * dsh-desktop-overlay —— host 半边
 *
 * 步骤 1 的目标只有一个：**验证「独立型插件的前端能否脱离 DSH 的 SPA 独立运行」**。
 * 所以这里只做两件事：
 *
 *   1. 注册一条 overlay 页面 route。页面本体在 `plugin/page/index.html` ——
 *      **故意外置成文件**：host 代码改动要重启 DSH 客户端才生效，页面外置之后，
 *      调整页面只要刷新浏览器（改 host 逻辑才需要重启）。
 *   2. 把带凭据（token）的 URL 落到文件里，方便直接从外部打开。
 *
 * 页面由 DSH 自己的 webServer 提供，所以页面 origin 就是 DSH 的 origin —— 插件前端里的
 * 相对路径请求（例如 `/dsh-whale/roles.json`）都是同源的，插件代码一行都不用改。
 *
 * 窗口那一半（Electron 外壳）在 `shell/`，步骤 2 才做。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-desktop-overlay'

/* connection 用可选访问，不写进 inject：拿不到时退化成不带 token 的 URL，
   而不是让整个插件加载失败。 */
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = dirname(HERE) // plugin/
const PROJECT_ROOT = dirname(PACKAGE_ROOT) // 项目根
const URL_FILE = join(PROJECT_ROOT, '.launch-url.txt')
const PAGE_FILE = join(PACKAGE_ROOT, 'page', 'index.html')

const MOUNT = '/dsh-overlay'

async function renderPage() {
  try {
    return await readFile(PAGE_FILE, 'utf8')
  } catch (error) {
    const message = String(error?.message ?? error)
    console.error('[dsh-desktop-overlay] cannot read overlay page:', message)
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DSH overlay: page missing</title></head>
<body style="font:14px/1.6 system-ui;padding:24px">
<h1>overlay 页面读不到</h1>
<p>期望的文件：<code>${PAGE_FILE}</code></p>
<pre>${message}</pre>
</body></html>
`
  }
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: MOUNT,
        handler: async (req, res) => {
          const html = await renderPage()
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(html)
        },
      }),
    'dsh-desktop-overlay:page',
  )

  const port = ctx.webServer.port
  if (typeof port !== 'number') {
    console.error('[dsh-desktop-overlay] webServer has no port; overlay URL not written')
    return
  }

  const root = `http://127.0.0.1:${String(port)}/`
  const page = `http://127.0.0.1:${String(port)}${MOUNT}`
  const connection = ctx.get('connection')
  const login =
    connection !== undefined && typeof connection.authenticatedUrl === 'function'
      ? connection.authenticatedUrl(root)
      : root

  /* token 只在 index 请求上生效：它会 303 到干净路径并种下 dsh-auth-* 会话 cookie。
     所以顺序是「先 login、再 page」——Electron 外壳那边也是同一个道理（同一个 session 里
     先 loadURL(login) 再 loadURL(page)）。

     token 是 fresh process token，每次启动都会变；这个文件不进 git。 */
  const text = [
    '# 先打开 login 建立会话（303 会种 cookie），再打开 page',
    `login=${login}`,
    `page=${page}`,
    '',
  ].join('\n')

  void writeFile(URL_FILE, text, 'utf8').then(
    () => console.log(`[dsh-desktop-overlay] overlay URL -> ${URL_FILE}`),
    (error) => console.error('[dsh-desktop-overlay] cannot write URL file:', error),
  )
}
