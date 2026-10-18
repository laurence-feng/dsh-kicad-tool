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
check('only kicad-tools is managed (KiCanvas is vendored)', Object.keys(initial.json.repos).join(',') === 'kicad-tools', Object.keys(initial.json.repos).join(','))
check('missing uv is reported', initial.json.dependencies.uv === null, String(initial.json.dependencies.uv))
check(
  'uninstall command is provided',
  typeof initial.json.uninstallCommand === 'string' && initial.json.uninstallCommand.includes('remove dsh-kicad-tool'),
)

/* ---------- config ---------- */

const relative = await request('PUT', '/plugin/kicad-tool/config', { kicadToolsDir: 'relative/path' })
check('relative paths are rejected', relative.status === 400, relative.text)

const kctDir = join(home, 'kicad-tools')
const saved = await request('PUT', '/plugin/kicad-tool/config', { kicadToolsDir: kctDir })
check('paths save', saved.status === 200, saved.text)
check('settings file written', existsSync(join(home, 'kicad-tool.json')))
const stored = JSON.parse(readFileSync(join(home, 'kicad-tool.json'), 'utf8'))
check('stored paths match', stored.kicadToolsDir === kctDir, JSON.stringify(stored))
check('state reflects the new path', saved.json.config.kicadToolsDir === kctDir)
check('version defaults to the pinned release', saved.json.config.kicadToolsVersion === '0.23.0', String(saved.json.config.kicadToolsVersion))

const badVersion = await request('PUT', '/plugin/kicad-tool/config', { kicadToolsVersion: 'latest' })
check('a non-version string is rejected', badVersion.status === 400 && /must look like/.test(badVersion.text), badVersion.text)

const versioned = await request('PUT', '/plugin/kicad-tool/config', { kicadToolsVersion: '0.24.0' })
check('a version can be pinned', versioned.status === 200 && versioned.json.config.kicadToolsVersion === '0.24.0', versioned.text)
check('no kicanvas path is exposed', !('kicanvasDir' in saved.json.config))
check('the fresh path is not installed', saved.json.repos['kicad-tools'].installed === false, JSON.stringify(saved.json.repos['kicad-tools']))

const mutating = await request('PUT', '/plugin/kicad-tool/config', { allowMutating: true })
check('allowMutating persists', mutating.json.config.allowMutating === true)

/* ---------- actions ---------- */

const badTarget = await request('POST', '/plugin/kicad-tool/action', { target: 'nope', action: 'install' })
check('unknown target is refused', badTarget.status === 409, badTarget.text)

const missingDeps = await request('POST', '/plugin/kicad-tool/action', { target: 'kicad-tools', action: 'install' })
check(
  'install reports the missing command with a hint',
  missingDeps.status === 409 && /missing command\(s\): uv/.test(missingDeps.text) && /brew install uv/.test(missingDeps.text),
  missingDeps.text,
)

const updateMissing = await request('POST', '/plugin/kicad-tool/action', { target: 'kicad-tools', action: 'update' })
check('update requires an install', updateMissing.status === 409 && /not installed/.test(updateMissing.text), updateMissing.text)

const canvasTarget = await request('POST', '/plugin/kicad-tool/action', { target: 'kicanvas', action: 'install' })
check('kicanvas is no longer a managed target', canvasTarget.status === 409, canvasTarget.text)

/* ---------- purge safety ---------- */

// A directory at the configured path that is NOT our venv must survive.
mkdirSync(kctDir, { recursive: true })
writeFileSync(join(kctDir, 'leftover.txt'), 'keep me')
const purged = await request('POST', '/plugin/kicad-tool/purge')
check('purge answers', purged.status === 200, purged.text)
check('purge leaves foreign directories alone', purged.json.removed.length === 0 && existsSync(join(kctDir, 'leftover.txt')), JSON.stringify(purged.json))

// A directory that does hold our CLI is removed.
mkdirSync(join(kctDir, '.venv', 'bin'), { recursive: true })
writeFileSync(join(kctDir, '.venv', 'bin', 'kct'), '#!/bin/sh\n')
const removed = await request('POST', '/plugin/kicad-tool/purge')
check('purge removes the managed checkout', removed.json.removed.includes(kctDir), JSON.stringify(removed.json))
check('purge deletes it from disk', !existsSync(kctDir))

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

/* ---------- defaults are absolute ---------- */

// The shipped defaults carry `~`; resolveConfig must expand them, otherwise tool discovery looks
// for a literal "~/.local/..." path and reports "kct not found" even though the install exists.
const { resolveConfig, DEFAULTS } = await import('../lib/config.js')
const defaults = await resolveConfig({})
check('default kicadToolsDir is absolute', defaults.kicadToolsDir.startsWith('/'), defaults.kicadToolsDir)
check('default version is pinned', DEFAULTS.kicadToolsVersion === '0.23.0', DEFAULTS.kicadToolsVersion)

/* ---------- report ---------- */

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
console.log(`settings checks passed (${version})`)
process.exit(0)
