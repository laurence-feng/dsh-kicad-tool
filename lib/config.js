/**
 * Persistent settings for dsh-kicad-tool.
 *
 * The Settings page edits these values, so they live outside the profile patch (which is
 * composition-time only) in `<dshHome>/kicad-tool.json`. Writes are atomic and the file is read on
 * every tool call, so a path change applies to the next call without restarting the app.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Default install root for managed repositories. */
export const DEFAULT_ROOT = '~/.local/share/dsh-kicad-tool'

export const DEFAULTS = {
  kicadToolsDir: `${DEFAULT_ROOT}/kicad-tools`,
  kicanvasDir: `${DEFAULT_ROOT}/kicanvas`,
  allowMutating: false,
  cli: '',
}

/** Repositories the Settings page manages. */
export const REPOSITORIES = {
  'kicad-tools': {
    id: 'kicad-tools',
    label: 'kicad-tools',
    url: 'https://github.com/rjwalters/kicad-tools.git',
    configKey: 'kicadToolsDir',
    marker: 'pyproject.toml',
    markerNeedle: 'name = "kicad-tools"',
    requires: ['git', 'uv'],
  },
  kicanvas: {
    id: 'kicanvas',
    label: 'KiCanvas',
    url: 'https://github.com/theacodes/kicanvas.git',
    configKey: 'kicanvasDir',
    marker: 'package.json',
    markerNeedle: '"name": "kicanvas"',
    requires: ['git', 'npm'],
  },
}

/** Harness home: `$DSH_HOME`, else `~/.dsh`. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** Absolute path of the settings file. */
export function configPath() {
  return join(dshHome(), 'kicad-tool.json')
}

/** Expand a leading `~` without touching anything else. */
export function expandHome(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** Keep only known keys that are present; no defaults are filled in. */
function normalizePartial(raw) {
  const config = {}
  if (raw === null || typeof raw !== 'object') return config
  for (const key of Object.keys(DEFAULTS)) {
    if (!Object.hasOwn(raw, key)) continue
    if (key === 'allowMutating') config[key] = raw[key] === true
    else if (typeof raw[key] === 'string') config[key] = raw[key].trim()
  }
  return config
}

/**
 * Read only the keys the user actually saved. A missing/unreadable file yields `{}`, so
 * composition-time defaults keep working instead of being shadowed by built-in defaults.
 */
export async function readStoredConfig() {
  try {
    const text = await readFile(configPath(), 'utf8')
    return normalizePartial(JSON.parse(text))
  } catch {
    return {}
  }
}

/**
 * Merge composition-time config (`cordis.patch.yml`) under the stored settings.
 * Stored values win: the Settings page is the user-facing surface.
 */
export async function resolveConfig(patchConfig) {
  const stored = await readStoredConfig()
  const patch = normalizePartial(patchConfig)
  return { ...DEFAULTS, ...patch, ...stored }
}

/**
 * Persist a partial settings update.
 * @param patch - keys to change (`kicadToolsDir`, `kicanvasDir`, `allowMutating`, `cli`).
 * @returns the complete settings after the write.
 */
export async function writeStoredConfig(patch) {
  const current = await readStoredConfig()
  const next = { ...DEFAULTS, ...current, ...normalizePartial(patch) }
  const file = configPath()
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temp, file)
  return next
}
