# dsh-kicad-tool

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that plugs the
standalone Python toolkit **[kicad-tools](https://github.com/rjwalters/kicad-tools)** (CLI: `kct`)
into a Harness session: inspect schematics and boards, run DRC/ERC, generate BOMs, and drive the
design-writing commands — all as ordinary agent tools.

`kicad-tools` needs no running KiCad instance and emits machine-readable JSON, which makes it a good
fit for an agent: the plugin only has to find `kct` and pass structured arguments through.

## Requirements

- Node.js ≥ 18 (the Harness host).
- A local `kicad-tools` checkout with its CLI installed. The plugin expects it at
  `~/.kicad-tools` by default:

```bash
git clone https://github.com/rjwalters/kicad-tools ~/.kicad-tools
uv venv -p 3.13 ~/.kicad-tools/.venv
uv pip install --python ~/.kicad-tools/.venv/bin/python -e ~/.kicad-tools
~/.kicad-tools/.venv/bin/kct --version
```

`kicad-cli` is optional: `kct` ships a pure-Python DRC, and `kicad_status` reports whether
`kicad-cli` is on `PATH`.

## Install

Link this package into a Harness profile:

```bash
dsh plugin --profile desktop add /path/to/dsh-kicad-tool
```

The package declares `dsh.bundle.patch`, so the row is mounted automatically and the four tools
appear in the running session without a restart. For a fresh clone the same call works with the
clone's absolute path.

## Tools

| Tool | Purpose |
|---|---|
| `kicad_status` | Resolve `kct`, report its path/version, the install root, `kicad-cli` presence and whether design writes are enabled. |
| `kicad_summary` | JSON summary of one `.kicad_pcb` (layers, footprints, nets, traces) or `.kicad_sch` (symbols, nets). |
| `kicad_query` | Read-only queries: `sch.summary`, `sch.symbols`, `sch.nets`, `sch.validate`, `pcb.summary`, `pcb.footprints`, `pcb.nets`, `pcb.traces`, `bom`, `check`, `drc`, `erc.parse`, … with `--format json` by default and extra flags passable. |
| `kicad_run` | Full `kct` argv pass-through (no shell) for everything else — routing, fixing, netlists, renders, exports. Design-writing commands are refused unless enabled. |

Examples the model can issue:

```json
// kicad_summary
{ "path": "boards/00-simple-led/output/simple_led.kicad_pcb" }

// kicad_query
{ "command": "pcb.nets", "path": "board.kicad_pcb", "flags": ["--filter", "VCC*"] }

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

So re-cloning, re-creating the venv, or moving the install is picked up on the next tool call;
nothing is cached across calls, and a missing toolchain produces an actionable install message
instead of a stack trace.

## Configuration

Set these in the profile's `cordis.patch.yml` row (`- id: dsh-kicad-tool`):

| key | default | meaning |
|---|---|---|
| `dir` | `~/.kicad-tools` | kicad-tools checkout / install root |
| `cli` | `""` | explicit `kct` executable path; overrides discovery |
| `timeoutMs` | `120000` | per-invocation wall clock limit |
| `maxOutputChars` | `30000` | per-stream output cap before truncation |
| `allowMutating` | `false` | enable commands that write to KiCad files |

```yaml
- id: dsh-kicad-tool
  config:
    dir: '~/work/kicad-tools'
    allowMutating: true
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
node test/smoke.mjs            # mounts against a stub context, exercises the tools on real samples
```

The smoke test uses sample files from the kicad-tools checkout (`boards/00-simple-led`,
`examples/01-schematic-analysis`), so it fails loudly if the toolchain or the CLI contract drifts.

## License

MIT. `kicad-tools` itself is MIT and lives in its own repository; this plugin only invokes it.
