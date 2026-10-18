// Auto-open plumbing: Host pushes each preview URL over SSE; the Client half opens the tab.
//
//   node test/events.mjs [/path/to/kicad-tools]
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { apply } from '../lib/index.js'
import { EVENTS_ROUTE } from '../lib/events.js'

const root = process.argv[2] ?? `${process.env.HOME}/.kicad-tools`
const schematic = `${root}/examples/01-schematic-analysis/simple_rc.kicad_sch`

const failures = []
function check(label, ok, detail) {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

/* ---------- stub harness web server hosting the SSE route ---------- */

const routes = new Map()
const webServer = {
  register(route) {
    routes.set(`${route.kind}:${route.path}`, route)
    return () => routes.delete(`${route.kind}:${route.path}`)
  },
}

const server = createServer((req, res) => {
  const route = routes.get(`exact:${req.url}`) ?? routes.get(`prefix:${req.url}`)
  if (!route) {
    res.writeHead(404).end()
    return
  }
  route.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

/* ---------- mount plugin ---------- */

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

check('SSE route registered', routes.has(`exact:${EVENTS_ROUTE}`))

/* ---------- subscribe, then trigger a preview ---------- */

const received = []
await new Promise((resolve, reject) => {
  const req = httpRequest(
    { host: '127.0.0.1', port, path: EVENTS_ROUTE, method: 'GET', headers: { host: `127.0.0.1:${port}` } },
    (res) => {
      check('stream opens as text/event-stream', res.statusCode === 200 && String(res.headers['content-type']).startsWith('text/event-stream'), String(res.statusCode))
      res.setEncoding('utf8')
      let buffer = ''
      res.on('data', (chunk) => {
        buffer += chunk
        for (const frame of buffer.split('\n\n').slice(0, -1)) {
          const line = frame.split('\n').find((entry) => entry.startsWith('data: '))
          if (line === undefined) continue
          received.push(JSON.parse(line.slice(6)))
          if (received.length === 1) resolve()
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2)
      })
      setTimeout(() => reject(new Error('no event received')), 5000)
    },
  )
  req.on('error', reject)
  req.end()

  // Let the subscription register before the tool pushes.
  setTimeout(async () => {
    await tools.get('kicad_preview').execute({ path: schematic }, { agent: {}, signal: AbortSignal.timeout(10000) })
  }, 200)
})

check('client receives the preview URL', received.length === 1 && received[0].url.includes('/proj/'), JSON.stringify(received[0]))
check('event carries the file too', received[0].file === schematic)

/* ---------- non-loopback host is refused ---------- */

const forbidden = await new Promise((resolve) => {
  const req = httpRequest(
    { host: '127.0.0.1', port, path: EVENTS_ROUTE, method: 'GET', headers: { host: 'evil.example.com' } },
    (res) => resolve(res.statusCode),
  )
  req.end()
})
check('non-loopback host is refused', forbidden === 403, String(forbidden))

/* ---------- the client bundle is loadable in the expected shape ---------- */

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
check('client bundle uses the module loader', clientSource.includes('__ModuleLoader__.load'))
check('client bundle subscribes to the events route', clientSource.includes('/plugin/kicad-tool/events'))
check('client bundle opens a Sidebar browser tab', clientSource.includes("openTab('browser'"))

/* ---------- report ---------- */

server.close()
server.closeAllConnections?.()
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
console.log(`event checks passed (${version})`)
process.exit(0)
