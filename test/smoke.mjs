// Smoke test: mounts the plugin against a stub context and runs the tools
// against real sample files from a kicad-tools checkout.
//
//   node test/smoke.mjs [/path/to/kicad-tools]
//
// Exits non-zero when a tool fails, so it doubles as a pre-publish check.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'

// Keep the settings file out of the user's real ~/.dsh.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'kicad-smoke-'))

const root = process.argv[2] ?? `${process.env.HOME}/.kicad-tools`
const board = `${root}/boards/00-simple-led/output/simple_led.kicad_pcb`
const schematic = `${root}/examples/01-schematic-analysis/simple_rc.kicad_sch`

const registered = new Map()
const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  workingDirectory: { ensure: async () => process.cwd() },
}

apply(ctx, { kicadToolsDir: root })

const failures = []
const exec = { agent: {}, signal: AbortSignal.timeout(120000) }

function report(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

// The Harness validates a returned value against output.schema, which declares
// additionalProperties: false. Catch undeclared keys here instead of in a session.
// The Host rejects any result holding `undefined` ("value is not lossless JSON"), which is why
// text output must not carry a `data` key at all.
function findUndefined(node, path = 'value') {
  if (node === undefined) return [path]
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((entry, index) => findUndefined(entry, `${path}[${index}]`))
  return Object.entries(node).flatMap(([key, entry]) => findUndefined(entry, `${path}.${key}`))
}

function checkLossless(label, value) {
  const bad = findUndefined(value)
  report(`${label} is lossless JSON`, bad.length === 0, bad.length > 0 ? `undefined at: ${bad.join(', ')}` : undefined)
}

function checkShape(label, toolName, value) {
  const declared = new Set(Object.keys(registered.get(toolName).output.schema.properties ?? {}))
  const extra = Object.keys(value).filter((key) => !declared.has(key))
  report(`${label} matches output schema`, extra.length === 0, extra.length > 0 ? `undeclared: ${extra.join(', ')}` : undefined)
}

console.log(`plugin: ${name} (inject: ${inject.join(', ')})`)
console.log(`tools:  ${[...registered.keys()].join(', ')}\n`)

for (const tool of ['kicad_status', 'kicad_summary', 'kicad_query', 'kicad_run']) {
  report(`registered ${tool}`, registered.has(tool))
}

const status = await registered.get('kicad_status').execute({}, exec)
report('kicad_status finds kct', status.available === true, status.reason)
checkShape('kicad_status', 'kicad_status', status)
checkLossless('kicad_status', status)

const boardSummary = await registered.get('kicad_summary').execute({ path: board }, exec)
report('kicad_summary(.kicad_pcb) returns JSON', boardSummary.exitCode === 0 && typeof boardSummary.data === 'object')
checkShape('kicad_summary(.kicad_pcb)', 'kicad_summary', boardSummary)
checkLossless('kicad_summary(.kicad_pcb)', boardSummary)

const schSummary = await registered.get('kicad_summary').execute({ path: schematic }, exec)
report('kicad_summary(.kicad_sch) returns JSON', schSummary.exitCode === 0 && typeof schSummary.data === 'object')

const labels = await registered.get('kicad_query').execute({ command: 'sch.labels', path: schematic, format: 'table' }, exec)
report('kicad_query text output runs', labels.exitCode === 0)
checkLossless('kicad_query text output', labels)
checkShape('kicad_query text output', 'kicad_query', labels)

const nets = await registered.get('kicad_query').execute({ command: 'pcb.nets', path: board }, exec)
report('kicad_query pcb.nets returns JSON', nets.exitCode === 0 && typeof nets.data === 'object')
checkShape('kicad_query pcb.nets', 'kicad_query', nets)
checkLossless('kicad_query pcb.nets', nets)

const bom = await registered.get('kicad_query').execute({ command: 'bom', path: schematic }, exec)
report('kicad_query bom runs', bom.exitCode === 0)

const version = await registered.get('kicad_run').execute({ args: ['--version'] }, exec)
report('kicad_run --version runs', version.exitCode === 0 && version.stdout.includes('kicad-tools'))
checkShape('kicad_run --version', 'kicad_run', version)

let blocked = null
try {
  await registered.get('kicad_run').execute({ args: ['pcb', 'remove-footprint', board] }, exec)
} catch (error) {
  blocked = error
}
report('kicad_run blocks design writes by default', blocked !== null && /allowMutating/.test(blocked.message))

const rendered = registered.get('kicad_query').output.render({}, nets)
report('output.render returns text blocks', Array.isArray(rendered) && rendered[0]?.type === 'text')

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall smoke checks passed')
