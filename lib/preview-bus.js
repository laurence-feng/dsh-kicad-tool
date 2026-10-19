/**
 * Process-wide preview event bus.
 *
 * Two Cordis scopes talk through this bus: the Host half (`lib/index.js`) owns the SSE
 * route and listens for preview URLs, while the preset half (`lib/tools.js`) produces
 * them from the `kicad_preview` tool. Preset plugins run in a child scope, so a plain
 * module singleton is the least coupling between them.
 *
 * The bus is keyed on `globalThis` with a registered symbol: the two entries resolve to
 * the same installed package, but keeping the state process-wide also survives a second
 * module graph (for example a `link:` install next to an already-loaded copy).
 */

const KEY = Symbol.for('dsh-kicad-tool.preview-bus')

const bus = globalThis[KEY] ?? (globalThis[KEY] = { listeners: new Set() })

/**
 * Subscribe to preview URLs.
 * @param {(url: string, file: string) => void} listener - called once per preview.
 * @returns an unsubscribe function; calling it twice is harmless.
 */
export function onPreview(listener) {
  bus.listeners.add(listener)
  return () => {
    bus.listeners.delete(listener)
  }
}

/**
 * Publish one preview URL. Missing listeners are fine: the tool result still carries the
 * URL, and the Client half may not be loaded at all.
 * @param url - loopback KiCanvas viewer URL.
 * @param file - absolute path of the previewed KiCad file.
 */
export function broadcastPreview(url, file) {
  for (const listener of [...bus.listeners]) {
    try {
      listener(url, file)
    } catch {
      /* a broken listener must not fail the tool call */
    }
  }
}

/** Number of subscribed listeners (the SSE route when the Client half is connected). */
export function previewListenerCount() {
  return bus.listeners.size
}
