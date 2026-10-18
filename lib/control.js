/**
 * Settings-page backend for dsh-kicad-tool.
 *
 * The Settings wire only serves a hard-coded namespace allowlist, so this plugin owns its own
 * routes on the harness web server (loopback only, JSON):
 *
 *   GET  /plugin/kicad-tool/state    settings + repository status + operation log
 *   PUT  /plugin/kicad-tool/config   { kicadToolsDir?, kicanvasDir?, allowMutating? }
 *   POST /plugin/kicad-tool/action   { target: 'kicad-tools'|'kicanvas', action: 'install'|'update'|'reinstall'|'remove' }
 *   POST /plugin/kicad-tool/purge    delete both checkouts, return the uninstall command
 *
 * Paths are validated as absolute, and every mutating call is same-origin/loopback only.
 */
import { isAbsolute, resolve } from 'node:path'
import { expandHome, writeStoredConfig } from './config.js'

/** Prefix for the settings routes. */
export const CONTROL_PREFIX = '/plugin/kicad-tool'

const MAX_BODY_BYTES = 64 * 1024

function loopbackHost(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  if (host.startsWith('[')) return host.startsWith('::1') || host.startsWith('[::1]')
  const name = host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

function sendJson(res, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolveBody({})
        return
      }
      try {
        resolveBody(JSON.parse(text))
      } catch (error) {
        rejectBody(new Error(`invalid JSON: ${error.message}`))
      }
    })
    req.on('error', rejectBody)
  })
}

function requireAbsolute(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty path`)
  const expanded = expandHome(value.trim())
  if (!isAbsolute(expanded)) throw new Error(`${field} must be absolute (got ${value})`)
  const resolved = resolve(expanded)
  if (resolved === '/' || resolved === resolve(expandHome('~'))) throw new Error(`${field} must not be a home or root directory`)
  return resolved
}

/**
 * Register the settings routes.
 * @param ctx - host context (`webServer` read through `ctx.get`).
 * @param options.getConfig - async () => resolved settings.
 * @param options.manager - RepoManager instance.
 * @returns a disposer, or undefined when the profile has no web server.
 */
export function registerControl(ctx, { getConfig, manager }) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer === undefined) return undefined

  const uninstallCommand = () => {
    const profile = process.env.DSH_PROFILE
    return profile === undefined
      ? 'dsh plugin --profile <profile> remove dsh-kicad-tool'
      : `dsh plugin --profile ${profile} remove dsh-kicad-tool`
  }

  const state = async () => {
    const payload = await manager.state()
    return { ...payload, uninstallCommand: uninstallCommand() }
  }

  const routes = [
    {
      kind: 'exact',
      path: `${CONTROL_PREFIX}/state`,
      handler: async (req, res) => {
        if (!loopbackHost(req)) return sendJson(res, 403, { error: 'loopback only' })
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        sendJson(res, 200, await state())
      },
    },
    {
      kind: 'exact',
      path: `${CONTROL_PREFIX}/config`,
      handler: async (req, res) => {
        if (!loopbackHost(req)) return sendJson(res, 403, { error: 'loopback only' })
        if (req.method !== 'PUT' && req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const body = await readJsonBody(req)
          const patch = {}
          if (body.kicadToolsDir !== undefined) patch.kicadToolsDir = requireAbsolute(body.kicadToolsDir, 'kicadToolsDir')
          if (body.kicanvasDir !== undefined) patch.kicanvasDir = requireAbsolute(body.kicanvasDir, 'kicanvasDir')
          if (body.allowMutating !== undefined) patch.allowMutating = body.allowMutating === true
          await writeStoredConfig(patch)
          await getConfig()
          sendJson(res, 200, await state())
        } catch (error) {
          sendJson(res, 400, { error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${CONTROL_PREFIX}/action`,
      handler: async (req, res) => {
        if (!loopbackHost(req)) return sendJson(res, 403, { error: 'loopback only' })
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const body = await readJsonBody(req)
          const started = await manager.start(String(body.target ?? ''), String(body.action ?? ''))
          sendJson(res, 202, { ...started, state: await state() })
        } catch (error) {
          sendJson(res, 409, { error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${CONTROL_PREFIX}/purge`,
      handler: async (req, res) => {
        if (!loopbackHost(req)) return sendJson(res, 403, { error: 'loopback only' })
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const removed = await manager.purge()
          sendJson(res, 200, { removed, uninstallCommand: uninstallCommand() })
        } catch (error) {
          sendJson(res, 409, { error: String(error?.message ?? error) })
        }
      },
    },
  ]

  const disposers = routes.map((route) => webServer.register(route))
  return () => {
    for (const dispose of disposers) dispose()
  }
}
