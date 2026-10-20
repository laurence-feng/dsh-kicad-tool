/**
 * Managed repositories for dsh-kicad-tool.
 *
 * The Settings page owns one installation: `kicad-tools` (the `kct` CLI), installed from PyPI into
 * `<dir>/.venv`. No source checkout is kept, so the footprint is the venv (~50 MB) instead of the
 * upstream repository (~440 MB, most of it example boards and test fixtures). Every command runs with an
 * argv array (no shell) and a timeout, one operation at a time, with its output kept in a bounded
 * log the page polls.
 *
 * Safety rules for removal: only the exact directory configured for the install is removed, and only
 * when it still holds our `.venv/bin/kct`, so a mistyped path cannot delete an unrelated tree.
 */
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { REPOSITORIES, expandHome } from './config.js'

const MAX_LOG_LINES = 300
const BUILD_TIMEOUT_MS = 15 * 60 * 1000
const QUICK_TIMEOUT_MS = 60 * 1000

/** Install hints shown when a required command is missing. */
const INSTALL_HINTS = {
  uv: 'brew install uv     # https://docs.astral.sh/uv/getting-started/installation/',
}

function run(command, args, { cwd, timeoutMs = QUICK_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(error?.message ?? error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr })
    })
  })
}

function findOnPath(bin) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir === '') continue
    for (const ext of exts) {
      const candidate = join(dir, bin + ext)
      try {
        if (statSyncFile(candidate)) return candidate
      } catch {
        /* keep looking */
      }
    }
  }
  return null
}

function statSyncFile(file) {
  const info = statSync(file)
  return info.isFile()
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A directory belongs to us when it holds the CLI we install. */
async function looksLikeRepository(repo, dir) {
  if (repo.id === 'kicad-tools') return exists(join(dir, '.venv', 'bin', 'kct'))
  return false
}

/**
 * One manager per plugin instance.
 */
export class RepoManager {
  #configProvider
  #log = []
  #operation = { target: null, action: null, running: false, startedAt: null, error: null, finishedAt: null }
  #queue = Promise.resolve()

  /**
   * @param options.configProvider - async () => settings ({ kicadToolsDir, ... }).
   */
  constructor({ configProvider }) {
    this.#configProvider = configProvider
  }

  #push(line) {
    const text = String(line).trimEnd()
    if (text === '') return
    for (const part of text.split('\n')) this.#log.push(part)
    if (this.#log.length > MAX_LOG_LINES) this.#log.splice(0, this.#log.length - MAX_LOG_LINES)
  }

  #pathOf(config, repo) {
    return expandHome(config[repo.configKey])
  }

  /** Status of one repository. */
  async status(target) {
    const repo = REPOSITORIES[target]
    const config = await this.#configProvider()
    const dir = this.#pathOf(config, repo)
    const present = await exists(dir)
    const installed = present && (await looksLikeRepository(repo, dir))
    let version = ''
    let artifact = ''
    if (installed) {
      const kct = join(dir, '.venv', 'bin', 'kct')
      const out = await run(kct, ['--version'], { timeoutMs: 30000 })
      version = out.code === 0 ? out.stdout.trim().split('\n')[0] : ''
      artifact = kct
    }
    return {
      id: repo.id,
      label: repo.label,
      package: repo.package,
      version: version,
      path: dir,
      exists: present,
      installed,
      artifact,
      requires: repo.requires,
    }
  }

  /** Everything the Settings page renders. */
  async state() {
    const config = await this.#configProvider()
    const repos = {}
    for (const target of Object.keys(REPOSITORIES)) repos[target] = await this.status(target)
    return {
      config: {
        kicadToolsDir: this.#pathOf(config, REPOSITORIES['kicad-tools']),
        kicadToolsVersion: config.kicadToolsVersion,
        allowMutating: config.allowMutating === true,
      },
      repos,
      operation: { ...this.#operation },
      log: this.#log.slice(-80),
      dependencies: {
        uv: findOnPath('uv'),
      },
    }
  }

  /** Missing commands for one target, with install hints. */
  async missingDependencies(target) {
    const repo = REPOSITORIES[target]
    const missing = repo.requires.filter((bin) => findOnPath(bin) === null)
    return { missing, hints: missing.map((bin) => `${bin}: ${INSTALL_HINTS[bin] ?? 'install it and retry'}`) }
  }

  /**
   * Start an operation. Returns immediately; the page polls {@link state}.
   * @param target - 'kicad-tools'
   * @param action - 'install' | 'update' | 'remove' | 'reinstall'
   */
  async start(target, action) {
    const repo = REPOSITORIES[target]
    if (repo === undefined) throw new Error(`unknown repository "${target}"`)
    if (!['install', 'update', 'remove', 'reinstall'].includes(action)) throw new Error(`unknown action "${action}"`)
    if (this.#operation.running) throw new Error(`"${this.#operation.target}" is already ${this.#operation.action}ing`)

    const config = await this.#configProvider()
    const dir = this.#pathOf(config, repo)
    const current = await this.status(target)

    if (action !== 'install' && action !== 'reinstall' && !current.installed) {
      throw new Error(`${repo.label} is not installed at ${dir}`)
    }
    if (action === 'install' && current.exists) {
      throw new Error(`${dir} already exists; use "reinstall" or "update"`)
    }
    if (action !== 'remove') {
      const { missing, hints } = await this.missingDependencies(target)
      if (missing.length > 0) throw new Error(`missing command(s): ${missing.join(', ')}\n${hints.join('\n')}`)
    }

    this.#log = []
    this.#operation = { target, action, running: true, startedAt: Date.now(), error: null, finishedAt: null }
    this.#queue = this.#queue.then(() => this.#execute(target, action, repo, dir, config)).catch(() => {})
    return { started: true, target, action, path: dir }
  }

  async #execute(target, action, repo, dir, config) {
    try {
      if (action === 'remove' || action === 'reinstall') {
        await this.#remove(repo, dir)
      }
      if (action === 'remove') {
        this.#operation.running = false
        this.#operation.finishedAt = Date.now()
        return
      }
      if (action === 'install' || action === 'reinstall') {
        await this.#setupKicadTools(dir, config)
      } else if (action === 'update') {
        await this.#setupKicadTools(dir, config, true)
      }
      this.#operation.running = false
      this.#operation.finishedAt = Date.now()
      this.#push(`done: ${repo.label} ${action}`)
    } catch (error) {
      this.#operation.error = String(error?.message ?? error)
      this.#operation.running = false
      this.#operation.finishedAt = Date.now()
      this.#push(`error: ${this.#operation.error}`)
    }
  }

  /**
   * Create/refresh `<dir>/.venv` with the pinned package. `upgrade` re-installs in place so a
   * version bump or an upstream patch is picked up without re-creating the directory.
   */
  async #setupKicadTools(dir, config, upgrade = false) {
    const version = String(config[REPOSITORIES['kicad-tools'].versionKey] ?? '').trim()
    if (version === '') throw new Error('kicadToolsVersion is empty')
    const python = join(dir, '.venv', 'bin', 'python')

    if (!(await exists(python))) {
      this.#push(`uv venv -p 3.13 ${join(dir, '.venv')}`)
      const venv = await run('uv', ['venv', '-p', '3.13', join(dir, '.venv')], { timeoutMs: BUILD_TIMEOUT_MS })
      if (venv.code !== 0) throw new Error(`uv venv failed: ${(venv.stderr || venv.stdout).trim().slice(-400)}`)
    } else if (upgrade) {
      this.#push(`reusing ${python}`)
    }

    const spec = `${REPOSITORIES['kicad-tools'].package}==${version}`
    this.#push(`uv pip install ${upgrade ? '--upgrade --reinstall ' : ''}${spec}`)
    const args = ['pip', 'install', '--python', python]
    if (upgrade) args.push('--upgrade', '--reinstall')
    args.push(spec)
    const install = await run('uv', args, { timeoutMs: BUILD_TIMEOUT_MS })
    if (install.code !== 0) throw new Error(`uv pip install failed: ${(install.stderr || install.stdout).trim().slice(-400)}`)

    const kct = join(dir, '.venv', 'bin', 'kct')
    if (!(await exists(kct))) throw new Error(`installed ${spec}, but ${kct} is missing`)
  }

  async #remove(repo, dir) {
    if (dir === '' || dir === '/' || dir === expandHome('~')) throw new Error(`refusing to remove ${dir}`)
    if (!(await exists(dir))) {
      this.#push(`already absent: ${dir}`)
      return
    }
    if (!(await looksLikeRepository(repo, dir))) {
      throw new Error(`refusing to remove ${dir}: it does not look like ${repo.label}`)
    }
    this.#push(`rm -rf ${dir}`)
    await rm(dir, { recursive: true, force: true })
  }

  /** Remove both managed checkouts (the "delete data" half of uninstall). */
  async purge() {
    if (this.#operation.running) throw new Error('an operation is running')
    const config = await this.#configProvider()
    const removed = []
    for (const target of Object.keys(REPOSITORIES)) {
      const repo = REPOSITORIES[target]
      const dir = expandHome(config[repo.configKey])
      if (await exists(dir)) {
        if (!(await looksLikeRepository(repo, dir))) continue
        await rm(dir, { recursive: true, force: true })
        removed.push(dir)
      }
    }
    return removed
  }
}
