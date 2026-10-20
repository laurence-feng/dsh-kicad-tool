/**
 * dsh-kicad-tool — Host half.
 *
 * This entry owns the profile-wide surface of the bundle and registers no agent tools:
 *
 * - **Bundle settings**: the install / update / reinstall / remove backend for the
 *   managed `kicad-tools` venv (`lib/control.js`, `lib/repos.js`, `lib/config.js`), rendered on
 *   the bundle's own page under Plugins → dsh-kicad-tool.
 *
 * The `kicad_*` tools live in `lib/tools.js` and are mounted by the `kicad` agent preset
 * (`KiCad 助手`), so they are visible only to sessions that selected that mode.
 *
 * @module dsh-kicad-tool
 */
import { resolveConfig } from './config.js'
import { registerControl } from './control.js'
import { RepoManager } from './repos.js'

/** Cordis plugin name (the bundle's package root). */
export const name = 'dsh-kicad-tool'

/**
 * Mount the Settings backend.
 *
 * Web routes need the `webServer` service. Reading it eagerly at apply time loses: the service is
 * often not constructed yet, `ctx.get` returns undefined, and every route silently never exists
 * (the bundle page then shows HTTP 404). `ctx.inject` waits for the service instead.
 *
 * @param ctx - host context.
 * @param config - composition-time defaults merged under the stored Settings values.
 */
export function apply(ctx, config) {
  const patchConfig = config ?? {}
  const getConfig = async () => await resolveConfig(patchConfig)
  const manager = new RepoManager({ configProvider: getConfig })

  const mountWebRoutes = (scoped) => {
    const controls = registerControl(scoped, { getConfig, manager })
    if (typeof scoped.effect === 'function') scoped.effect(() => controls, 'dsh-kicad-tool: settings routes')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountWebRoutes)
  else mountWebRoutes(ctx)
}
