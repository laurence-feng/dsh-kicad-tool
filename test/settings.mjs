// Settings backend: config persistence, repository status, guarded actions, purge safety.
//
//   node test/settings.mjs
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const home = mkdtempSync(join(tmpdir(), 'kicad-settings-'))
process.env.DSH_HOME = home

// A PATH with only a fake git: uv/npm are then "missing", which is what the page reports.
const bin = join(home, 'bin')
mkdirSync(bin, { recursive: true })
for (const name of ['git']) {
  const file = join(bin, name)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
}
process.env.PATH = bin

const failures = []
function check(label, ok, detail) {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

/* ---------- mount with a stub web server ---------- */

const routes = new Map()
const webServer = {
  register(route) {
    routes.set(`${route.kind}:${route.path}`, route)
    return () => routes.delete(`${route.kind}:${route.path}`)
  },
}
apply(
  {
    tools: { register: () => () => {} },
    workingDirectory: { ensure: async () => process.cwd() },
    get: (name) => (name === 'webServer' ? webServer : undefined),
    effect: (factory) => factory(),
  },
  {},
)

function request(method, path, body, host = '127.0.0.1:1234') {
  const route = routes.get(`exact:${path}`)
  if (route === undefined) return Promise.resolve({ status: 404, text: '' })
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(payload === '' ? [] : [Buffer.from(payload)])
  req.method = method
  req.url = path
  req.headers = { host, 'content-type': 'application/json' }
  return new Promise((resolve) => {
    const chunks = []
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        this.headers = headers ?? {}
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try {
          json = JSON.parse(text)
        } catch {
          json = undefined
        }
        resolve({ status: this.status, text, json })
      },
    }
    route.handler(req, res)
  })
}

/* ---------- state ---------- */

const initial = await request('GET', '/plugin/kicad-tool/state')
check('state answers', initial.status === 200, String(initial.status))
check(
  'default paths live under the managed root',
  initial.json.config.kicadToolsDir.endsWith('/.local/share/dsh-kicad-tool/kicad-tools'),
  initial.json.config.kicadToolsDir,
)
check('both repositories are reported', Object.keys(initial.json.repos).length === 2)
check('nothing is installed yet', initial.json.repos['kicad-tools'].installed === false)
check('missing npm is reported', initial.json.dependencies.npm === null, String(initial.json.dependencies.npm))
check(
  'uninstall command is provided',
  typeof initial.json.uninstallCommand === 'string' && initial.json.uninstallCommand.includes('remove dsh-kicad-tool'),
)

/* ---------- config ---------- */

const relative = await request('PUT', '/plugin/kicad-tool/config', { kicadToolsDir: 'relative/path' })
check('relative paths are rejected', relative.status === 400, relative.text)

const kctDir = join(home, 'kicad-tools')
const canvasDir = join(home, 'kicanvas')
const saved = await request('PUT', '/plugin/kicad-tool/config', { kicadToolsDir: kctDir, kicanvasDir: canvasDir })
check('paths save', saved.status === 200, saved.text)
check('settings file written', existsSync(join(home, 'kicad-tool.json')))
const stored = JSON.parse(readFileSync(join(home, 'kicad-tool.json'), 'utf8'))
check('stored paths match', stored.kicadToolsDir === kctDir && stored.kicanvasDir === canvasDir, JSON.stringify(stored))
check('state reflects the new path', saved.json.config.kicanvasDir === canvasDir)

const mutating = await request('PUT', '/plugin/kicad-tool/config', { allowMutating: true })
check('allowMutating persists', mutating.json.config.allowMutating === true)

/* ---------- actions ---------- */

const badTarget = await request('POST', '/plugin/kicad-tool/action', { target: 'nope', action: 'install' })
check('unknown target is refused', badTarget.status === 409, badTarget.text)

const missingDeps = await request('POST', '/plugin/kicad-tool/action', { target: 'kicanvas', action: 'install' })
check(
  'install reports the missing command with a hint',
  missingDeps.status === 409 && /missing command\(s\): npm/.test(missingDeps.text) && /brew install node/.test(missingDeps.text),
  missingDeps.text,
)

const updateMissing = await request('POST', '/plugin/kicad-tool/action', { target: 'kicad-tools', action: 'update' })
check('update requires an install', updateMissing.status === 409 && /not installed/.test(updateMissing.text), updateMissing.text)

/* ---------- purge safety ---------- */

// A directory at the configured path that is NOT the expected repository must survive.
mkdirSync(canvasDir, { recursive: true })
writeFileSync(join(canvasDir, 'package.json'), '{"name":"something-else"}')
const purged = await request('POST', '/plugin/kicad-tool/purge')
check('purge answers', purged.status === 200, purged.text)
check('purge leaves foreign directories alone', purged.json.removed.length === 0 && existsSync(join(canvasDir, 'package.json')), JSON.stringify(purged.json))

// A directory that does look like the repository is removed.
writeFileSync(join(canvasDir, 'package.json'), '{"name": "kicanvas"}')
const removed = await request('POST', '/plugin/kicad-tool/purge')
check('purge removes the managed checkout', removed.json.removed.includes(canvasDir), JSON.stringify(removed.json))
check('purge deletes it from disk', !existsSync(canvasDir))

/* ---------- routes wait for the webServer service ---------- */

// The service is usually constructed after the plugin applies; ctx.inject must be used, or every
// route silently never exists (the page then reports HTTP 404).
const lateRoutes = new Map()
const lateWebServer = {
  register(route) {
    lateRoutes.set(`${route.kind}:${route.path}`, route)
    return () => lateRoutes.delete(`${route.kind}:${route.path}`)
  },
}
let injected = false
apply(
  {
    tools: { register: () => () => {} },
    workingDirectory: { ensure: async () => process.cwd() },
    effect: (factory) => factory(),
    inject: (deps, callback) => {
      injected = deps.includes('webServer')
      callback({ get: (name) => (name === 'webServer' ? lateWebServer : undefined), effect: (factory) => factory() })
    },
  },
  {},
)
check('plugin waits for webServer through ctx.inject', injected)
check('state route exists once the service arrives', lateRoutes.has('exact:/plugin/kicad-tool/state'), [...lateRoutes.keys()].join(', '))
check('events route exists once the service arrives', lateRoutes.has('exact:/plugin/kicad-tool/events'))

/* ---------- loopback only ---------- */

const forbidden = await request('GET', '/plugin/kicad-tool/state', undefined, 'evil.example.com')
check('non-loopback hosts are refused', forbidden.status === 403, String(forbidden.status))

/* ---------- report ---------- */

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
console.log(`settings checks passed (${version})`)
process.exit(0)
