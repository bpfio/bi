# 工单 G：bi select_tools + tool-catalog 接线（BI-13.1 + BI-13.3，姊妹卡合流）

仓库 /home/yupeng/bi。虚账清偿波次 2。config 键 tools.select_tools 已存在（缺省 false），你只做接线，**不改 schema.ts**。

## 任务

### 1. BI-13.1 select_tools 挂 toolset（先做，独立可交付）
- 器官：`packages/core/src/tools/tool-activator.ts`（createToolActivator(registry)：select_tools 工具——模型传入工具名，换取全量 inputSchema）。先通读器官+tool-activator.test.ts。
- 接线：toolset.ts（照 media/jobs 门控先例）加 options.select_tools 门控；registry 注入=**当前工具集定义列表**（模型用它查询未激活工具的 schema——把 SelectToolsRegistryLike 需要的结构从现有 ToolBinding[] 适配出来，写一个薄适配函数，不改器官）。
- 挂载语义：options.select_tools=true 时注册；false 零变动。main.ts/bin 装配点补传 `select_tools: config.tools?.select_tools === true`。

### 2. BI-13.3 tool-catalog 接 MCP 名录（与 13.1 合流）
- 器官：`packages/core/src/mcp/tool-catalog.ts`（buildCatalog 分级命名空间+flattenBudget 2000 token 预算渐进展现）+ `mcp/catalog-summarizer.ts`。文件头自述"统计供 BI-13.1 select-tools 消费"——两卡从未合流，本单合流。
- 接线设计（钉死）：toolset.ts 的 select_tools registry 适配层里，把"紧凑名录"来源接 buildCatalog（对当前工具集建 catalog，预算内呈现摘要；模型 select 后换取全 schema）——即 catalog 是 select_tools 的名录后端。MCP 面工具（packages/mcp client 的 toolsAcrossServers）暂不接（当前会话工具集以内置为主），catalog 覆盖内置工具集即可，MCP 扩展留注释备案。
- usageStats 消费：select_tools 的激活计数喂 catalog（如器官接口支持；不支持就留接缝注释）。

### 3. 测试
- toolset.test：select_tools 开/关挂载断言；execute 传入名录中名字返回全 schema、未知名返回候选建议（器官已有行为，接线层断言一次）。
- catalog 接入后名录摘要非空断言。

## 红线
- 不许 commit/push/stash；不改 schema.ts、headless.ts、packages/tui/**、packages/mcp/**（并行单施工面）；器官文件只读
- **注意：toolset.ts 同树有另一单（kimi）在改 packages/tui 侧——你只许改 toolset.ts/main.ts/bin 与 toolset.test；发现 toolset.ts 有非本单改动（C 单已合入的 lsp/swarm/skill 绑定）一律保留不回退**

## 报告格式从简先落盘：/tmp/brief-g-report.md
## 自检
- `BI_PTY_E2E=1 bun test` 全绿 + core 包 tsc 零错；报告合流设计/新增测试数/门禁统计
