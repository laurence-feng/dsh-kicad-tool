/**
 * dsh-kicad-tool — browser half.
 *
 * The Host produces preview URLs; only the Client can open a Sidebar tab. This half keeps one
 * Server-Sent-Events stream to `/plugin/kicad-tool/events` and opens every pushed preview in the
 * in-app browser (the same surface that renders HTTP(S) pages, including loopback services).
 *
 * Why SSE and not a Slots renderer: tool rows have no per-tool registration point, and shadowing
 * the whole `tool` chat node would replace every other tool's presentation. A one-way stream keeps
 * this plugin's UI out of everyone else's way.
 *
 * Failure mode: if the Sidebar browser service is absent (profile without it), the URL is still in
 * the tool result, so the user can open it manually; this half then only logs at debug level.
 *
 * Bundle shape: `window.__ModuleLoader__.load({ id, factory })` with a lazy CJS factory whose
 * `require` resolves against the shell's frozen module table. No modules are needed here.
 */
window.__ModuleLoader__.load({
  id: 'dsh-kicad-tool',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** Route the Host registers; must match lib/events.js. */
    var EVENTS_PATH = '/plugin/kicad-tool/events'

    /**
     * Open one preview URL in the Sidebar's browser tab.
     * @param ctx - client plugin context.
     * @param url - loopback preview URL produced by the Host tool.
     */
    function openPreview(ctx, url) {
      var sidebar = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined
      if (sidebar === undefined) return false
      try {
        if (typeof sidebar.openTab === 'function') {
          sidebar.openTab('browser', { params: { url: url } })
          return true
        }
        if (typeof sidebar.openTabFromTarget === 'function' && typeof sidebar.commandTarget === 'function') {
          var target = sidebar.commandTarget(document.activeElement ?? document.body)
          if (target !== undefined) {
            sidebar.openTabFromTarget('browser', target)
            return true
          }
        }
      } catch (error) {
        console.warn('[kicad-tool] could not open preview', error)
      }
      return false
    }

    /** Subscribe to Host preview pushes for this plugin's lifetime. */
    function apply(ctx) {
      if (typeof EventSource === 'undefined') return function () {}
      var disposed = false
      var source = new EventSource(EVENTS_PATH)

      source.onmessage = function (event) {
        if (disposed) return
        var payload
        try {
          payload = JSON.parse(event.data)
        } catch (error) {
          return
        }
        if (payload && typeof payload.url === 'string') openPreview(ctx, payload.url)
      }
      // EventSource reconnects on its own; a rejected profile (no route) keeps retrying quietly.
      source.onerror = function () {}

      return function () {
        disposed = true
        source.close()
      }
    }

    exports.name = 'dsh-kicad-tool'
    exports.inject = []
    exports.apply = apply
    exports.internals = { openPreview: openPreview, EVENTS_PATH: EVENTS_PATH }

    return module.exports
  },
})
