# 工单 C：bi 工具面挂载包二（BI-07.8 AgentSwarm + BI-07.9 Skill + BI-13.2 LSP）

仓库 /home/yupeng/bi。背景：三器官交付时未挂进工具注册面（虚账清偿波次 1）。config 键面已由前一单加齐（tools.lsp 键已存在），你只做绑定与装配，**不改 schema.ts**。

## 任务

### 1. packages/core/src/cli/toolset.ts（先通读现有绑定模式：globBinding/mediaInspectBinding 是模板；本文件已有 media/jobs 门控挂载先例）
三个新绑定+三个门控（BuildDefaultToolsetOptions 加 `lsp?: boolean`、`swarm?: boolean`、`skill?: boolean`；各器官绑定函数+buildDefaultToolset 末尾按开关追加，缺省零变动）：
- **lsp_navigate（BI-13.2）**：器官 `packages/mcp/src/lsp/lsp-tool.ts`（先读，确认处理器签名与 server 依赖注入面）。门控 options.lsp=true 时挂载；server 连接面以器官的注入接缝为准（无 server 可用时 execute 返回结构化错误 `{ok:false,code:"lsp-unavailable"}`，不抛裸异常）。
- **AgentSwarm（BI-07.8）**：器官 `packages/core/src/subagent/swarm/agent-swarm-tool.ts`（AGENT_SWARM_TOOL_SPEC）。runner 依赖走 BuildDefaultToolsetOptions 新注入面（照 spawnSubagentBinding/cronService 先例——先读 toolset.ts 里 subagent/cron 的注入模式再动手）；runner 未注入时开关无效（不挂载，注释声明语义）。
- **skill（BI-07.9）**：器官先定位——全仓 grep 声明式技能调度（skills 目录/service，BI-07.9 卡交付物；`grep -rln "skill" packages/core/src --include=*.ts | grep -v test`）。照器官实际接口做绑定；门控 options.skill=true。
- 三个绑定 readOnly 面：lsp_navigate/skill 查询类 true；AgentSwarm 派发子代理 false。
- definition 优先引用器官已有 SPEC 常量（单一事实源），器官无 SPEC 才手写。

### 2. packages/core/src/cli/main.ts + bin/bi.ts（装配点，照 media/jobs 传递先例）
两处 buildDefaultToolset 调用补传，装配语义（钉死，不再发明新 config 键）：
- `lsp: config.tools?.lsp === true`（键已存在于 schema）
- `swarm: <subagentSection?.enabled === true>`（随 BI-25 子代理使能联动；runner 实例一并传入）
- `skill: true`（常挂；器官自身容错——skills 目录缺失时 execute 返回结构化 `{ok:false,code:"no-skills"}`）

### 3. 测试（packages/core/src/cli/toolset.test.ts 追加）
- 三开关各自的挂载/不挂载断言+每绑定 execute 至少 1 条行为测试（注入替身，零真实网络/子进程）。

## 红线
- 不许 commit/push/stash；**不改 schema.ts（键已加齐）**；不改 headless.ts、packages/tui/**、packages/a2a/**（并行单施工面）
- 器官文件（subagent/swarm、skills、mcp/src/lsp）只读不改
- 注释/缩进跟随所在文件；零真实网络零子进程

## 完成自检并报告
- `cd /home/yupeng/bi/packages/core && bun test src/cli/toolset.test.ts` 全绿
- 全仓 `BI_PTY_E2E=1 bun test` 全绿 + core/tui 双包 `bunx tsc --noEmit` 零错
- 报告：每器官的绑定形态与依赖注入面、开关装配语义、新增测试数、门禁统计
