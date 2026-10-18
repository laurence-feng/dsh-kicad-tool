/**
 * dsh-kicad-tool — KiCad tooling for DeepSeek Harness.
 *
 * Bridges the standalone Python toolkit `kicad-tools` (github.com/rjwalters/kicad-tools,
 * CLI: `kct`) into the Harness tool registry, so an agent can inspect schematics and
 * PCBs, run DRC/ERC/BOM, and drive the authoring commands without leaving the session.
 *
 * ## Dynamic loading
 *
 * The plugin never hard-codes where `kct` lives. Every call resolves the CLI at runtime,
 * in this order:
 *
 *   1. `config.cli` (explicit path to a `kct` executable)
 *   2. `$DSH_KCT_CLI`
 *   3. `<kicadToolsDir>/.venv/bin/kct` (POSIX) or `\.venv\Scripts\kct.exe` (Windows)
 *   4. `kct` on `$PATH`
 *   5. `uv run --directory <dir> kct` when `<dir>` is a checkout without a venv
 *
 * A fresh `git clone` + `uv venv` under `<dir>` is therefore picked up on the next tool
 * call, and a moved or reinstalled toolchain is re-detected instead of staying broken.
 *
 * ## Config
 *
 * | key | default | meaning |
 * |---|---|---|
 * | `kicadToolsDir` | `~/.local/share/dsh-kicad-tool/kicad-tools` | kicad-tools checkout (edited in Settings) |
 * | `cli` | `""` | explicit `kct` executable path (overrides discovery) |
 * | `timeoutMs` | `120000` | per-invocation wall clock limit |
 * | `maxOutputChars` | `100000` | per-stream output cap before truncation |
 * | `allowMutating` | `false` | permit commands that write to KiCad files |
 *
 * @module dsh-kicad-tool
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { resolveConfig } from './config.js'
import { registerControl } from './control.js'
import { registerPreviewEvents } from './events.js'
import { encodeDir, KICAD_EXTENSIONS, startPreviewServer, VENDORED_BUNDLE } from './preview.js'
import { RepoManager } from './repos.js'

/** Cordis plugin name. */
export const name = 'dsh-kicad-tool'

/** Services used by the tools. */
export const inject = ['tools', 'workingDirectory']

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()

const RUNTIME_DEFAULTS = {
  timeoutMs: 120000,
  maxOutputChars: 100000,
}

/* ------------------------------------------------------------------ */
/* config + CLI discovery                                              */
/* ------------------------------------------------------------------ */

/**
 * Composition-time keys (`cordis.patch.yml`) merged under the stored Settings-page values.
 * Paths come from `<dshHome>/kicad-tool.json`, so the page can change them without a restart.
 */
async function loadConfig(patchConfig) {
  const stored = await resolveConfig(patchConfig)
  const num = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)
  return {
    kicadToolsDir: stored.kicadToolsDir,
    cli: stored.cli,
    allowMutating: stored.allowMutating === true,
    timeoutMs: num(patchConfig?.timeoutMs, RUNTIME_DEFAULTS.timeoutMs),
    maxOutputChars: num(patchConfig?.maxOutputChars, RUNTIME_DEFAULTS.maxOutputChars),
  }
}

function isExecutable(file) {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function findOnPath(bin) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const ext of exts) {
      const candidate = join(dir, bin + ext)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

/**
 * Resolve the `kct` entry point.
 * @returns {{command: string, prefix: string[], source: string} | {command: null, reason: string}}
 */
function detect(config) {
  const candidates = []
  if (config.cli !== '') candidates.push({ command: config.cli, prefix: [], source: 'config.cli' })
  if (process.env.DSH_KCT_CLI) {
    candidates.push({ command: expandHome(process.env.DSH_KCT_CLI), prefix: [], source: 'env.DSH_KCT_CLI' })
  }
  if (config.kicadToolsDir !== '') {
    candidates.push({ command: join(config.kicadToolsDir, '.venv', 'bin', 'kct'), prefix: [], source: 'venv' })
    candidates.push({ command: join(config.kicadToolsDir, '.venv', 'Scripts', 'kct.exe'), prefix: [], source: 'venv' })
  }
  const onPath = findOnPath('kct')
  if (onPath) candidates.push({ command: onPath, prefix: [], source: 'PATH' })
  if (config.kicadToolsDir !== '' && isDirectory(config.kicadToolsDir) && findOnPath('uv')) {
    candidates.push({ command: 'uv', prefix: ['run', '--directory', config.kicadToolsDir, 'kct'], source: 'uv' })
  }
  for (const candidate of candidates) {
    if (candidate.source === 'uv') return candidate
    if (isExecutable(candidate.command)) return candidate
  }
  const venvKct = join(config.kicadToolsDir, '.venv', 'bin', 'kct')
  return {
    command: null,
    reason:
      `kct not found (looked at ${venvKct}, $DSH_KCT_CLI and $PATH). ` +
      `Install it with:\n` +
      `  open the dsh-kicad-tool settings page and install kicad-tools, or:\n` +
      `  git clone https://github.com/rjwalters/kicad-tools ${config.kicadToolsDir}\n` +
      `  uv venv -p 3.13 ${join(config.kicadToolsDir, '.venv')}\n` +
      `  uv pip install --python ${join(config.kicadToolsDir, '.venv', 'bin', 'python')} -e ${config.kicadToolsDir}`,
  }
}

/* ------------------------------------------------------------------ */
/* process execution                                                   */
/* ------------------------------------------------------------------ */

function runProcess(command, args, options) {
  const { cwd, timeoutMs, signal, maxOutputChars } = options
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    } catch (error) {
      resolve({ exitCode: -1, error: String(error?.message ?? error), stdout: '', stderr: '', truncated: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let aborted = false
    let timer = null

    const collect = (chunk, stream) => {
      const text = chunk.toString('utf8')
      if (stream === 'out') {
        if (stdout.length >= maxOutputChars) {
          truncated = true
          return
        }
        stdout += text
        if (stdout.length > maxOutputChars) {
          stdout = stdout.slice(0, maxOutputChars)
          truncated = true
        }
      } else {
        if (stderr.length >= maxOutputChars) {
          truncated = true
          return
        }
        stderr += text
        if (stderr.length > maxOutputChars) {
          stderr = stderr.slice(0, maxOutputChars)
          truncated = true
        }
      }
    }

    child.stdout.on('data', (chunk) => collect(chunk, 'out'))
    child.stderr.on('data', (chunk) => collect(chunk, 'err'))

    const stop = (reason) => {
      if (reason === 'timeout') timedOut = true
      if (reason === 'abort') aborted = true
      child.kill('SIGTERM')
      const hard = setTimeout(() => child.kill('SIGKILL'), 2000)
      hard.unref?.()
    }

    if (timeoutMs > 0) timer = setTimeout(() => stop('timeout'), timeoutMs)
    const onAbort = () => stop('abort')
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const finish = (result) => {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    child.on('error', (error) => {
      finish({ exitCode: -1, error: String(error?.message ?? error), stdout, stderr, truncated, timedOut, aborted })
    })
    child.on('close', (code, sig) => {
      finish({
        exitCode: typeof code === 'number' ? code : sig ? 128 : -1,
        stdout,
        stderr,
        truncated,
        timedOut,
        aborted,
      })
    })
  })
}

function parseJson(text) {
  const trimmed = (text ?? '').trim()
  if (trimmed === '' || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function formatResult(result, config) {
  const lines = []
  if (typeof result.data !== 'undefined') lines.push(JSON.stringify(result.data, null, 2))
  else if ((result.stdout ?? '') !== '') lines.push(result.stdout.trimEnd())
  else lines.push('(no output)')
  if ((result.stderr ?? '') !== '') lines.push('--- stderr ---\n' + result.stderr.trimEnd())
  if (typeof result.itemCount === 'number' && typeof result.itemsShown === 'number' && result.itemsShown < result.itemCount) {
    lines.push(
      `[showed ${result.itemsShown} of ${result.itemCount} items — raise \`limit\`, narrow with \`filter\`, ` +
        'or query the specific record]',
    )
  }
  if (result.truncated) {
    lines.push(
      `[output truncated at ${config.maxOutputChars} chars per stream — JSON beyond the cap is not parsed; ` +
        'narrow the query or raise maxOutputChars]',
    )
  }
  const status = []
  if (result.timedOut) status.push(`timed out after ${config.timeoutMs} ms`)
  if (result.aborted) status.push('aborted by caller')
  status.push(`exit ${result.exitCode}`)
  lines.push(`[${status.join(' | ')}]`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* command catalogue / write guards                                    */
/* ------------------------------------------------------------------ */

/** Queries that only read KiCad files, addressed as `<command>` + `<file>`. */
const QUERY_COMMANDS = {
  'sch.summary': ['sch', 'summary'],
  'sch.hierarchy': ['sch', 'hierarchy'],
  'sch.labels': ['sch', 'labels'],
  'sch.validate': ['sch', 'validate'],
  'sch.preflight': ['sch', 'preflight'],
  'sch.unconnected': ['sch', 'unconnected'],
  'sch.connections': ['sch', 'connections'],
  'pcb.summary': ['pcb', 'summary'],
  'pcb.footprints': ['pcb', 'footprints'],
  'pcb.nets': ['pcb', 'nets'],
  'pcb.padmap': ['pcb', 'padmap'],
  'pcb.traces': ['pcb', 'traces'],
  'pcb.stackup': ['pcb', 'stackup'],
  'pcb.net-audit': ['pcb', 'net-audit'],
  symbols: ['symbols'],
  nets: ['nets'],
  bom: ['bom'],
  check: ['check'],
  drc: ['drc'],
  'erc.parse': ['erc', 'parse'],
  'net-status': ['net-status'],
}

/** Commands that accept `--filter <pattern>`; everything else rejects the `filter` argument. */
const FILTERABLE_COMMANDS = new Set([
  'sch.labels',
  'sch.unconnected',
  'sch.connections',
  'pcb.footprints',
  'pcb.nets',
  'symbols',
])

/** Top-level `kct` commands that never modify the design. */
const READ_ONLY_TOP = new Set([
  'symbols', 'nets', 'netlist', 'erc', 'drc', 'bom', 'check', 'creepage', 'sch', 'pcb', 'lib',
  'footprint', 'mfr', 'parts', 'datasheet', 'decisions', 'validate', 'analyze', 'constraints',
  'estimate', 'audit', 'suggest', 'net-status', 'fleet', 'ecosystem', 'agent-guide', 'impedance',
  'explain', 'detect-mistakes', 'calibrate', 'doctor', 'config', 'readiness',
  'benchmark', 'bench',
])

/** Sub-commands of the namespaced tools that never modify the design. */
const READ_ONLY_SUB = {
  sch: new Set(['summary', 'hierarchy', 'labels', 'validate', 'preflight', 'wires', 'info', 'pins', 'pin-map', 'connections', 'unconnected']),
  pcb: new Set(['summary', 'footprints', 'nets', 'padmap', 'traces', 'stackup', 'current-paths-audit', 'net-audit', 'diff']),
  lib: new Set(['list', 'search', 'show', 'pins']),
  footprint: new Set(['list', 'search', 'show']),
  netlist: new Set(['summary', 'diff', 'compare']),
  erc: new Set(['parse', 'explain']),
  config: new Set(['show', 'get', 'list']),
  mfr: new Set(['list', 'show', 'info']),
}

function firstToken(args) {
  return args.find((arg) => !arg.startsWith('-')) ?? ''
}

/** Whether an argv would (or might) write to design files. Unknown commands count as mutating. */
function isMutating(args) {
  const top = firstToken(args)
  if (top === '') return false
  if (!READ_ONLY_TOP.has(top)) return true
  const subs = READ_ONLY_SUB[top]
  if (subs === undefined) return false
  const rest = args.slice(args.indexOf(top) + 1)
  const sub = firstToken(rest)
  if (sub === '') return true
  return !subs.has(sub)
}

function assertWritable(args, config) {
  if (config.allowMutating) return
  if (!isMutating(args)) return
  const label = args.filter((arg) => !arg.startsWith('-')).slice(0, 2).join(' ')
  throw new Error(
    `kicad-tool: "${label}" may modify KiCad files and is blocked. ` +
      'Set `allowMutating: true` in the dsh-kicad-tool plugin config (cordis.patch.yml) to enable design-writing commands.',
  )
}

/* ------------------------------------------------------------------ */
/* shared tool schema fragments                                        */
/* ------------------------------------------------------------------ */

const stringList = { type: 'array', items: { type: 'string' } }

/** Properties every `kct` invocation reports; keep result projection and schema in sync. */
const runResultProperties = {
  argv: stringList,
  cwd: { type: 'string' },
  exitCode: { type: 'integer' },
  stdout: { type: 'string' },
  stderr: { type: 'string' },
  truncated: { type: 'boolean' },
  timedOut: { type: 'boolean' },
  aborted: { type: 'boolean' },
  itemCount: { type: 'integer' },
  itemsShown: { type: 'integer' },
  data: {},
}

const runOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: runResultProperties,
}

/* ------------------------------------------------------------------ */
/* plugin entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * Register the KiCad tools for this composition.
 * @param ctx - context providing the tool registry and working directory owner.
 * @param config - see the module table.
 */
export function apply(ctx, config) {
  const patchConfig = config ?? {}
  let cfg = { ...RUNTIME_DEFAULTS, kicadToolsDir: '', cli: '', allowMutating: false }
  const refresh = async () => {
    cfg = await loadConfig(patchConfig)
    return cfg
  }
  const getConfig = async () => await refresh()

  const workingDirectory = async (exec) => {
    if (ctx.workingDirectory && exec.agent !== undefined) {
      try {
        return await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      } catch {
        /* fall back to the host process directory */
      }
    }
    return process.cwd()
  }

  const invoke = async (args, exec, cwdOverride) => {
    await refresh()
    assertWritable(args, cfg)
    const cli = detect(cfg)
    if (cli.command === null) {
      return { argv: args, cwd: '', exitCode: -1, stdout: '', stderr: cli.reason, truncated: false, timedOut: false, aborted: false }
    }
    const cwd = cwdOverride ?? (await workingDirectory(exec))
    const result = await runProcess(cli.command, [...cli.prefix, ...args], {
      cwd,
      timeoutMs: cfg.timeoutMs,
      signal: exec.signal,
      maxOutputChars: cfg.maxOutputChars,
    })
    // Project explicitly: the tool output schema declares additionalProperties: false, so any
    // extra key from the process wrapper (spawn `error`, ...) would fail result validation.
    //
    // `data` is attached only when stdout actually parsed as JSON. A key holding `undefined` is
    // not lossless JSON, and `--format summary`/`table` output is plain text, so writing
    // `data: undefined` makes the Host reject the whole result ("value is not lossless JSON").
    const value = {
      argv: args,
      cwd,
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? result.error ?? '',
      truncated: result.truncated === true,
      timedOut: result.timedOut === true,
      aborted: result.aborted === true,
    }
    const data = parseJson(result.stdout)
    if (data !== undefined) value.data = data
    return value
  }

  const renderRun = (_args, value) => [{ type: 'text', text: formatResult(value, cfg) }]

  ctx.tools.register({
    name: 'kicad_status',
    description:
      'Check the local KiCad toolchain: whether the kct CLI (kicad-tools) is reachable, which executable and version are used, where the install root is, and whether kicad-cli is on PATH. Call this first when a kicad_* tool reports "kct not found".',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean' },
          cli: { type: 'string' },
          source: { type: 'string' },
          version: { type: 'string' },
          dir: { type: 'string' },
          kicadCli: { type: 'string' },
          allowMutating: { type: 'boolean' },
          pluginVersion: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `kct: ${value.available ? `${value.cli} (${value.source})` : 'NOT FOUND'}`,
            `version: ${value.version || '-'}`,
            `install root: ${value.dir}`,
            `kicad-cli: ${value.kicadCli || 'not on PATH'}`,
            `design writes: ${value.allowMutating ? 'enabled' : 'blocked (allowMutating: false)'}`,
            `plugin: dsh-kicad-tool ${value.pluginVersion}`,
            ...(value.reason ? [value.reason] : []),
          ].join('\n'),
        },
      ],
    },
    async execute(_args, exec) {
      await refresh()
      const cli = detect(cfg)
      let version = ''
      if (cli.command !== null) {
        const result = await runProcess(cli.command, [...cli.prefix, '--version'], {
          cwd: process.cwd(),
          timeoutMs: Math.min(cfg.timeoutMs, 30000),
          signal: exec.signal,
          maxOutputChars: 2000,
        })
        version = (result.stdout || result.stderr || '').trim().split('\n')[0] || ''
      }
      return {
        available: cli.command !== null,
        cli: cli.command ?? '',
        source: cli.command !== null ? cli.source : '',
        version,
        dir: cfg.kicadToolsDir,
        kicadCli: findOnPath('kicad-cli') ?? '',
        allowMutating: cfg.allowMutating,
        pluginVersion: PLUGIN_VERSION,
        reason: cli.command === null ? cli.reason : '',
      }
    },
  })

  ctx.tools.register({
    name: 'kicad_summary',
    description:
      'Summarize one KiCad file as JSON: a .kicad_pcb board (layers, footprint/net/trace counts) or a .kicad_sch schematic (symbol/net overview). The file type is detected from the extension.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Path to a .kicad_pcb or .kicad_sch file (relative paths use the session working directory).',
        },
        verbose: { type: 'boolean', description: 'Ask the command for its verbose breakdown where supported.' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          path: { type: 'string' },
          ...runResultProperties,
        },
      },
      render: renderRun,
    },
    async execute(args, exec) {
      const lower = String(args.path).toLowerCase()
      let base
      let kind
      if (lower.endsWith('.kicad_pcb')) {
        base = ['pcb', 'summary', '--format', 'json']
        kind = 'pcb'
      } else if (lower.endsWith('.kicad_sch')) {
        base = ['sch', 'summary', '--format', 'json']
        kind = 'schematic'
        if (args.verbose === true) base.push('-v')
      } else {
        throw new Error('kicad_summary: path must end with .kicad_pcb or .kicad_sch')
      }
      const result = await invoke([...base, args.path], exec)
      return { kind, path: args.path, ...result }
    },
  })

  ctx.tools.register({
    name: 'kicad_query',
    description:
      'Run a read-only kicad-tools query against a schematic or PCB and return its JSON: symbols/nets/BOM/DRC/ERC plus the sch.* and pcb.* inspection subcommands. Narrow large results at the source with `filter` (native --filter, only on commands that support it) and `limit` (client-side cap on a JSON array), or pass raw CLI switches through `flags`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          description: 'Query to run (read-only).',
          enum: Object.keys(QUERY_COMMANDS),
        },
        path: { type: 'string', description: 'Schematic (.kicad_sch), board (.kicad_pcb) or report file the query reads.' },
        filter: {
          type: 'string',
          description:
            'Pattern passed to the command as --filter, so the toolchain returns fewer rows instead of the plugin trimming them. Supported by: ' +
            [...FILTERABLE_COMMANDS].join(', ') +
            '.',
        },
        limit: {
          type: 'integer',
          description:
            'Maximum JSON array items to keep (kct has no --limit, so this caps the parsed array and reports itemCount/itemsShown). Omit to keep everything.',
        },
        flags: {
          type: 'array',
          description: 'Extra CLI switches, e.g. ["--sorted"]. Appended before the path; no shell involved.',
          items: { type: 'string' },
        },
        format: {
          type: 'string',
          description: 'Output format handed to kct (default json).',
          enum: ['json', 'table', 'summary', 'csv'],
        },
      },
      required: ['command', 'path'],
    },
    output: { schema: runOutputSchema, render: renderRun },
    async execute(args, exec) {
      const base = QUERY_COMMANDS[args.command]
      if (base === undefined) throw new Error(`kicad_query: unknown command "${args.command}"`)
      const flags = Array.isArray(args.flags) ? args.flags.map(String) : []
      for (const flag of flags) {
        // `flags` carries both switches and their values (["--filter", "VCC*"]), and spawn()
        // receives an argv array, so there is no shell to inject into. Reject only what cannot
        // be an argv entry: empty strings, control characters, and switches with whitespace.
        if (flag.startsWith('-')) {
          if (!/^-{1,2}[^\s\x00-\x1f]+$/.test(flag)) {
            throw new Error(`kicad_query: flag "${flag}" is not a well-formed CLI switch`)
          }
        } else if (flag === '' || /[\x00-\x1f]/.test(flag)) {
          throw new Error(`kicad_query: flag value ${JSON.stringify(flag)} is not a valid argv entry`)
        }
      }
      const filter = typeof args.filter === 'string' ? args.filter : undefined
      if (filter !== undefined && !FILTERABLE_COMMANDS.has(args.command)) {
        throw new Error(
          `kicad_query: "${args.command}" has no --filter. Filterable commands: ${[...FILTERABLE_COMMANDS].join(', ')}; ` +
            'for the rest, narrow the file or post-process the JSON.',
        )
      }
      const limit = Number.isSafeInteger(args.limit) && args.limit > 0 ? args.limit : undefined
      const format = typeof args.format === 'string' ? args.format : 'json'
      const hasFormat = flags.some((flag) => flag === '--format' || flag.startsWith('--format='))
      const argv = [
        ...base,
        ...(hasFormat ? [] : ['--format', format]),
        ...flags,
        ...(filter === undefined ? [] : ['--filter', filter]),
        args.path,
      ]
      const result = await invoke(argv, exec)
      if (limit !== undefined && Array.isArray(result.data) && result.data.length > limit) {
        return { ...result, itemCount: result.data.length, itemsShown: limit, data: result.data.slice(0, limit) }
      }
      return result
    },
  })

  ctx.tools.register({
    name: 'kicad_run',
    description:
      'Run the kct CLI directly (argv pass-through, no shell) for anything not covered by kicad_query — route, fix-drc, netlist, render, export, ... Commands that modify KiCad files are refused unless the plugin config sets allowMutating: true.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        args: {
          type: 'array',
          description: 'Full kct argument vector, e.g. ["pcb", "nets", "board.kicad_pcb", "--format", "json"].',
          items: { type: 'string' },
        },
        cwd: { type: 'string', description: 'Working directory for the command (defaults to the session working directory).' },
      },
      required: ['args'],
    },
    output: { schema: runOutputSchema, render: renderRun },
    async execute(args, exec) {
      const argv = Array.isArray(args.args) ? args.args.map(String) : []
      if (argv.length === 0) throw new Error('kicad_run: args must be a non-empty argument vector')
      return await invoke(argv, exec, typeof args.cwd === 'string' ? args.cwd : undefined)
    },
  })

  // KiCanvas runs on its own loopback port: the in-app browser refuses the DSH application's
  // own origin, so a route on the harness web server would only open in an external browser.
  let previewServer
  const ensurePreview = async () => {
    if (previewServer === undefined) previewServer = startPreviewServer()
    return await previewServer
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      const started = previewServer
      previewServer = undefined
      started?.then((server) => server.close()).catch(() => {})
    }, 'dsh-kicad-tool: preview server')
  }

  // Settings page: repository management plus the config it edits.
  const manager = new RepoManager({ configProvider: getConfig })
  let previewEvents

  /**
   * Web routes need the `webServer` service. Reading it eagerly at apply time loses: the service is
   * often not constructed yet, `ctx.get` returns undefined, and every route silently never exists
   * (the Settings page then shows HTTP 404). `ctx.inject` waits for the service instead.
   */
  const mountWebRoutes = (scoped) => {
    const controls = registerControl(scoped, { getConfig, manager })
    if (typeof scoped.effect === 'function') scoped.effect(() => controls, 'dsh-kicad-tool: settings routes')

    // The Client half opens a Sidebar browser tab for each preview; this is how it hears about them.
    previewEvents = registerPreviewEvents(scoped)
    if (previewEvents !== undefined && typeof scoped.effect === 'function') {
      scoped.effect(() => () => previewEvents.dispose(), 'dsh-kicad-tool: preview events')
    }
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountWebRoutes)
  else mountWebRoutes(ctx)

  ctx.tools.register({
    name: 'kicad_preview',
    description:
      'Return a browser URL that renders one KiCad file with KiCanvas (local build): interactive schematic/PCB viewer with zoom, pan, layers and symbol details. The URL also opens automatically in the in-app Sidebar browser when its Client half is loaded. Use it when the user wants to look at a design instead of reading JSON.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Path to a .kicad_pcb / .kicad_sch / .kicad_sym / .kicad_wks / .kicad_pro file (relative paths use the session working directory).' },
        controls: {
          type: 'string',
          description: 'Viewer interactivity: full (default) shows panels, basic is zoom/pan/select only, none renders like an image.',
          enum: ['full', 'basic', 'none'],
        },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          file: { type: 'string' },
          size: { type: 'integer' },
          controls: { type: 'string' },
          bundleReady: { type: 'boolean' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `KiCanvas 预览：${value.url}`,
            `file: ${value.file} (${value.size} bytes, controls=${value.controls})`,
            ...(value.bundleReady ? [] : ['KiCanvas 资源缺失：重装插件即可（内置 assets/kicanvas.js）']),
          ].join('\n'),
        },
      ],
    },
    async execute(args, exec) {
      await refresh()
      const base = await workingDirectory(exec)
      const target = isAbsolute(args.path) ? args.path : resolvePath(base, args.path)
      const extension = target.slice(target.lastIndexOf('.')).toLowerCase()
      if (!KICAD_EXTENSIONS.has(extension)) {
        throw new Error(`kicad_preview: unsupported file type "${extension}"; expected one of ${[...KICAD_EXTENSIONS].join(', ')}`)
      }
      let size
      try {
        const info = statSync(target)
        if (!info.isFile()) throw new Error('not a regular file')
        size = info.size
      } catch (error) {
        throw new Error(`kicad_preview: cannot read ${target}: ${error.message}`)
      }
      const origin = (await ensurePreview()).origin
      const controls = args.controls === 'basic' || args.controls === 'none' ? args.controls : 'full'
      // The URL must end in the real file name: KiCanvas takes a document's name from the URL
      // basename, and a query-string path makes it see a file called "file".
      const url = `${origin}/proj/${encodeDir(dirname(target))}/${encodeURIComponent(basename(target))}?view=1&controls=${controls}`
      const value = {
        url,
        file: target,
        size,
        controls,
        bundleReady: existsSync(VENDORED_BUNDLE),
      }
      // Push to the Client half, which opens the Sidebar browser tab. A missing listener is fine:
      // the URL is still in the tool result.
      previewEvents?.broadcast(url, target)
      return value
    },
  })
}
