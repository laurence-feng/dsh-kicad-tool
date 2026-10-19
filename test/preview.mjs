// Preview server + kicad_preview tool, exercised over a real loopback HTTP server.
//
//   node test/preview.mjs [/path/to/kicad-tools]
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { apply } from '../lib/tools.js'
import { encodeDir } from '../lib/preview.js'

// Keep the settings file out of the user's real ~/.dsh.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'kicad-preview-'))

const root = process.argv[2] ?? `${process.env.HOME}/.kicad-tools`
const schematic = `${root}/examples/01-schematic-analysis/simple_rc.kicad_sch`

const failures = []
function check(label, ok, detail) {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

/** Fetch a path from a base origin, optionally overriding the Host header. */
function get(origin, path, host) {
  const url = new URL(path, origin)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', headers: host ? { host } : {} },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/* ---------- mount the plugin (no harness web server involved) ---------- */

const tools = new Map()
apply(
  {
    tools: { register: (definition) => (tools.set(definition.name, definition), () => {}) },
    workingDirectory: { ensure: async () => process.cwd() },
    effect: (factory) => factory(),
  },
  {},
)

check('kicad_preview tool registered', tools.has('kicad_preview'))

const exec = { agent: {}, signal: AbortSignal.timeout(10000) }
const preview = await tools.get('kicad_preview').execute({ path: schematic }, exec)
const origin = new URL(preview.url).origin

check('preview URL is its own loopback origin', /^http:\/\/127\.0\.0\.1:\d+$/.test(origin), origin)
check('preview URL ends in the real file name', decodeURIComponent(new URL(preview.url).pathname.split('/').pop()) === basename(schematic))

/* ---------- routes ---------- */

const status = await get(origin, '/status')
check('status answers JSON', status.status === 200 && JSON.parse(status.body).ok === true, status.body.slice(0, 120))
check('status reports the bundle', JSON.parse(status.body).bundle === true, JSON.parse(status.body).bundlePath)
check('the bundle is the vendored one', JSON.parse(status.body).vendored === true && JSON.parse(status.body).bundlePath.endsWith('/assets/kicanvas.js'), JSON.parse(status.body).bundlePath)

const bundle = await get(origin, '/kicanvas.js')
check('bundle is served as JavaScript', bundle.status === 200 && bundle.headers['content-type'].includes('javascript') && bundle.body.length > 10000, `${bundle.status} / ${bundle.body.length} bytes`)

const dirToken = encodeDir(dirname(schematic))
const fileRoute = `/proj/${dirToken}/${encodeURIComponent(basename(schematic))}`

const file = await get(origin, fileRoute)
check('kicad file is served as text', file.status === 200 && file.body.includes('kicad_sch'))

const escaped = await get(origin, `/proj/${dirToken}/..%2F..%2Fetc%2Fpasswd`)
check('path traversal is refused', escaped.status === 404)

const denied = await get(origin, `/proj/${dirToken}/passwd`)
check('non-KiCad names are refused', denied.status === 404 && denied.body.includes('only KiCad files'))

const view = await get(origin, `${fileRoute}?view=1&controls=basic`)
check('viewer page embeds kicanvas', view.status === 200 && view.body.includes('<kicanvas-embed') && view.body.includes('/kicanvas.js'))
check('viewer lists the file as a kicanvas-source', view.body.includes('<kicanvas-source src=') && view.body.includes(encodeURIComponent(basename(schematic))))
check('viewer honours controls', view.body.includes('controls="basic"'))

const forbidden = await get(origin, '/status', 'evil.example.com')
check('non-loopback hosts are refused', forbidden.status === 403)

/* ---------- hierarchical project ---------- */

const boardDir = '/Users/laurence/Datas/Workdesk/SRFLab/ezIOC_Board'
if (existsSync(`${boardDir}/ezIOC_Board.kicad_sch`)) {
  const big = await tools.get('kicad_preview').execute({ path: `${boardDir}/ezIOC_Board.kicad_sch` }, exec)
  const page = await get(new URL(big.url).origin, new URL(big.url).pathname + '?view=1')
  const sources = (page.body.match(/<kicanvas-source /g) ?? []).length
  check('hierarchical project exposes every sheet', sources > 5, `${sources} sources`)
  const sheet = await get(new URL(big.url).origin, `/proj/${encodeDir(boardDir)}/SFP.kicad_sch`)
  check('sibling sheets are fetchable', sheet.status === 200 && sheet.body.includes('kicad_sch'))
  check('schematic preview does not expose the board', !page.body.includes('.kicad_pcb'))

  // A board preview must not expose schematics either: KiCanvas turns the board into a project
  // page, and its "no root schematic" fallback would otherwise pick the board for sheet previews.
  const pcb = await tools.get('kicad_preview').execute({ path: `${boardDir}/ezIOC_Board.kicad_pcb` }, exec)
  const pcbPage = await get(new URL(pcb.url).origin, new URL(pcb.url).pathname + '?view=1')
  check('board preview does not expose schematics', !pcbPage.body.includes('.kicad_sch'))
}

/* ---------- tool guards ---------- */

check('kicad_preview reports the file', preview.file === schematic && preview.size > 0)
check('kicad_preview reports bundle readiness', preview.bundleReady === true)
check('kicad_preview render mentions the URL', tools.get('kicad_preview').output.render({}, preview)[0].text.includes(preview.url))

let rejected = false
try {
  await tools.get('kicad_preview').execute({ path: '/etc/passwd' }, exec)
} catch {
  rejected = true
}
check('kicad_preview rejects non-KiCad files', rejected)

/* ---------- report ---------- */

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
console.log(`preview checks passed (${version}, server ${origin})`)
// The preview listener keeps the event loop alive by design; this suite owns its lifecycle.
process.exit(0)
