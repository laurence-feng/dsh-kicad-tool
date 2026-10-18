# dsh-kicad-tool

把独立的 Python 工具集 **[kicad-tools](https://github.com/rjwalters/kicad-tools)**（命令行 `kct`）
接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话的插件：检查原理图与 PCB、
跑 DRC/ERC、生成 BOM，以及直接驱动会改文件的命令——这些都以普通 agent 工具的形式出现。

`kicad-tools` 不需要运行中的 KiCad，输出是机器可读的 JSON，正好适合 agent：插件只负责找到 `kct`
并把结构化参数传进去。

## 依赖

- Node.js ≥ 18（Harness 宿主）。
- 本地 `kicad-tools` 检出及 CLI。默认期望放在 `~/.kicad-tools`：

```bash
git clone https://github.com/rjwalters/kicad-tools ~/.kicad-tools
uv venv -p 3.13 ~/.kicad-tools/.venv
uv pip install --python ~/.kicad-tools/.venv/bin/python -e ~/.kicad-tools
~/.kicad-tools/.venv/bin/kct --version
```

`kicad-cli` 是可选的：`kct` 自带纯 Python 的 DRC，`kicad_status` 会报告 `kicad-cli` 是否在 `PATH` 上。

想用可视化预览，还需要本地构建一份 [KiCanvas](https://github.com/theacodes/kicanvas)：

```bash
git clone https://github.com/theacodes/kicanvas ~/.kicanvas
cd ~/.kicanvas && npm ci && npm run build     # → build/kicanvas.js（约 470 KB，自包含）
```

## 安装

把包链接进 Harness profile：

```bash
dsh plugin --profile desktop add /path/to/dsh-kicad-tool
```

包内声明了 `dsh.bundle.patch`，安装后该行会自动挂载，四个工具无需重启就出现在当前会话里；
全新 clone 的目录用同样的命令和绝对路径即可。

## 工具

| 工具 | 作用 |
|---|---|
| `kicad_status` | 解析 `kct`，报告路径/版本、安装根目录、`kicad-cli` 是否存在、是否允许写设计文件，以及**当前进程实际加载的插件版本**。 |
| `kicad_summary` | 单个 `.kicad_pcb`（层、封装、网络、走线）或 `.kicad_sch`（符号、网络）的 JSON 摘要。 |
| `kicad_query` | 只读查询：`sch.*`、`pcb.*`、`symbols`、`nets`、`bom`、`check`、`drc`、`erc.parse` 等，默认 `--format json`。用 `filter` 在源头收窄（走原生 `--filter`，仅 `sch.labels`、`sch.unconnected`、`sch.connections`、`pcb.footprints`、`pcb.nets`、`symbols`），用 `limit` 截断 JSON 数组。 |
| `kicad_run` | 完整的 `kct` argv 透传（不经 shell），覆盖布线、修复、网表、渲染、导出等其余命令；写文件的命令默认拒绝。 |
| `kicad_preview` | 返回一个浏览器 URL，用 KiCanvas 渲染 KiCad 文件：可缩放、平移、看层和符号属性的交互式查看器。 |

调用示例：

```json
// kicad_summary
{ "path": "boards/00-simple-led/output/simple_led.kicad_pcb" }

// kicad_query —— 原生 filter，以及客户端上限
{ "command": "pcb.nets", "path": "board.kicad_pcb", "filter": "VCC*" }
{ "command": "symbols", "path": "board.kicad_sch", "limit": 50 }

// kicad_run
{ "args": ["sch", "summary", "design.kicad_sch", "--format", "json"] }
```

## 自动打开

工具结果里带 URL，包里另外带一个客户端半（`client.js`）：它保持一条到 `/plugin/kicad-tool/events`
的 Server-Sent-Events 长连接，收到宿主推送的预览地址就调用
`ctx.sidebarRight.openTab('browser', { params: { url } })`。所以 `kicad_preview` 会自己弹出内置浏览器
标签；若 profile 没有 Sidebar browser 服务，URL 仍在工具结果里，可以手动打开。

## 预览路由

`kicad_preview` 会**在随机端口上单独起一个回环监听**（首次调用时惰性启动，插件卸载时关闭），
返回该端口上的 URL。它故意不挂在 Harness 的 web server 上：内置浏览器拒绝打开 DSH 应用自身
的 origin，挂在 GUI 端口上的预览地址只能在外置浏览器里用。

| 路由 | 用途 |
|---|---|
| `/proj/<目录 token>/<文件名>?view=1&controls=full\|basic\|none` | 查看页；同时把同目录所有图纸列成 `<kicanvas-source>` |
| `/proj/<目录 token>/<文件名>` | KiCad 文件本身，按 `text/plain` 返回 |
| `/kicanvas.js` | 本地构建的 KiCanvas 包 |
| `/status` | JSON：包是否已构建、路径在哪 |

同级文件**按类型隔离**：预览原理图时只列 `.kicad_sch`/`.kicad_pro`，预览 PCB 时只列 `.kicad_pcb`。
KiCanvas 会把 PCB 也当成一个 project page，而它「找不到根图」时的兜底是第一页——两类混在一起，
预览任何原理图都会打开 PCB。

`<目录 token>` 是工程目录的 base64url。URL 必须以真实文件名结尾：KiCanvas 用 URL 的 basename
当文档名，查询串路由会让它看到一个叫 `file` 的文件，报 `No vaild root schematic was found`。
查看页会给每个同级 `.kicad_sch`/`.kicad_pcb` 生成一个 `<kicanvas-source>`，层级工程因此能解析子图。

只提供 KiCad 扩展名，文件名必须是工程目录内的单段路径，单文件上限 64 MB，且只响应回环 `Host`
——它不能当通用文件读取器用。

## 工具链的动态加载

插件不写死任何二进制路径，每次调用都会重新解析 `kct`，顺序为：

1. `config.cli`（显式可执行文件路径）
2. `$DSH_KCT_CLI`
3. `<dir>/.venv/bin/kct`（POSIX）或 `<dir>\.venv\Scripts\kct.exe`（Windows）
4. `$PATH` 上的 `kct`
5. 当 `<dir>` 是没有 venv 的检出目录时，用 `uv run --directory <dir> kct`

因此重新 clone、重建 venv、挪动安装位置都会在下一次工具调用时被感知；解析结果不跨调用缓存，
找不到工具链时给出可执行的安装提示而不是堆栈。

## 配置

在 profile 的 `cordis.patch.yml` 对应行（`- id: dsh-kicad-tool`）里设置：

| 键 | 默认 | 含义 |
|---|---|---|
| `dir` | `~/.kicad-tools` | kicad-tools 检出 / 安装根目录 |
| `cli` | `""` | 显式 `kct` 路径，优先于自动发现 |
| `timeoutMs` | `120000` | 单次调用墙钟上限 |
| `maxOutputChars` | `100000` | 单流输出截断阈值（超出部分不解析为 JSON） |
| `allowMutating` | `false` | 允许写 KiCad 文件的命令 |
| `kicanvasDir` | `~/.kicanvas` | KiCanvas 检出目录，`kicad_preview` 用它的 `build/kicanvas.js` |

```yaml
- id: dsh-kicad-tool
  config:
    dir: '~/work/kicad-tools'
    allowMutating: true
```

### 为什么默认禁止写

`kicad_run` 接受任意 `kct` argv。`pcb remove-footprint`、`route`、`fix-drc`、`zones`、`render`、
`export` 之类的命令会改文件或生成文件，而插件是直接 `spawn` 子进程、不经过 Harness 的文件沙箱。
所以默认是一张只读子命令白名单，其他（包括未知命令）都需要显式 `allowMutating: true`。

## 安全说明

- 参数以 argv 数组交给 `spawn`，不经 shell，因此不存在命令注入。
- `kicad_query` 只暴露固定命令表，并校验 flag 格式。
- 输出按流截断（`maxOutputChars`）；超时或本轮被中止时会杀掉进程。

## 开发

```bash
node test/smoke.mjs            # 用桩上下文挂载，在真实样例文件上跑工具
```

冒烟测试使用 kicad-tools 仓库里的样例（`boards/00-simple-led`、`examples/01-schematic-analysis`），
工具链或 CLI 契约变化时会直接报错。

## 许可证

MIT。`kicad-tools` 本身也是 MIT，位于其独立仓库；本插件只是调用它。
