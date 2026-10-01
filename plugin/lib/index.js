/**
 * dsh-desktop-overlay —— host 半边
 *
 * 做三件事：
 *
 *   1. 注册一条 overlay 页面 route。页面本体在 `plugin/page/index.html` ——
 *      **故意外置成文件**：host 代码改动要重启 DSH 客户端才生效，页面外置之后，
 *      调整页面只要刷新就行（改 host 逻辑才需要重启）。
 *      白名单（要引入哪些插件前端）在下面的 `WHITELIST` 里，渲染时注入进页面。
 *   2. 把带凭据（token）的 URL 落到文件里，方便手工打开排查。
 *   3. **把桌面外壳拉起来**（复用 DSH 自带 Electron 运行时的那个 exe）。外壳自己会：
 *      等 DSH 最小化/进托盘才浮出来、恢复就藏回去、DSH 退出就跟着退。
 *
 * 页面由 DSH 自己的 webServer 提供，所以页面 origin 就是 DSH 的 origin —— 插件前端里的
 * 相对路径请求（例如 `/dsh-whale/roles.json`）都是同源的，插件代码一行都不用改。
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-desktop-overlay'

/**
 * `connection` 是**硬依赖**，别把它降级成可选访问。
 *
 * `authenticatedUrl()` 会给 URL 加上 fresh process token —— 那是外壳换取会话 cookie 的
 * **唯一凭据**。而 DSH 启动过程中，插件有可能在 connection 注册之前就被加载：那时
 * `ctx.get('connection')` 返回 undefined，login URL 里就没有 token，外壳照样能起来、
 * 照样能显示，但**永远取不到数据**（余额空着），而且它自己不会报错 —— 一个哑症。
 * 放进 inject 之后，Cordis 会等它就绪再加载本插件。
 */
export const inject = ['webServer', 'subprocess', 'connection']

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = dirname(HERE) // plugin/
const PROJECT_ROOT = dirname(PACKAGE_ROOT) // 项目根
const URL_FILE = join(PROJECT_ROOT, '.launch-url.txt')
const PAGE_FILE = join(PACKAGE_ROOT, 'page', 'index.html')
/* 复用 DSH 那份 Electron 44 运行时的副本（`runtime/` 在 .gitignore 里，由 README 的步骤准备）。 */
const SHELL_EXE = join(PROJECT_ROOT, 'runtime', 'DeepSeek Harness.exe')

const MOUNT = '/dsh-overlay'

/**
 * 白名单：overlay 页面里要引入的前端脚本。**必须与 DSH 同源**（相对路径）。
 *
 * 只有「独立型」前端能放进来 —— 自己 createElement、自己挂 body、只用相对路径 fetch、
 * 不依赖 DSH 特有的全局。通过 slot 或 React 组件挂进 DSH UI 树的「插槽型」前端放进来
 * 也渲染不出来，因为它们需要 DSH 的 slot 运行时。
 *
 * 每一条都是**别的插件**提供的路由，所以这里天然带着一层跨插件依赖：条目对应的插件没装、
 * 被停用、或者路由改了名，这一条就是一个 404。加载失败只让那个挂件消失，不影响 overlay
 * 自己的启动（页面脚本是普通 `<script src>`，不是会 reject 掉 boot 的那种注入行）。
 */
const WHITELIST = [
  '/dsh-whale/widget.js',
  /*
   * 弹幕浮层（dsh-danmaku）。
   *
   * DSH 页面里那份也是同一个文件 —— 弹幕插件把同一份脚本注进 DSH 的 index，
   * 这里只是把它再挂一次。两边因此长得一样、说的话也一样；区别只在承载它的是哪个窗口：
   * DSH 可见时它在会话页里，DSH 最小化时它在 overlay 这层透明置顶窗口里，
   * 而"透明 + 置顶 + 鼠标穿透"完全由这个外壳提供，弹幕那边一行 Win32 都没有。
   */
  '/dsh-danmaku/v3/bubbles.js',
]

/** 把白名单注入页面：HTML 里的 `<!--WHITELIST-->` 占位符换成 script 标签。 */
function injectWhitelist(html) {
  const scripts = WHITELIST.map((src) => `<script src="${src}"></script>`).join('\n')
  return html.includes('<!--WHITELIST-->') ? html.replace('<!--WHITELIST-->', scripts) : html
}

async function renderPage() {
  try {
    return injectWhitelist(await readFile(PAGE_FILE, 'utf8'))
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

/**
 * 拉起桌面外壳。
 *
 * 两个必须做对的地方（都是踩出来的）：
 *   - **清掉 `ELECTRON_RUN_AS_NODE`**：DSH 派生的子进程带着它，会让那个 exe 以 Node 模式启动、
 *     报 `bad option` 后 exit 9，看起来像「窗口起不来」。
 *   - **参数用 `--name=value` 形式**：Electron 会把裸参数当 app 路径。
 */
function startShell(ctx, loginUrl, pageUrl) {
  if (!existsSync(SHELL_EXE)) {
    console.error(`[dsh-desktop-overlay] 外壳 exe 不存在：${SHELL_EXE}（见 README 准备 runtime/）`)
    return { ok: false, reason: 'shell exe missing' }
  }

  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) return { ok: false, reason: 'no subprocess service' }

  try {
    const handle = subprocess.spawn({
      argv: [SHELL_EXE, `--login=${loginUrl}`, `--page=${pageUrl}`],
      cwd: PROJECT_ROOT,
      stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      graceMs: 5000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    })
    console.log('[dsh-desktop-overlay] 桌面外壳已拉起')
    return { ok: true, handle }
  } catch (error) {
    const reason = String(error?.message ?? error)
    console.error('[dsh-desktop-overlay] 拉起外壳失败：', reason)
    return { ok: false, reason }
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
    console.error('[dsh-desktop-overlay] webServer has no port; overlay not started')
    return
  }

  const root = `http://127.0.0.1:${String(port)}/`
  const page = `http://127.0.0.1:${String(port)}${MOUNT}`
  const login = ctx.connection.authenticatedUrl(root)

  /* 自检：没有 token 就当场喊出来，别让它变成「外壳起来了但取不到数据」这种哑症。 */
  if (!login.includes('token=')) {
    console.error(`[dsh-desktop-overlay] login URL 缺少 token，外壳将无法建立会话：${login}`)
  }

  /* token 只在 index 请求上生效：它会 303 到干净路径并种下 dsh-auth-* 会话 cookie。
     所以顺序是「先 login、再 page」——外壳内部也是这个顺序（先换 cookie 再导航）。

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

  /* 外壳跟着插件一起生灭：插件卸载（DSH 退出、配置重载）时把它收掉。
     外壳自己带单实例锁，所以重复拉起是安全的（多余的会立刻退出）。 */
  ctx.effect(() => {
    const started = startShell(ctx, login, page)
    return () => {
      if (started.ok && started.handle !== undefined) {
        try {
          started.handle.terminate()
        } catch (error) {
          console.error('[dsh-desktop-overlay] 收掉外壳失败：', String(error?.message ?? error))
        }
      }
    }
  }, 'dsh-desktop-overlay:shell')
}
