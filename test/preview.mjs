// Preview routes + kicad_preview tool, exercised against a stub host web server.
//
//   node test/preview.mjs [/path/to/kicad-tools]
import { readFileSync } from 'node:fs'
import { apply } from '../lib/index.js'

const root = process.argv[2] ?? `${process.env.HOME}/.kicad-tools`
const schematic = `${root}/examples/01-schematic-analysis/simple_rc.kicad_sch`

const failures = []
function check(label, ok, detail) {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

/* ---------- stub web server ---------- */

let route
const webServer = {
  origin: 'http://127.0.0.1:65535',
  register(spec) {
    route = spec
    return () => {}
  },
}

function request(url, { method = 'GET', host = '127.0.0.1:65535' } = {}) {
  return new Promise((resolve) => {
    const chunks = []
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        this.headers = headers ?? {}
      },
      end(body) {
        if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body))
        resolve({ status: this.status, headers: this.headers, body: Buffer.concat(chunks).toString('utf8') })
      },
    }
    route.handler({ method, url, headers: { host } }, res)
  })
}

/* ---------- mount ---------- */

const tools = new Map()
apply(
  {
    tools: { register: (definition) => (tools.set(definition.name, definition), () => {}) },
    workingDirectory: { ensure: async () => process.cwd() },
    get: (name) => (name === 'webServer' ? webServer : undefined),
    effect: (factory) => factory(),
  },
  { kicanvasDir: `${process.env.HOME}/.kicanvas` },
)

check('route registered under the preview prefix', route?.kind === 'prefix' && route?.path === '/plugin/kicanvas')
check('kicad_preview tool registered', tools.has('kicad_preview'))

/* ---------- routes ---------- */

const status = await request('/plugin/kicanvas/status')
check('status answers JSON', status.status === 200 && JSON.parse(status.body).ok === true, status.body.slice(0, 120))
check('status reports the bundle', JSON.parse(status.body).bundle === true, JSON.parse(status.body).bundlePath)

const bundle = await request('/plugin/kicanvas/kicanvas.js')
check('bundle is served as JavaScript', bundle.status === 200 && bundle.headers['content-type'].includes('javascript') && bundle.body.length > 10000, `status ${bundle.status}, ${bundle.body.length} bytes`)

const file = await request(`/plugin/kicanvas/file?file=${encodeURIComponent(schematic)}`)
check('kicad file is served as text', file.status === 200 && file.body.includes('kicad_sch'))

const denied = await request('/plugin/kicanvas/file?file=%2Fetc%2Fpasswd')
check('non-KiCad paths are refused', denied.status === 404 && denied.body.includes('only KiCad files'))

const view = await request(`/plugin/kicanvas/view?file=${encodeURIComponent(schematic)}&controls=basic`)
check('viewer page embeds kicanvas', view.status === 200 && view.body.includes('<kicanvas-embed') && view.body.includes('/plugin/kicanvas/kicanvas.js'))
check('viewer honours controls', view.body.includes('controls="basic"'))

const forbidden = await request('/plugin/kicanvas/status', { host: 'evil.example.com' })
check('non-loopback hosts are refused', forbidden.status === 403)

/* ---------- tool ---------- */

const preview = await tools.get('kicad_preview').execute({ path: schematic }, { agent: {}, signal: AbortSignal.timeout(5000) })
check('kicad_preview returns a viewer URL', preview.url.startsWith('http://127.0.0.1:65535/plugin/kicanvas/view?file='), preview.url)
check('kicad_preview reports the file', preview.file === schematic && preview.size > 0)
check('kicad_preview reports bundle readiness', preview.bundleReady === true)
check('kicad_preview render mentions the URL', tools.get('kicad_preview').output.render({}, preview)[0].text.includes(preview.url))

let rejected = false
try {
  await tools.get('kicad_preview').execute({ path: '/etc/passwd' }, { agent: {}, signal: AbortSignal.timeout(5000) })
} catch {
  rejected = true
}
check('kicad_preview rejects non-KiCad files', rejected)

/* ---------- report ---------- */

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
console.log(`preview checks passed (${readFileSync(new URL('../package.json', import.meta.url), 'utf8').match(/"version":\s*"([^"]+)"/)[1]})`)
