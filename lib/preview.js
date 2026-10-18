/**
 * KiCanvas preview routes for dsh-kicad-tool.
 *
 * Serves the locally built KiCanvas bundle plus a tiny viewer page, so a KiCad file can be
 * inspected in a browser without installing anything else:
 *
 *   GET /plugin/kicanvas/view?file=/abs/path.kicad_pcb&controls=full&theme=kicad
 *   GET /plugin/kicanvas/file?file=/abs/path.kicad_pcb
 *   GET /plugin/kicanvas/kicanvas.js
 *   GET /plugin/kicanvas/status
 *
 * Everything is loopback-only, matching the trust model of the local GUI. Only KiCad file
 * extensions are ever served, so the routes cannot be used as a generic file reader.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** File types KiCanvas can render (plus project/rule files it understands). */
export const KICAD_EXTENSIONS = new Set([
  '.kicad_pcb',
  '.kicad_sch',
  '.kicad_sym',
  '.kicad_wks',
  '.kicad_pro',
  '.kicad_prj',
  '.kicad_dru',
])

/** Route prefix owned by the preview server. */
export const PREVIEW_PREFIX = '/plugin/kicanvas'

const MAX_FILE_BYTES = 64 * 1024 * 1024

function loopbackHost(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  if (host.startsWith('[')) return host.startsWith('[::1]')
  const name = host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function send(res, status, type, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body)
  res.writeHead(status, {
    'content-type': type,
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function sendJson(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`)
}

/**
 * Build the preview surface.
 * @param ctx - host context (webServer is read through `ctx.get` so profiles without it still load).
 * @param cfg - resolved plugin config (`kicanvasDir`).
 */
export function registerPreview(ctx, cfg) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer === undefined) return undefined

  const bundlePath = join(cfg.kicanvasDir, 'build', 'kicanvas.js')

  const readTarget = async (file) => {
    if (typeof file !== 'string' || file === '') return { error: 'missing file parameter' }
    const extension = file.slice(file.lastIndexOf('.')).toLowerCase()
    if (!KICAD_EXTENSIONS.has(extension)) {
      return { error: `only KiCad files are served (${[...KICAD_EXTENSIONS].join(', ')}), got "${extension}"` }
    }
    try {
      const info = await stat(file)
      if (!info.isFile()) return { error: 'not a regular file' }
      if (info.size > MAX_FILE_BYTES) return { error: `file is larger than ${MAX_FILE_BYTES} bytes` }
      return { body: await readFile(file), size: info.size }
    } catch (error) {
      return { error: `cannot read ${file}: ${error.message}` }
    }
  }

  const viewerHtml = (url, file) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(file.split('/').pop() ?? 'KiCanvas')} — KiCanvas</title>
<style>
  :root { color-scheme: dark light; }
  html, body { margin: 0; height: 100%; background: #1b1b1f; color: #d7d7dc; }
  body { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; gap: 12px; align-items: baseline; padding: 8px 14px; border-bottom: 1px solid #2f2f36; }
  header strong { font-weight: 600; }
  header code { color: #9a9aa5; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header a { margin-left: auto; color: #7cc7ff; text-decoration: none; font-size: 12px; }
  main { height: calc(100% - 38px); }
  kicanvas-embed { display: block; width: 100%; height: 100%; }
  .fail { padding: 18px; color: #ffb4b4; }
</style>
<script type="module" src="${PREVIEW_PREFIX}/kicanvas.js"></script>
</head>
<body>
<header>
  <strong>KiCanvas</strong>
  <code>${escapeHtml(file)}</code>
  <a href="${escapeHtml(url)}" download>download</a>
</header>
<main>
  <kicanvas-embed src="${escapeHtml(url)}" controls="${escapeHtml(viewerControls(url))}"></kicanvas-embed>
</main>
</body>
</html>`

  // `controls`/`theme` are validated by the caller; defaults keep the page usable on its own.
  const viewerControls = () => 'full'

  const handle = async (req, res) => {
    if (!loopbackHost(req)) {
      sendJson(res, 403, { error: 'loopback only' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(PREVIEW_PREFIX.length) || '/'

    if (route === '/status') {
      let ready = false
      try {
        ready = (await stat(bundlePath)).isFile()
      } catch {
        ready = false
      }
      sendJson(res, 200, { ok: true, bundle: ready, bundlePath, kicanvasDir: cfg.kicanvasDir })
      return
    }

    if (route === '/kicanvas.js') {
      try {
        const body = await readFile(bundlePath)
        send(res, 200, 'text/javascript; charset=utf-8', body)
      } catch {
        send(
          res,
          503,
          'text/plain; charset=utf-8',
          `KiCanvas bundle not built at ${bundlePath}\n\n` +
            `cd ${cfg.kicanvasDir} && npm ci && npm run build\n`,
        )
      }
      return
    }

    const file = url.searchParams.get('file')

    if (route === '/file') {
      const target = await readTarget(file)
      if (target.error !== undefined) {
        send(res, 404, 'text/plain; charset=utf-8', `${target.error}\n`)
        return
      }
      send(res, 200, 'text/plain; charset=utf-8', target.body)
      return
    }

    if (route === '/' || route === '/view') {
      const target = await readTarget(file)
      if (target.error !== undefined) {
        send(res, 404, 'text/html; charset=utf-8', `<h1>KiCanvas</h1><p class="fail">${escapeHtml(target.error)}</p>`)
        return
      }
      const controls = url.searchParams.get('controls') ?? 'full'
      const allowedControls = new Set(['none', 'basic', 'full'])
      const fileUrl = `${PREVIEW_PREFIX}/file?file=${encodeURIComponent(file)}`
      const html = viewerHtml(fileUrl, file).replace('controls="full"', `controls="${allowedControls.has(controls) ? controls : 'full'}"`)
      send(res, 200, 'text/html; charset=utf-8', html)
      return
    }

    sendJson(res, 404, { error: `no route ${route}` })
  }

  const dispose = webServer.register({
    kind: 'prefix',
    path: PREVIEW_PREFIX,
    handler: (req, res) => {
      handle(req, res).catch((error) => {
        try {
          sendJson(res, 500, { error: String(error?.message ?? error) })
        } catch {
          /* response already gone */
        }
      })
    },
  })
  return dispose
}
