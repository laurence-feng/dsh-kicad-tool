/**
 * KiCanvas preview server for dsh-kicad-tool.
 *
 * Why a dedicated listener instead of a route on the harness web server: the in-app browser
 * refuses to open the DSH application's own origin ("error.application-origin"), so a preview
 * URL on the GUI's port loads in an external browser but not in the sidebar browser. A tiny
 * loopback server on its own ephemeral port gives the viewer a distinct origin, which the
 * embedded browser accepts.
 *
 * Routes (KiCanvas names documents by URL basename, hence the directory-mirroring shape):
 *
 *   GET /proj/<base64url(dir)>/<name>?view=1   viewer page (HTML)
 *   GET /proj/<base64url(dir)>/<name>          the KiCad file (text/plain)
 *   GET /kicanvas.js                           the local KiCanvas bundle
 *   GET /status                                build state + paths
 *
 * Sibling `.kicad_sch`/`.kicad_pcb`/`.kicad_pro` files are listed as `<kicanvas-source>`, so a
 * hierarchical project resolves its sheets relative to the page URL and loads as one project.
 *
 * Only KiCad extensions are served, names must be a single path segment inside the project
 * directory, files are capped at 64 MB, and the listener answers loopback Hosts only.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

/** File types KiCanvas can render (plus the project file it pairs with). */
export const KICAD_EXTENSIONS = new Set([
  '.kicad_pcb',
  '.kicad_sch',
  '.kicad_sym',
  '.kicad_wks',
  '.kicad_pro',
  '.kicad_prj',
  '.kicad_dru',
])

/** Maximum number of sibling files exposed to the viewer. */
const MAX_SIBLINGS = 300

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

/** URL-safe token for a directory path. */
export function encodeDir(dir) {
  return Buffer.from(dir, 'utf8').toString('base64url')
}

/** Decode a directory token; returns null when it is not valid UTF-8. */
export function decodeDir(token) {
  try {
    const value = Buffer.from(token, 'base64url').toString('utf8')
    return value === '' ? null : value
  } catch {
    return null
  }
}

/**
 * Start the preview listener on an ephemeral loopback port.
 * @param cfg - resolved plugin config (`kicanvasDir`).
 * @returns the origin, the port, and a close function.
 */
export async function startPreviewServer(cfg) {
  const bundlePath = join(cfg.kicanvasDir, 'build', 'kicanvas.js')

  const readTarget = async (dir, name) => {
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      return { error: 'file name must be a single path segment' }
    }
    const extension = extname(name).toLowerCase()
    if (!KICAD_EXTENSIONS.has(extension)) {
      return { error: `only KiCad files are served (${[...KICAD_EXTENSIONS].join(', ')}), got "${extension}"` }
    }
    const file = resolve(dir, name)
    if (!file.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)) return { error: 'path escapes the project directory' }
    try {
      const info = await stat(file)
      if (!info.isFile()) return { error: 'not a regular file' }
      if (info.size > MAX_FILE_BYTES) return { error: `file is larger than ${MAX_FILE_BYTES} bytes` }
      return { body: await readFile(file), size: info.size, file }
    } catch (error) {
      return { error: `cannot read ${name}: ${error.message}` }
    }
  }

  /** Sibling KiCad files, root first, so a hierarchical project loads as a project. */
  const listSiblings = async (dir, rootName) => {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return [rootName]
    }
    const names = entries
      .filter((entry) => entry.isFile() && KICAD_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_SIBLINGS)
    return [rootName, ...names.filter((name) => name !== rootName)]
  }

  const viewerHtml = (dir, rootName, siblings, controls) => {
    const sources = siblings
      .map((name) => `  <kicanvas-source src="${escapeHtml(encodeURIComponent(name))}"></kicanvas-source>`)
      .join('\n')
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(rootName)} — KiCanvas</title>
<style>
  :root { color-scheme: dark light; }
  html, body { margin: 0; height: 100%; background: #1b1b1f; color: #d7d7dc; }
  body { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; gap: 12px; align-items: baseline; padding: 8px 14px; border-bottom: 1px solid #2f2f36; }
  header strong { font-weight: 600; }
  header code { color: #9a9aa5; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header span { margin-left: auto; color: #8a8a94; font-size: 12px; white-space: nowrap; }
  main { height: calc(100% - 38px); }
  kicanvas-embed { display: block; width: 100%; height: 100%; }
</style>
<script type="module" src="/kicanvas.js"></script>
</head>
<body>
<header>
  <strong>KiCanvas</strong>
  <code>${escapeHtml(rootName)}</code>
  <span>${escapeHtml(dir)} · ${siblings.length} file${siblings.length === 1 ? '' : 's'}</span>
</header>
<main>
<kicanvas-embed controls="${controls}">
${sources}
</kicanvas-embed>
</main>
</body>
</html>`
  }

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
    const route = url.pathname

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
        send(res, 200, 'text/javascript; charset=utf-8', await readFile(bundlePath))
      } catch {
        send(
          res,
          503,
          'text/plain; charset=utf-8',
          `KiCanvas bundle not built at ${bundlePath}\n\ncd ${cfg.kicanvasDir} && npm ci && npm run build\n`,
        )
      }
      return
    }

    const match = /^\/proj\/([A-Za-z0-9_-]+)\/([^/]+)$/.exec(route)
    if (match === null) {
      sendJson(res, 404, { error: `no route ${route}` })
      return
    }
    const dir = decodeDir(match[1])
    if (dir === null) {
      sendJson(res, 400, { error: 'invalid project token' })
      return
    }
    let name
    try {
      name = decodeURIComponent(match[2])
    } catch {
      sendJson(res, 400, { error: 'invalid file name encoding' })
      return
    }

    const target = await readTarget(dir, name)
    if (target.error !== undefined) {
      send(res, 404, 'text/plain; charset=utf-8', `${target.error}\n`)
      return
    }

    if (url.searchParams.has('view')) {
      const requested = url.searchParams.get('controls')
      const controls = requested === 'basic' || requested === 'none' ? requested : 'full'
      send(res, 200, 'text/html; charset=utf-8', viewerHtml(dir, name, await listSiblings(dir, name), controls))
      return
    }

    send(res, 200, 'text/plain; charset=utf-8', target.body)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      try {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      } catch {
        /* response already gone */
      }
    })
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const port = server.address().port
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((done) => {
        server.close(() => done())
        server.closeAllConnections?.()
      }),
  }
}
