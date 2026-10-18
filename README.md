# dsh-kicad-tool

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that plugs the
standalone Python toolkit **[kicad-tools](https://github.com/rjwalters/kicad-tools)** (CLI: `kct`)
into a Harness session: inspect schematics and boards, run DRC/ERC, generate BOMs, and drive the
design-writing commands — all as ordinary agent tools.

`kicad-tools` needs no running KiCad instance and emits machine-readable JSON, which makes it a good
fit for an agent: the plugin only has to find `kct` and pass structured arguments through.

## Requirements

- Node.js ≥ 18 (the Harness host).
- `git`, plus `uv` for the Python CLI and `npm` for the viewer build. Both are checked live and
  reported on the settings page; a missing command fails the action with an install hint instead
  of hanging.

Nothing has to be cloned by hand: the plugin's settings page installs and builds both checkouts.

## Install

```bash
dsh plugin --profile desktop add dsh-kicad-tool
```

Then open **Settings → KiCad 工具** and press **安装** for `kicad-tools` and for `KiCanvas`. The default
roots are:

```text
~/.local/share/dsh-kicad-tool/kicad-tools   git checkout + .venv (kct CLI)
~/.local/share/dsh-kicad-tool/kicanvas      git checkout + build/kicanvas.js (viewer)
```

Both paths are editable in the page and apply immediately (no restart). The page also offers
**更新 / 重新安装 / 删除** per repository, a dependency readout (`git`, `uv`, `npm`), the last
operation log, and **删除数据并卸载** — which deletes both checkouts and prints the exact
`dsh plugin ... remove` command (the Host cannot uninstall its own package).

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

## Preview routes

`kicad_preview` starts a **dedicated loopback listener on an ephemeral port** (lazily, on first
use; closed when the plugin unloads) and returns a URL on it. It is deliberately not a route on
the harness web server: the in-app browser refuses to open the DSH application's own origin, so a
preview URL on the GUI's port would only work in an external browser.

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

So re-cloning, re-creating the venv, or moving the install is picked up on the next tool call;
nothing is cached across calls, and a missing toolchain produces an actionable install message
instead of a stack trace.

## Configuration

Settings live in `<dshHome>/kicad-tool.json` and are edited in the Settings page. Values in the
profile's `cordis.patch.yml` row act as composition-time defaults only:

| key | default | meaning |
|---|---|---|
| `dir` | `~/.kicad-tools` | kicad-tools checkout / install root |
| `cli` | `""` | explicit `kct` executable path; overrides discovery |
| `timeoutMs` | `120000` | per-invocation wall clock limit |
| `maxOutputChars` | `100000` | per-stream output cap before truncation (JSON past the cap is not parsed) |
| `allowMutating` | `false` | enable commands that write to KiCad files |
| `kicanvasDir` | `~/.local/share/dsh-kicad-tool/kicanvas` | KiCanvas checkout (Settings page) |

```yaml
- id: dsh-kicad-tool
  config:
    allowMutating: true      # composition-time default; the Settings page also shows paths
```

### Why writes are off by default

`kicad_run` accepts an arbitrary `kct` argv. Commands such as `pcb remove-footprint`, `route`,
`fix-drc`, `zones`, `render` or `export` modify or create files, and the plugin cannot rely on the
Harness file sandbox — it spawns `kct` directly. The default is an allowlist of read-only
subcommands; anything else (including unknown commands) requires `allowMutating: true`.

## Security notes

- Arguments are passed to `spawn` as an argv array; there is no shell, so no command injection.
- `kicad_query` rejects malformed flags and only exposes a fixed command catalogue.
- Output is capped per stream (`maxOutputChars`) and the process is killed on timeout or when the
  calling turn is aborted.

## Development

```bash
npm test                       # smoke + contract + preview + events + settings backends
```

The smoke test uses sample files from the kicad-tools checkout (`boards/00-simple-led`,
`examples/01-schematic-analysis`), so it fails loudly if the toolchain or the CLI contract drifts.

## License

MIT. `kicad-tools` itself is MIT and lives in its own repository; this plugin only invokes it.
