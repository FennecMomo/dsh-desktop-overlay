/**
 * dsh-desktop-overlay —— host 半边
 *
 * 步骤 1 的目标只有一个：**用普通浏览器验证「独立型插件的前端能否脱离 DSH 的 SPA 独立运行」**。
 * 所以这里只做两件事：
 *
 *   1. 注册一条 overlay 页面 route，页面里只引入白名单插件的前端脚本；
 *   2. 把一条带凭据（token）的 URL 落到文件里，方便直接从外部打开。
 *
 * 页面由 DSH 自己的 webServer 提供，所以页面 origin 就是 DSH 的 origin —— 插件前端里的
 * 相对路径请求（例如 `/dsh-whale/roles.json`）都是同源的，插件代码一行都不用改。
 *
 * 窗口那一半（Electron 外壳）在 `shell/`，步骤 2 才做。
 */
import { writeFile } from 'node:fs/promises'
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

const MOUNT = '/dsh-overlay'

/**
 * 白名单：overlay 页面里要引入的前端脚本。**必须与 DSH 同源**（相对路径）。
 *
 * 只有「独立型」前端能放进来 —— 自己 createElement、自己挂 body、只用相对路径 fetch、
 * 不依赖 DSH 特有的全局。通过 slot 或 React 组件挂进 DSH UI 树的「插槽型」前端放进来
 * 也渲染不出来，因为它们需要 DSH 的 slot 运行时。
 */
const WHITELIST = ['/dsh-whale/widget.js']

function renderPage() {
  const scripts = WHITELIST.map((src) => `<script src="${src}"></script>`).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH overlay</title>
<style>
  /* overlay 窗口会设成 transparent；页面自身不能有底色，否则整块屏幕被盖住。 */
  html, body { margin: 0; padding: 0; height: 100%; background: transparent; }
  body { overflow: hidden; }
</style>
</head>
<body>
${scripts}
</body>
</html>
`
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: MOUNT,
        handler: (req, res) => {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(renderPage())
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
