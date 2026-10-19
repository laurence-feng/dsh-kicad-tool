/**
 * Server-Sent Events hub for `kicad_preview`.
 *
 * The preview URL is produced by a preset-scoped Host tool, but only a Client plugin can open a
 * Sidebar tab. This Host-half module owns the SSE route; `lib/tools.js` publishes preview URLs on
 * the shared bus (`lib/preview-bus.js`), so the two scopes stay decoupled.
 *
 * `GET /plugin/kicad-tool/events` — `text/event-stream`, one JSON `{ url, file }` per preview.
 */
import { onPreview } from './preview-bus.js'

/** Route carrying the event stream. */
export const EVENTS_ROUTE = '/plugin/kicad-tool/events'

/** Keep-alive comment interval, so proxies and idle timeouts keep the stream open. */
const KEEPALIVE_MS = 20000

/**
 * Register the stream route and forward bus events to connected clients.
 * @param ctx - host context; `webServer` is read through `ctx.get`.
 * @returns `{ dispose }`, or undefined when the profile has no web server.
 */
export function registerPreviewEvents(ctx) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer === undefined) return undefined

  const clients = new Set()

  const disposeRoute = webServer.register({
    kind: 'exact',
    path: EVENTS_ROUTE,
    handler: (req, res) => {
      const host = req.headers.host ?? ''
      const name = host.startsWith('[') ? '' : host.split(':')[0]
      if (name !== '127.0.0.1' && name !== 'localhost' && host !== '' && !host.startsWith('localhost')) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'loopback only' }))
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      clients.add(res)
      const keepalive = setInterval(() => {
        try {
          res.write(': keepalive\n\n')
        } catch {
          /* the close handler removes it */
        }
      }, KEEPALIVE_MS)
      keepalive.unref?.()
      req.on('close', () => {
        clearInterval(keepalive)
        clients.delete(res)
      })
    },
  })

  const unsubscribe = onPreview((url, file) => {
    const frame = `data: ${JSON.stringify({ url, file })}\n\n`
    for (const client of clients) {
      try {
        client.write(frame)
      } catch {
        clients.delete(client)
      }
    }
  })

  return {
    /** Number of connected preview clients; 0 means no Client half is listening. */
    get size() {
      return clients.size
    },
    dispose() {
      unsubscribe()
      for (const client of clients) {
        try {
          client.end()
        } catch {
          /* already gone */
        }
      }
      clients.clear()
      disposeRoute()
    },
  }
}
