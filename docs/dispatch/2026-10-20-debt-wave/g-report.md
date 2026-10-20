# 工单 G 报告 · BI-13.1 + BI-13.3 姊妹卡合流（select_tools 挂 toolset + tool-catalog 接 MCP 名录）

仓库：`/home/yupeng/bi`（虚账清偿波次 2）。本单只做接线，器官（tool-activator.ts / tool-catalog.ts / catalog-summarizer.ts）只读，未改 `schema.ts`/`headless.ts`/`packages/tui/**`/`packages/mcp/**`。

## 一、改动面（仅 4 处，均为本单允许施工面）

| 文件 | 改动 |
| --- | --- |
| `packages/core/src/cli/toolset.ts` | ① import 接入 `createToolActivator` + `buildCatalog`/`flattenBudget` + `summarizeToolLine`（均为 core 内只读器官）；② `BuildDefaultToolsetOptions` 增 `select_tools?: boolean`（缺省 undefined→false，零变动）；③ `buildDefaultToolset` 末尾加 `select_tools===true` 挂载门；④ 新增 `makeSelectToolsRegistry()` 薄适配 + `selectToolsBinding()` + `nearestNames()`/`levenshtein()` 候选建议。 |
| `packages/core/src/cli/main.ts` | 无头路径 `buildDefaultToolset` 选项补传 `select_tools: loadedConfig?.tools.select_tools === true`（在 `ptc` 门内，与 media/jobs/lsp/swarm/skill 同序）。 |
| `bin/bi.ts` | TUI 会话 `buildDefaultToolset` 选项补传 `select_tools: config.tools?.select_tools === true`。 |
| `packages/core/src/cli/toolset.test.ts` | 新增 1 个 describe（5 用例）覆盖挂载开/关与名录后端。 |

**非本单改动保留**：toolset.ts 中 C 单已合入的 lsp_navigate / AgentSwarm / Skill 绑定一律原样保留，未回退。

## 二、合流设计（钉死）

BI-13.1 与 BI-13.3 两卡从未合流；本单把两器官缝成一条链：

1. **select_tools 工具**（BI-13.1 器官 `createToolActivator`）：模型传入工具名列表，换取对应工具的全量 `inputSchema`；非法输入走结构化 `invalid-input` 拒绝，未知名返回候选建议。
2. **registry 后端 = buildCatalog 紧凑名录**（BI-13.3 器官 `tool-catalog.ts`）：`makeSelectToolsRegistry(bindings)` 把当前 `ToolBinding[]`（= 当前会话内置工具集定义列表）薄适配为 `SelectToolsRegistryLike`——
   - 以单命名空间 `builtin` 调 `buildCatalog` 建分级名录（含 name/description/inputSchema）；
   - `select(names)`：名录内名字 → 返回全量 `inputSchema` + `server:"builtin"` 路由；未知名 → `nearestNames`（Levenshtein 近邻，阈值 `max(2, len/3)`）给最近候选；
   - `surfaceByteStats()`：baseline（全量展开）/ initial（紧凑名录）/ current（已激活增量叠加）三态字节统计，喂器官 `compressionStats`（初态压降口径）。
3. **catalog 即名录后端**：模型看到的是 `flattenBudget(catalog, 2000)` 预算内渐进摘要行（`- builtin.<tool>(args): unknown // desc`），调 `select_tools` 后再换取全 schema——catalog 不是独立模块，而是 select_tools 的名录数据源。
4. **接缝备案（本单未实现，留注释）**：
   - MCP 面工具（`packages/mcp` client 的 `toolsAcrossServers`）暂不纳入名录，当前会话以内置为主；扩展只需在 `sources` 追加 MCP 命名空间并桥接即可，registry 接口不变。
   - `usageStats` 消费：catalog 当前不接收激活计数（`buildCatalog` 无该入参），select 命中计数留待器官接口支持后再喂 catalog。

## 三、门禁统计（mount gate）

- `select_tools` 缺省 `false`（config schema 键 `tools.select_tools` 已存在，缺省 `sBool(false)`）→ `buildDefaultToolset` 不挂载，**工具面零变动**（既有 8 件默认工具 + 各条件门行为完全不变，已回归断言）。
- `select_tools:true` → 注册 `select_tools`（readOnly=true），其 registry 后端 = 当前工具集（不含 select_tools 自身，避免自引用），名录统计自动随工具集规模变化。
- `false`/未传 与 `true` 的判定靠 `=== true`，杜绝 truthy 误挂。

## 四、新增测试数

`toolset.test.ts` 新增 **5** 用例（describe「工单 G · BI-13.1/BI-13.3 · select_tools」）：
1. 缺省 / `select_tools:false` → 不含 `select_tools`（零变动回归）；
2. `select_tools:true` → 含 `select_tools`，readOnly=true，定义面 name/inputSchema（names 必填）齐备；
3. execute 传名录中名字 → 返回全量 inputSchema（与对应绑定定义逐字节一致）+ server 路由；
4. execute 传未知名 → 结构化 `unknown-tool` + 候选建议非空且含正确候选（`read_fle`→`read_file`）；
5. BI-13.3 接入后 `makeSelectToolsRegistry` 的 `catalog.totalTools>0` 且 `catalogSummary()` 非空，首行形态 `- builtin.`。

## 五、自检结果

- `BI_PTY_E2E=1 bun test`：**4767 pass / 0 fail**（259 文件，含跨包 `packages/mcp/select-tools.test.ts` 未受影响）。
- `core` 包 tsc：**零错**（`tsc --noEmit -p packages/core/tsconfig.json` exit 0）。
- 红线遵守：未 commit/push/stash；未改 schema.ts / headless.ts / packages/tui/** / packages/mcp/**；器官文件只读。
