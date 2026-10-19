// Packaging contract: one bundle declares the Host half and the「KiCad 助手」agent preset.
//
//   node test/preset.mjs
//
// This is a structural check (no YAML dependency): it guards the two things a Host install
// relies on — the `./tools` subpath export and the preset row that mounts it.
import { existsSync, readFileSync } from 'node:fs'
import { apply as applyHost, name as hostName } from '../lib/index.js'
import { apply as applyTools, inject as toolsInject, name as toolsName } from '../lib/tools.js'

const failures = []
function check(label, ok, detail) {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

check('package version is 0.8.x', /^0\.8\./.test(pkg.version), pkg.version)
check('package exports the tools entry', pkg.exports['./tools'] === './lib/tools.js', String(pkg.exports['./tools']))
check('package ships lib/**', pkg.files.includes('lib/**'))
check('package ships the bundle patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('browser half is declared', pkg.dsh?.client?.platform === 'web')

check('host entry keeps its loader identity', hostName === 'dsh-kicad-tool', hostName)
check('tools entry has the subpath identity', toolsName === 'dsh-kicad-tool/tools', toolsName)
check('tools entry injects the prompt registry', toolsInject.includes('systemPrompt'), toolsInject.join(', '))

check('patch declares the preset loader row', /^\s*-\s*id:\s*preset-kicad\s*$/m.test(patch))
check('preset identity is kicad', /^\s+id:\s*kicad\s*$/m.test(patch))
check('preset display name is KiCad 助手', /^\s+name:\s*KiCad 助手\s*$/m.test(patch))
check('preset is ordered after the shipped modes', /^\s+order:\s*6\s*$/m.test(patch))
check('preset mounts the tools subpath', /name:\s*dsh-kicad-tool\/tools\b/.test(patch))
check('tools default to read-only', /allowMutating:\s*false/.test(patch))
check('preset carries the full workbench', ['tool-fs', 'tool-bash', 'tool-web', 'plan-mode', 'tool-subagent'].every((id) => patch.includes(`id: ${id}`)))
const promptVariables = [...patch.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1].trim())
check(
  'persona templates use only registered variables',
  promptVariables.every((name) => name === 'provider' || name === 'model'),
  promptVariables.join(', ') || 'none',
)

check('tools module exists', existsSync(new URL('../lib/tools.js', import.meta.url)))
check('preview bus module exists', existsSync(new URL('../lib/preview-bus.js', import.meta.url)))

check(
  'settings live on the bundle page',
  clientSource.includes("'plugins.bundle.config'") && clientSource.includes("key: 'dsh-kicad-tool'"),
)
check('no leftover Settings section registration', !clientSource.includes('settings.section'))

/* ---------- the Host half registers no agent tools ---------- */

const registered = []
applyHost(
  {
    tools: { register: (definition) => (registered.push(definition.name), () => {}) },
    get: () => undefined,
    effect: (factory) => factory(),
  },
  {},
)
check('host half registers no tools', registered.length === 0, registered.join(', '))

/* ---------- the preset half mounts tools without a browser/webServer ---------- */

const tools = new Map()
applyTools(
  {
    tools: { register: (definition) => (tools.set(definition.name, definition), () => {}) },
    workingDirectory: { ensure: async () => process.cwd() },
  },
  {},
)
check('preset half registers the kicad tools', ['kicad_status', 'kicad_summary', 'kicad_query', 'kicad_run', 'kicad_preview'].every((tool) => tools.has(tool)), [...tools.keys()].join(', '))

/* ---------- report ---------- */

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
console.log(`preset checks passed (${pkg.version})`)
