# dsh-kicad-tool

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **agent preset** (a mode)
that plugs the standalone Python toolkit
**[kicad-tools](https://github.com/rjwalters/kicad-tools)** (CLI: `kct`) into a session: inspect
schematics and boards, run DRC/ERC, generate BOMs, and drive the design-writing commands.

Once installed, new sessions offer **「KiCad 助手」** in the mode picker. Only sessions that select
this mode get the `kicad_*` tools; every other mode is unaffected. The Settings page
(**Settings → KiCad 工具**) and the KiCanvas preview stay global.

`kicad-tools` needs no running KiCad instance and emits machine-readable JSON, which makes it a good
fit for an agent: the plugin only has to find `kct` and pass structured arguments through.

## What the mode provides

| Capability | Implementation |
|---|---|
| Schematic / PCB inspection | `kicad_status`, `kicad_summary`, `kicad_query` (`sch.*`, `pcb.*`, `symbols`, `nets`, `bom`, `drc`, `erc.parse`, …) |
| Design and fabrication flow | `kicad_run` passes a full `kct` argv through — routing, fixing, netlists, renders, exports; writes are blocked by default |
| Visual review | `kicad_preview`: vendored KiCanvas with zoom/pan/layers/symbol details; opens the in-app browser tab automatically |
| Workbench | file read/write, glob/grep, bash/pwsh, background jobs, schedules, web search/fetch, todo, plan mode, skills, compaction, subagents/workflows |
| Persona and method | KiCad hardware assistant + a 「status → summary/query → visual check → explain before writing → re-run DRC/ERC」 working agreement |

## Requirements

- Node.js ≥ 18 (the Harness host).
- `uv` for the Python CLI. It is checked live and reported on the settings page; a missing command
  fails the action with an install hint instead of hanging. `git` is not needed.

The viewer is **vendored**: `assets/kicanvas.js` (MIT) ships inside the plugin, so previews work
offline with no build step. Only the Python toolchain is installed at runtime.

## Install and enable

```bash
# GitHub source (recommended)
dsh plugin --profile desktop add github:laurence-feng/dsh-kicad-tool

# or, once published to npm
dsh plugin --profile desktop add dsh-kicad-tool
```

Then confirm `dsh-kicad-tool` is enabled on the **Plugins** page and open
**Settings → KiCad 工具** to press **安装** once. The default root is:

```text
~/.local/share/dsh-kicad-tool/kicad-tools   .venv with kicad-tools from PyPI (~50 MB)
```

`kct` is installed from PyPI at a pinned version (default `0.23.0`), not cloned from source: the
upstream checkout is ~440 MB, mostly example boards and test fixtures, none of which the CLI needs.
Change the version field and press **更新** to move to another release.

The path is editable in the page and applies immediately (no restart). The page also offers
**更新 / 重新安装 / 删除**, a dependency readout (`uv`, plus "KiCanvas 内置"), the last operation log,
and **删除数据并卸载** — which deletes the venv and prints the exact `dsh plugin ... remove` command
(the Host cannot uninstall its own package).

After that, create a new session and pick **「KiCad 助手」** in the mode picker.

KiCanvas is not managed by the page; upgrading it is a plugin release. To rebuild the vendored
bundle from a pinned upstream commit:

```bash
npm run vendor:kicanvas                     # uses assets/KICANVAS-VERSION's pin
npm run vendor:kicanvas -- <commit>         # try another commit
```

## Tools

| Tool | Purpose |
|---|---|
| `kicad_status` | Resolve `kct`, report its path/version, the install root, `kicad-cli` presence, whether design writes are enabled, and which plugin version the running process actually loaded. |
| `kicad_summary` | JSON summary of one `.kicad_pcb` (layers, footprints, nets, traces) or `.kicad_sch` (symbols, nets). |
| `kicad_query` | Read-only queries: `sch.*`, `pcb.*`, `symbols`, `nets`, `bom`, `check`, `drc`, `erc.parse`, … with `--format json` by default. Narrow at the source with `filter` (native `--filter`, on `sch.labels`, `sch.unconnected`, `sch.connections`, `pcb.footprints`, `pcb.nets`, `symbols`) or cap a JSON array with `limit`. |
| `kicad_run` | Full `kct` argv pass-through (no shell) for everything else — routing, fixing, netlists, renders, exports. Design-writing commands are refused unless enabled. |
| `kicad_preview` | Returns a browser URL that renders a KiCad file with KiCanvas: interactive schematic/PCB viewer with zoom, pan, layers and symbol details. |

Examples the model can issue:

```json
// kicad_summary
{ "path": "boards/00-simple-led/output/simple_led.kicad_pcb" }

// kicad_query — native filter, and a client-side cap
{ "command": "pcb.nets", "path": "board.kicad_pcb", "filter": "VCC*" }
{ "command": "symbols", "path": "board.kicad_sch", "limit": 50 }

// kicad_run
{ "args": ["sch", "summary", "design.kicad_sch", "--format", "json"] }
```

## Automatic opening

The tool result carries the URL, and the package also ships a small Client half (`client.js`): it
keeps one Server-Sent-Events stream to `/plugin/kicad-tool/events` and calls
`ctx.sidebarRight.openTab('browser', { params: { url } })` for every preview the Host pushes. So a
`kicad_preview` call opens the in-app Sidebar browser by itself. Without the Sidebar browser service
the URL is still in the tool result, so it can be opened manually.

Preview URLs travel from the preset half (the tool) to the host half (the SSE route) over a
process-wide bus (`lib/preview-bus.js`), so the two Cordis scopes never import each other.

## Preview routes

`kicad_preview` starts a **dedicated loopback listener on an ephemeral port** and returns a URL on
it. The listener is process-wide: started lazily on first use, shared by every KiCad-mode session,
and closed when the Harness process exits. It is deliberately not a route on the harness web server:
the in-app browser refuses to open the DSH application's own origin, so a preview URL on the GUI's
port would only work in an external browser.

| Route | Purpose |
|---|---|
| `/proj/<dir-token>/<name>?view=1&controls=full\|basic\|none` | viewer page; also lists every sibling sheet as `<kicanvas-source>` |
| `/proj/<dir-token>/<name>` | the KiCad file itself, served as `text/plain` |
| `/kicanvas.js` | the local KiCanvas bundle |
| `/status` | JSON: is the bundle built, and where |

Siblings are exposed **per kind**: a schematic preview lists only `.kicad_sch`/`.kicad_pro`, a board
preview only `.kicad_pcb`. KiCanvas turns a board into a project page too, and its fallback for "no
root schematic" is the first page — exposing both kinds makes every schematic preview open the board.

`<dir-token>` is the base64url of the project directory. The URL must end in the real file name:
KiCanvas takes a document's name from the URL basename, and a query-string route makes it see a
file called `file`, which fails with `No vaild root schematic was found`. The viewer also emits one
`<kicanvas-source>` per sibling `.kicad_sch`/`.kicad_pcb`, so hierarchical projects resolve their
sheets instead of loading a single orphaned page.

Only KiCad extensions are ever served, names must be a single path segment inside the project
directory, files are capped at 64 MB, and the listener answers loopback `Host` headers only — it
cannot be used as a general-purpose file reader.

## Dynamic loading of the toolchain

The plugin never pins a binary path. Every invocation resolves `kct` at call time, in this order:

1. `config.cli` — an explicit executable path.
2. `$DSH_KCT_CLI`.
3. `<dir>/.venv/bin/kct` (POSIX) or `<dir>\.venv\Scripts\kct.exe` (Windows).
4. `kct` on `$PATH`.
5. `uv run --directory <dir> kct` when `<dir>` is a checkout without a venv.

So reinstalling, re-creating the venv, or moving the install is picked up on the next tool call;
nothing is cached across calls, and a missing toolchain produces an actionable install message
instead of a stack trace.

## Configuration

Settings live in `<dshHome>/kicad-tool.json` and are edited in the Settings page. Values in the
bundle's `cordis.patch.yml` act as composition-time defaults only:

| key | default | meaning |
|---|---|---|
| `kicadToolsDir` | `~/.local/share/dsh-kicad-tool/kicad-tools` | kicad-tools install root (the venv) |
| `kicadToolsVersion` | `0.23.0` | kicad-tools release installed from PyPI |
| `cli` | `""` | explicit `kct` executable path; overrides discovery |
| `timeoutMs` | `120000` | per-invocation wall clock limit |
| `maxOutputChars` | `100000` | per-stream output cap before truncation (JSON past the cap is not parsed) |
| `allowMutating` | `false` | enable commands that write to KiCad files |

Day to day, use the Settings page for the install path and `allowMutating`. `timeoutMs` and
`maxOutputChars` are composition-time constants: changing them means overriding the whole
`preset-kicad` declaration, and upgrading the plugin resets them.

### Why writes are off by default

`kicad_run` accepts an arbitrary `kct` argv. Commands such as `pcb remove-footprint`, `route`,
`fix-drc`, `zones`, `render` or `export` modify or create files, and the plugin cannot rely on the
Harness file sandbox — it spawns `kct` directly. The default is an allowlist of read-only
subcommands; anything else (including unknown commands) requires `allowMutating` from the Settings
page.

## Security notes

- Arguments are passed to `spawn` as an argv array; there is no shell, so no command injection.
- `kicad_query` rejects malformed flags and only exposes a fixed command catalogue.
- Output is capped per stream (`maxOutputChars`) and the process is killed on timeout or when the
  calling turn is aborted.

## Architecture: one bundle, two entries

```text
dsh-kicad-tool (bundle)
├─ host half   lib/index.js   Settings backend + preview SSE; registers no agent tools
└─ preset half lib/tools.js   kicad_* tools + method section (entry `dsh-kicad-tool/tools`)
   └─ mounted by cordis.patch.yml's preset-kicad (id: kicad, order: 6)
```

- The **host half** owns profile-wide surfaces (`/plugin/kicad-tool/*`, SSE, the Settings page), so
  the Settings page works in every mode. It registers no tools, so kicad tooling never leaks into
  Standard or any other mode.
- The **preset half** mounts only in the scope of an Agent that selected 「KiCad 助手」; tool
  registrations and the prompt section stay inside that scope.
- The two halves talk over the process-wide bus in `lib/preview-bus.js`; its key lives on
  `globalThis`, so state is shared even if the package is resolved through two module graphs.
- The browser half `client.js` is loaded through the bundle's `dsh.client` declaration and owns the
  Settings page plus the auto-open behaviour.

## Development

```bash
npm test                       # smoke + contract + preview + events + settings + preset
```

The smoke test uses sample files from the kicad-tools checkout (`boards/00-simple-led`,
`examples/01-schematic-analysis`), so it fails loudly if the toolchain or the CLI contract drifts.
`test/preset.mjs` checks the packaging contract: the `./tools` subpath export, the `preset-kicad`
row and its mode metadata, and that the host half registers no tools.

## License

MIT. `kicad-tools` itself is MIT and lives in its own repository; this plugin only invokes it.
