/**
 * Managed repositories for dsh-kicad-tool.
 *
 * The Settings page owns two checkouts: `kicad-tools` (the `kct` CLI) and `kicanvas` (the viewer
 * bundle). This module installs, updates, removes and reports them. Every command runs with an
 * argv array (no shell) and a timeout, one operation at a time, with its output kept in a bounded
 * log the page polls.
 *
 * Safety rules for removal: only the exact directory configured for that repository is removed, and
 * only when it still looks like that repository (marker file plus a matching needle), so a mistyped
 * path cannot delete an unrelated tree.
 */
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { rm, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { REPOSITORIES, expandHome } from './config.js'

const MAX_LOG_LINES = 300
const CLONE_TIMEOUT_MS = 10 * 60 * 1000
const BUILD_TIMEOUT_MS = 15 * 60 * 1000
const QUICK_TIMEOUT_MS = 60 * 1000

/** Install hints shown when a required command is missing. */
const INSTALL_HINTS = {
  git: 'brew install git   # or your platform package manager',
  uv: 'brew install uv     # https://docs.astral.sh/uv/getting-started/installation/',
  npm: 'brew install node   # npm ships with Node.js',
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

async function looksLikeRepository(repo, dir) {
  try {
    const text = await readFile(join(dir, repo.marker), 'utf8')
    return text.includes(repo.markerNeedle)
  } catch {
    return false
  }
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
   * @param options.configProvider - async () => settings ({ kicadToolsDir, kicanvasDir, ... }).
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
    let commit = ''
    let version = ''
    let artifact = ''
    if (installed) {
      const head = await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'])
      commit = head.code === 0 ? head.stdout.trim() : ''
      if (target === 'kicad-tools') {
        const kct = join(dir, '.venv', 'bin', 'kct')
        if (await exists(kct)) {
          const out = await run(kct, ['--version'], { timeoutMs: 30000 })
          version = out.code === 0 ? out.stdout.trim().split('\n')[0] : ''
        }
        artifact = (await exists(kct)) ? kct : ''
      } else {
        const bundle = join(dir, 'build', 'kicanvas.js')
        if (await exists(bundle)) {
          const info = await stat(bundle)
          artifact = `${bundle} (${info.size} bytes)`
          version = `build ${Math.round(info.size / 1024)} KB`
        }
      }
    }
    return {
      id: repo.id,
      label: repo.label,
      url: repo.url,
      path: dir,
      exists: present,
      installed,
      commit,
      version,
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
        kicanvasDir: this.#pathOf(config, REPOSITORIES.kicanvas),
        allowMutating: config.allowMutating === true,
      },
      repos,
      operation: { ...this.#operation },
      log: this.#log.slice(-80),
      dependencies: {
        git: findOnPath('git'),
        uv: findOnPath('uv'),
        npm: findOnPath('npm'),
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
   * @param target - 'kicad-tools' | 'kicanvas'
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
        await this.#clone(repo, dir)
      } else if (action === 'update') {
        await this.#pull(repo, dir)
      }
      if (target === 'kicad-tools') await this.#setupKicadTools(dir)
      else await this.#setupKicanvas(dir)
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

  async #clone(repo, dir) {
    this.#push(`git clone ${repo.url} → ${dir}`)
    const result = await run('git', ['clone', '--depth', '1', repo.url, dir], { timeoutMs: CLONE_TIMEOUT_MS })
    if (result.code !== 0) throw new Error(`git clone failed: ${(result.stderr || result.stdout).trim().slice(-400)}`)
  }

  async #pull(repo, dir) {
    this.#push(`git fetch --depth 1 origin (${dir})`)
    const fetch = await run('git', ['-C', dir, 'fetch', '--depth', '1', 'origin'], { timeoutMs: CLONE_TIMEOUT_MS })
    if (fetch.code !== 0) throw new Error(`git fetch failed: ${(fetch.stderr || fetch.stdout).trim().slice(-400)}`)
    const reset = await run('git', ['-C', dir, 'reset', '--hard', 'FETCH_HEAD'])
    if (reset.code !== 0) throw new Error(`git reset failed: ${(reset.stderr || reset.stdout).trim().slice(-400)}`)
  }

  async #setupKicadTools(dir) {
    this.#push(`uv venv -p 3.13 ${join(dir, '.venv')}`)
    const venv = await run('uv', ['venv', '-p', '3.13', join(dir, '.venv')], { timeoutMs: BUILD_TIMEOUT_MS })
    if (venv.code !== 0) throw new Error(`uv venv failed: ${(venv.stderr || venv.stdout).trim().slice(-400)}`)
    const python = join(dir, '.venv', 'bin', 'python')
    this.#push(`uv pip install -e ${dir}`)
    const install = await run('uv', ['pip', 'install', '--python', python, '-e', dir], { timeoutMs: BUILD_TIMEOUT_MS })
    if (install.code !== 0) throw new Error(`uv pip install failed: ${(install.stderr || install.stdout).trim().slice(-400)}`)
  }

  async #setupKicanvas(dir) {
    this.#push(`npm ci (${dir})`)
    const install = await run('npm', ['ci'], { cwd: dir, timeoutMs: BUILD_TIMEOUT_MS })
    if (install.code !== 0) throw new Error(`npm ci failed: ${(install.stderr || install.stdout).trim().slice(-400)}`)
    this.#push(`npm run build (${dir})`)
    const build = await run('npm', ['run', 'build'], { cwd: dir, timeoutMs: BUILD_TIMEOUT_MS })
    if (build.code !== 0) throw new Error(`npm run build failed: ${(build.stderr || build.stdout).trim().slice(-400)}`)
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
