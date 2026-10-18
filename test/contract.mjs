// Contract test: every tool, every catalogue command, validated the way the Host validates.
//
//   node test/contract.mjs [/path/to/kicad-tools]
//
// For each call it asserts: no throw, lossless JSON, output matching output.schema, and a
// render() that yields text blocks. Negative cases assert the guards fire.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

// Keep the settings file out of the user's real ~/.dsh.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'kicad-contract-'))

const root = process.argv[2] ?? `${process.env.HOME}/.kicad-tools`
const board = `${root}/boards/00-simple-led/output/simple_led.kicad_pcb`
const schematic = `${root}/examples/01-schematic-analysis/simple_rc.kicad_sch`

const failures = []
function check(label, ok, detail) {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function mount(config = {}) {
  const tools = new Map()
  apply(
    {
      tools: { register: (definition) => (tools.set(definition.name, definition), () => {}) },
      workingDirectory: { ensure: async () => process.cwd() },
    },
    { kicadToolsDir: root, ...config },
  )
  return tools
}

/* ---------- schema + value validation (the enforced JSON Schema subset) ---------- */

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples', '$comment', 'deprecated', 'readOnly', 'writeOnly'])

function checkSchema(node, path, errors) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(`${path} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!SCHEMA_TYPES.has(node.type) && key !== 'oneOf' && !ANNOTATIONS.has(key) &&
        !['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'].includes(key)) {
      errors.push(`${path}.${key} is not a supported keyword`)
    }
  }
  if (Array.isArray(node.type)) errors.push(`${path}.type must be a single string`)
  if (node.type !== undefined && !SCHEMA_TYPES.has(node.type)) errors.push(`${path}.type is not a known type`)
  if (node.oneOf !== undefined) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) errors.push(`${path}.oneOf must have at least two schemas`)
    else node.oneOf.forEach((entry, index) => checkSchema(entry, `${path}.oneOf[${index}]`, errors))
  }
  if (node.type === 'object' && node.properties !== undefined) {
    if (typeof node.properties !== 'object' || Array.isArray(node.properties)) errors.push(`${path}.properties must be an object`)
    else for (const [key, value] of Object.entries(node.properties)) checkSchema(value, `${path}.properties.${key}`, errors)
    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
        errors.push(`${path}.required must be an array of strings`)
      } else {
        for (const key of node.required) if (!Object.hasOwn(node.properties, key)) errors.push(`${path}.required names undeclared "${key}"`)
      }
    }
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
      errors.push(`${path}.additionalProperties must be a boolean`)
    }
  }
  if (node.type === 'array' && node.items !== undefined) checkSchema(node.items, `${path}.items`, errors)
}

function validateValue(schema, value, path, errors) {
  if (schema.oneOf) {
    const matched = schema.oneOf.filter((candidate) => {
      const local = []
      validateValue(candidate, value, path, local)
      return local.length === 0
    })
    if (matched.length !== 1) errors.push(`${path} must match exactly one oneOf branch (matched ${matched.length})`)
    return
  }
  if (schema.type === undefined) return // annotation-only schema accepts anything
  const type = schema.type
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const expected = type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' : type
  const okType = type === 'integer' ? Number.isInteger(value) : type === 'number' ? actual === 'number' : actual === type
  if (!okType) {
    errors.push(`${path} must be ${type} (got ${actual})`)
    return
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push(`${path} is not one of the enum values`)
  if (type === 'object') {
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}.${key} is not declared (additionalProperties: false)`)
    }
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key} is required`)
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) validateValue(child, value[key], `${path}.${key}`, errors)
    }
  } else if (type === 'array' && schema.items !== undefined) {
    value.forEach((entry, index) => validateValue(schema.items, entry, `${path}[${index}]`, errors))
  }
}

function findUndefined(node, path = 'value') {
  if (node === undefined) return [path]
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((entry, index) => findUndefined(entry, `${path}[${index}]`))
  return Object.entries(node).flatMap(([key, entry]) => findUndefined(entry, `${path}.${key}`))
}

/* ---------- static schema checks ---------- */

const tools = mount()
const toolNames = ['kicad_status', 'kicad_summary', 'kicad_query', 'kicad_run']
for (const name of toolNames) check(`tool ${name} registered`, tools.has(name))

for (const [name, definition] of tools) {
  const errors = []
  checkSchema(definition.parameters, `${name}.parameters`, errors)
  checkSchema(definition.output.schema, `${name}.output.schema`, errors)
  check(`schema for ${name}`, errors.length === 0, errors.join('; '))
  check(`${name} has a description`, typeof definition.description === 'string' && definition.description.length > 20)
  check(`${name} has execute`, typeof definition.execute === 'function')
  check(`${name} has output.render`, typeof definition.output.render === 'function')
}

/* ---------- behaviour matrix ---------- */

const exec = { agent: {}, signal: AbortSignal.timeout(180000) }

const cases = [
  { tool: 'kicad_status', args: {}, noExit: true },
  { tool: 'kicad_summary', args: { path: board }, expectExit: 0 },
  { tool: 'kicad_summary', args: { path: schematic }, expectExit: 0 },
  { tool: 'kicad_summary', args: { path: schematic, verbose: true }, expectExit: 0 },
  { tool: 'kicad_run', args: { args: ['--version'] }, expectExit: 0 },
  { tool: 'kicad_run', args: { args: ['sch', 'summary', schematic, '--format', 'json'] }, expectExit: 0 },
  { tool: 'kicad_run', args: { args: ['--version'], cwd: root }, expectExit: 0 },
]

const schematicCommands = ['sch.summary', 'sch.hierarchy', 'sch.labels', 'sch.validate', 'sch.preflight', 'sch.unconnected', 'sch.connections', 'symbols', 'nets', 'bom']
const boardCommands = ['pcb.summary', 'pcb.footprints', 'pcb.nets', 'pcb.padmap', 'pcb.traces', 'pcb.stackup', 'pcb.net-audit', 'check', 'drc', 'net-status']
for (const command of schematicCommands) cases.push({ tool: 'kicad_query', args: { command, path: schematic }, expectExit: 0 })
for (const command of boardCommands) cases.push({ tool: 'kicad_query', args: { command, path: board }, expectExit: 0, allowNonZero: true })
cases.push({ tool: 'kicad_query', args: { command: 'sch.labels', path: schematic, format: 'table' }, expectExit: 0 })

// Big real-world board: JSON output far past the old 30k cap. Only runs where the file exists.
const bigSchematic = '/Users/laurence/Datas/Workdesk/SRFLab/ezIOC_Board/ezIOC_Board.kicad_sch'
if (existsSync(bigSchematic)) {
  cases.push({ tool: 'kicad_query', args: { command: 'sch.labels', path: bigSchematic, format: 'json' }, expectExit: 0 })
  cases.push({ tool: 'kicad_query', args: { command: 'bom', path: bigSchematic }, expectExit: 0 })
  cases.push({ tool: 'kicad_query', args: { command: 'symbols', path: bigSchematic, limit: 5 }, expectExit: 0 })
}
cases.push({ tool: 'kicad_query', args: { command: 'pcb.nets', path: board, filter: '*' }, expectExit: 0 })
cases.push({ tool: 'kicad_query', args: { command: 'symbols', path: schematic, filter: 'R*' }, expectExit: 0 })
cases.push({ tool: 'kicad_query', args: { command: 'symbols', path: schematic, limit: 1 }, expectExit: 0 })

let ran = 0
for (const testCase of cases) {
  const definition = tools.get(testCase.tool)
  const label = `${testCase.tool} ${JSON.stringify(testCase.args).slice(0, 70)}`
  let value
  try {
    value = await definition.execute(testCase.args, exec)
  } catch (error) {
    check(label, false, `threw: ${error.message}`)
    continue
  }
  ran += 1
  const undefinedAt = findUndefined(value)
  check(`${label} lossless`, undefinedAt.length === 0, undefinedAt.join(', '))
  const errors = []
  validateValue(definition.output.schema, value, 'value', errors)
  check(`${label} matches schema`, errors.length === 0, errors.join('; '))
  const rendered = definition.output.render(testCase.args, value)
  check(`${label} renders`, Array.isArray(rendered) && rendered.length > 0 && rendered.every((block) => block.type === 'text' && typeof block.text === 'string'))
  if (testCase.noExit !== true && !testCase.allowNonZero) {
    check(`${label} exit ${testCase.expectExit}`, value.exitCode === testCase.expectExit, `exit ${value.exitCode}: ${(value.stderr ?? '').split('\n')[0]}`)
  }
}

/* ---------- item cap semantics ---------- */

const capped = await tools.get('kicad_query').execute({ command: 'symbols', path: schematic, limit: 1 }, exec)
check('limit caps the array', Array.isArray(capped.data) && capped.data.length === 1)
check('limit reports itemCount/itemsShown', Number.isInteger(capped.itemCount) && capped.itemsShown === 1 && capped.itemCount >= 1)
check('limit renders the cap note', tools.get('kicad_query').output.render({}, capped)[0].text.includes('showed 1 of'))
const uncapped = await tools.get('kicad_query').execute({ command: 'symbols', path: schematic }, exec)
check('no limit leaves itemCount unset', !('itemCount' in uncapped))

/* ---------- guards ---------- */

async function expectThrow(label, promise) {
  try {
    await promise
    check(label, false, 'did not throw')
  } catch (error) {
    check(label, true)
    return error
  }
}

await expectThrow('mutating command is blocked', tools.get('kicad_run').execute({ args: ['pcb', 'remove-footprint', board] }, exec))
await expectThrow('unknown query command is rejected', tools.get('kicad_query').execute({ command: 'nope', path: board }, exec))
await expectThrow('malformed flag is rejected', tools.get('kicad_query').execute({ command: 'pcb.nets', path: board, flags: ['--filter; rm -rf /'] }, exec))
await expectThrow('filter on an unsupported command is rejected', tools.get('kicad_query').execute({ command: 'nets', path: schematic, filter: 'VCC' }, exec))
await expectThrow('summary rejects other extensions', tools.get('kicad_summary').execute({ path: 'notes.txt' }, exec))
await expectThrow('empty argv is rejected', tools.get('kicad_run').execute({ args: [] }, exec))

// The reported version must be the code that is actually loaded: a stale module generation is
// otherwise indistinguishable from a fixed one.
const status = await tools.get('kicad_status').execute({}, exec)
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
check('kicad_status reports the loaded plugin version', status.pluginVersion === packageVersion, `reported ${status.pluginVersion}, package ${packageVersion}`)

const missing = mount({ kicadToolsDir: '/nonexistent-kicad-tools' })
const broken = await missing.get('kicad_status').execute({}, exec)
check('missing toolchain is reported, not thrown', broken.available === false && broken.reason.includes('settings page') && broken.reason.includes('uv pip install'), broken.reason)

/* ---------- report ---------- */

console.log(`\n${cases.length} calls exercised (${ran} completed), ${failures.length} failure(s)`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`)
  process.exit(1)
}
console.log('all contract checks passed')
