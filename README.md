# dsh-kicad-tool

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **agent preset** (a mode)
that plugs the standalone Python toolkit
**[kicad-tools](https://github.com/rjwalters/kicad-tools)** (CLI: `kct`) into a session: inspect
schematics and boards, run DRC/ERC, generate BOMs, and drive the design-writing commands.

Once installed, new sessions offer **「KiCad 助手」** in the mode picker. Only sessions that select
this mode get the `kicad_*` tools; every other mode is unaffected. The bundle's settings page
(**Plugins → dsh-kicad-tool**) stays global.

`kicad-tools` needs no running KiCad instance and emits machine-readable JSON, which makes it a good
fit for an agent: the plugin only has to find `kct` and pass structured arguments through.

## What the mode provides

| Capability | Implementation |
|---|---|
| Schematic / PCB inspection | `kicad_status`, `kicad_summary`, `kicad_query` (`sch.*`, `pcb.*`, `symbols`, `nets`, `bom`, `drc`, `erc.parse`, …) |
| Design and fabrication flow | `kicad_run` passes a full `kct` argv through — routing, fixing, netlists, renders, exports; writes are blocked by default |
| Workbench | file read/write, glob/grep, bash/pwsh, background jobs, schedules, web search/fetch, todo, plan mode, skills, compaction (no subagent/workflow or document-delivery tools) |
| Persona and method | KiCad hardware assistant + a 「status → summary/query → explain before writing → re-run DRC/ERC」 working agreement |

## Requirements

- Node.js ≥ 18 (the Harness host).
- `uv` for the Python CLI. It is checked live and reported on the bundle's settings page; a missing command
  fails the action with an install hint instead of hanging. `git` is not needed.

Only the Python toolchain is installed at runtime.

## Install and enable

```bash
# GitHub source (recommended)
dsh plugin --profile desktop add github:laurence-feng/dsh-kicad-tool

# or, once published to npm
dsh plugin --profile desktop add dsh-kicad-tool
```

Then confirm `dsh-kicad-tool` is enabled on the **Plugins** page and open
**Plugins → dsh-kicad-tool** to press **安装** once. The default root is:

```text
~/.local/share/dsh-kicad-tool/kicad-tools   .venv with kicad-tools from PyPI (~50 MB)
```

`kct` is installed from PyPI at a pinned version (default `0.23.0`), not cloned from source: the
upstream checkout is ~440 MB, mostly example boards and test fixtures, none of which the CLI needs.
Change the version field and press **更新** to move to another release.

The path is editable in the page and applies immediately (no restart). The page also offers
**更新 / 重新安装 / 删除**, a dependency readout (`uv`), the last operation log,
and **删除数据并卸载** — which deletes the venv and prints the exact `dsh plugin ... remove` command
(the Host cannot uninstall its own package).

After that, create a new session and pick **「KiCad 助手」** in the mode picker.

## Tools

| Tool | Purpose |
|---|---|
| `kicad_status` | Resolve `kct`, report its path/version, the install root, `kicad-cli` presence, whether design writes are enabled, and which plugin version the running process actually loaded. |
| `kicad_summary` | JSON summary of one `.kicad_pcb` (layers, footprints, nets, traces) or `.kicad_sch` (symbols, nets). |
| `kicad_query` | Read-only queries: `sch.*`, `pcb.*`, `symbols`, `nets`, `bom`, `check`, `drc`, `erc.parse`, … with `--format json` by default. Narrow at the source with `filter` (native `--filter`, on `sch.labels`, `sch.unconnected`, `sch.connections`, `pcb.footprints`, `pcb.nets`, `symbols`) or cap a JSON array with `limit`. |
| `kicad_run` | Full `kct` argv pass-through (no shell) for everything else — routing, fixing, netlists, renders, exports. Design-writing commands are refused unless enabled. |

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

Settings live in `<dshHome>/kicad-tool.json` and are edited on the bundle's settings page
(Plugins → dsh-kicad-tool). Values in the bundle's `cordis.patch.yml` act as composition-time
defaults only:

| key | default | meaning |
|---|---|---|
| `kicadToolsDir` | `~/.local/share/dsh-kicad-tool/kicad-tools` | kicad-tools install root (the venv) |
| `kicadToolsVersion` | `0.23.0` | kicad-tools release installed from PyPI |
| `cli` | `""` | explicit `kct` executable path; overrides discovery |
| `timeoutMs` | `120000` | per-invocation wall clock limit |
| `maxOutputChars` | `100000` | per-stream output cap before truncation (JSON past the cap is not parsed) |
| `allowMutating` | `false` | enable commands that write to KiCad files |

Day to day, use the bundle's settings page for the install path and `allowMutating`. `timeoutMs` and
`maxOutputChars` are composition-time constants: changing them means overriding the whole
`preset-kicad` declaration, and upgrading the plugin resets them.

### Why writes are off by default

`kicad_run` accepts an arbitrary `kct` argv. Commands such as `pcb remove-footprint`, `route`,
`fix-drc`, `zones`, `render` or `export` modify or create files, and the plugin cannot rely on the
Harness file sandbox — it spawns `kct` directly. The default is an allowlist of read-only
subcommands; anything else (including unknown commands) requires `allowMutating` from the bundle's
settings page.

## Security notes

- Arguments are passed to `spawn` as an argv array; there is no shell, so no command injection.
- `kicad_query` rejects malformed flags and only exposes a fixed command catalogue.
- Output is capped per stream (`maxOutputChars`) and the process is killed on timeout or when the
  calling turn is aborted.

## Architecture: one bundle, two entries

```text
dsh-kicad-tool (bundle)
├─ host half   lib/index.js   Settings backend; registers no agent tools
└─ preset half lib/tools.js   kicad_* tools + method section (entry `dsh-kicad-tool/tools`)
   └─ mounted by cordis.patch.yml's preset-kicad (id: kicad, order: 6)
```

- The **host half** owns profile-wide surfaces (`/plugin/kicad-tool/*`, the settings backend),
  so the settings API works in every mode. It registers no tools, so kicad tooling never leaks into
  Standard or any other mode.
- The **preset half** mounts only in the scope of an Agent that selected 「KiCad 助手」; tool
  registrations and the prompt section stay inside that scope.
- The browser half `client.js` is loaded through the bundle's `dsh.client` declaration and owns the
  bundle's settings card.

## Development

```bash
npm test                       # smoke + contract + settings + preset
```

The smoke test uses sample files from the kicad-tools checkout (`boards/00-simple-led`,
`examples/01-schematic-analysis`), so it fails loudly if the toolchain or the CLI contract drifts.
`test/preset.mjs` checks the packaging contract: the `./tools` subpath export, the `preset-kicad`
row and its mode metadata, and that the host half registers no tools.

## License

MIT. `kicad-tools` itself is MIT and lives in its own repository; this plugin only invokes it.
