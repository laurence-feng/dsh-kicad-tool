# dsh-kicad-tool

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **模式（agent preset）**，
把独立的 Python 工具集 **[kicad-tools](https://github.com/rjwalters/kicad-tools)**（命令行 `kct`）
接进会话：检查原理图与 PCB、跑 DRC/ERC、生成 BOM，以及驱动会改设计文件的命令。

安装后，新建会话的模式选择器里会出现「**KiCad 助手**」。只有选中这个模式的会话才拿得到
`kicad_*` 工具；其它模式不受影响。插件详情页（**插件 → dsh-kicad-tool**）仍全局可用。

`kicad-tools` 不需要运行中的 KiCad，输出是机器可读的 JSON，正好适合 agent：插件只负责找到 `kct`
并把结构化参数传进去。

## 这个模式提供什么

| 能力 | 实现 |
|---|---|
| 原理图 / PCB 检查 | `kicad_status`、`kicad_summary`、`kicad_query`（`sch.*`、`pcb.*`、`symbols`、`nets`、`bom`、`drc`、`erc.parse` …） |
| 设计与制造流程 | `kicad_run` 透传完整 `kct` argv：布线、修复、网表、渲染、导出；写命令默认拦截 |
| 工作台 | 文件读写、glob/grep、bash/pwsh、后台任务、定时任务、web 搜索/抓取、待办、计划模式、技能、上下文压缩（不含子代理/工作流与文档交付工具） |
| 人设与工作流 | KiCad 硬件设计助手 + 「先 status → 再 summary/query → 改前说明 → 复跑 DRC/ERC」的方法论 |

## 依赖

- Node.js ≥ 18（Harness 宿主）。
- `uv`（Python 侧）。会实时检测并显示在插件详情页上，缺失时直接报错并给安装命令，不会卡住。
  不再需要 `git`。

运行时只需要安装 Python 工具链。

## 安装与启用

```bash
# GitHub 源（推荐）
dsh plugin --profile desktop add github:laurence-feng/dsh-kicad-tool

# 或已发布到 npm 时
dsh plugin --profile desktop add dsh-kicad-tool
```

然后在 **插件** 页确认 `dsh-kicad-tool` 已启用，再打开 **插件 → dsh-kicad-tool** 详情页，点一次 **安装**。
默认根目录：

```text
~/.local/share/dsh-kicad-tool/kicad-tools   .venv（从 PyPI 安装 kicad-tools，约 50 MB）
```

`kct` 从 PyPI 装钉住的版本（默认 `0.23.0`），不 clone 源码：上游仓库约 440 MB，绝大部分是示例
板子和测试夹具，CLI 本身用不到。改版本号再点 **更新** 就能换版本。

路径可在页面里改，立即生效、不用重启。页面还提供 **更新 / 重新安装 / 删除**、依赖检测
（`uv`）、最近操作日志，以及 **删除数据并卸载**——它删掉 venv 并给出
准确的 `dsh plugin ... remove` 命令（宿主无法卸载自己的包）。

之后新建会话，在模式选择器里选「**KiCad 助手**」即可。

## 工具

| 工具 | 作用 |
|---|---|
| `kicad_status` | 解析 `kct`，报告路径/版本、安装根目录、`kicad-cli` 是否存在、是否允许写设计文件，以及**当前进程实际加载的插件版本**。 |
| `kicad_summary` | 单个 `.kicad_pcb`（层、封装、网络、走线）或 `.kicad_sch`（符号、网络）的 JSON 摘要。 |
| `kicad_query` | 只读查询：`sch.*`、`pcb.*`、`symbols`、`nets`、`bom`、`check`、`drc`、`erc.parse` 等，默认 `--format json`。用 `filter` 在源头收窄（走原生 `--filter`，仅 `sch.labels`、`sch.unconnected`、`sch.connections`、`pcb.footprints`、`pcb.nets`、`symbols`），用 `limit` 截断 JSON 数组。 |
| `kicad_run` | 完整的 `kct` argv 透传（不经 shell），覆盖布线、修复、网表、渲染、导出等其余命令；写文件的命令默认拒绝。 |

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

## 工具链的动态加载

插件不写死任何二进制路径，每次调用都会重新解析 `kct`，顺序为：

1. `config.cli`（显式可执行文件路径）
2. `$DSH_KCT_CLI`
3. `<dir>/.venv/bin/kct`（POSIX）或 `<dir>\.venv\Scripts\kct.exe`（Windows）
4. `$PATH` 上的 `kct`
5. 当 `<dir>` 是没有 venv 的检出目录时，用 `uv run --directory <dir> kct`

因此重新安装、重建 venv、挪动安装位置都会在下一次工具调用时被感知；解析结果不跨调用缓存，
找不到工具链时给出可执行的安装提示而不是堆栈。

## 配置

设置保存在 `<dshHome>/kicad-tool.json`，由插件详情页编辑；bundle 里的 `cordis.patch.yml` 只作为
组合期默认值：

| 键 | 默认 | 含义 |
|---|---|---|
| `kicadToolsDir` | `~/.local/share/dsh-kicad-tool/kicad-tools` | kicad-tools 安装根目录（venv 所在处） |
| `kicadToolsVersion` | `0.23.0` | 从 PyPI 安装的 kicad-tools 版本 |
| `cli` | `""` | 显式 `kct` 路径，优先于自动发现 |
| `timeoutMs` | `120000` | 单次调用墙钟上限 |
| `maxOutputChars` | `100000` | 单流输出截断阈值（超出部分不解析为 JSON） |
| `allowMutating` | `false` | 允许写 KiCad 文件的命令 |

日常只需要用插件详情页改 `allowMutating` 和安装路径。`timeoutMs`/`maxOutputChars` 是组合期常量，
要改得覆盖整个 `preset-kicad` 声明；升级插件会重置它。

### 为什么默认禁止写

`kicad_run` 接受任意 `kct` argv。`pcb remove-footprint`、`route`、`fix-drc`、`zones`、`render`、
`export` 之类的命令会改文件或生成文件，而插件是直接 `spawn` 子进程、不经过 Harness 的文件沙箱。
所以默认是一张只读子命令白名单，其他（包括未知命令）都需要在插件详情页打开 `allowMutating`。

## 安全说明

- 参数以 argv 数组交给 `spawn`，不经 shell，因此不存在命令注入。
- `kicad_query` 只暴露固定命令表，并校验 flag 格式。
- 输出按流截断（`maxOutputChars`）；超时或本轮被中止时会杀掉进程。

## 架构：一个 bundle，两个入口

```text
dsh-kicad-tool (bundle)
├─ host 半  lib/index.js      设置后端，不注册任何 agent 工具
└─ preset  half  lib/tools.js  kicad_* 工具 + 工作流提示（行名 dsh-kicad-tool/tools）
   └─ 挂在 cordis.patch.yml 的 preset-kicad（id: kicad, order: 6）里
```

- **host 半**注册 profile 级的东西（`/plugin/kicad-tool/*`、设置后端），所以设置接口对
  所有模式可用；它不注册工具，因此不会把 kicad 工具泄漏到 standard/其它模式。
- **preset 半**只在选中「KiCad 助手」的 Agent scope 里挂载，工具注册表、提示词 section 都是
  scope 内的。
- 浏览器半 `client.js` 由 bundle 的 `dsh.client` 声明加载，负责插件详情页的设置卡片。

## 开发

```bash
npm test                       # smoke + contract + settings + preset
```

冒烟测试使用 kicad-tools 仓库里的样例（`boards/00-simple-led`、`examples/01-schematic-analysis`），
工具链或 CLI 契约变化时会直接报错。`test/preset.mjs` 检查打包契约：`./tools` 子路径导出、
`preset-kicad` 行、模式元数据，以及 host 半不注册任何工具。

## 许可证

MIT。`kicad-tools` 本身也是 MIT，位于其独立仓库；本插件只是调用它。
