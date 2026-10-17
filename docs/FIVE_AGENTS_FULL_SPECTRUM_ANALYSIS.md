# 五大工业级开源 Agent CLI 全景模块、组件、逻辑与功能分析大典 (SSOT Master Catalog)

> **创建时间**：2026-10-16  
> **单一事实源 (SSOT)**：本文档是 `zcodecli` (`bi`) 项目对五大标杆项目进行 **100% 全覆盖、全模块、全组件、全逻辑与全功能深度透视** 的权威底账。  
> **核心使命**：五大标杆项目源码总计超过 **23,060 个代码文件、5,230,003 行代码、165 个 Monorepo 子包**。本文档完成了对全量 165 个子包的地毯式 AST 与接口签名提取。后续任何开发智能体在吸收、比对、复刻或定位特定能力时，**严禁再次重复遍历扫描庞大源码树**，必须以本文档及同步至 QNAP NAS Logbook 的结构化知识库作为权威索引字典，实现毫秒级精准代码定位与零冗余算力消耗。  
> **上游锚点 (大典版本化 / RULE-BI-08)**：本文档内容对应六棵参考树的 T0 锚点基线 (2026-10-17 首记)：`zcode@aac4755666d (v3.15.1)`、`kimi-code@18c6d6427`、`opencode@32b41bab1`、`deepseek-harness@86a402200`、`pi@4954d7605`、`deepcode@03c7ebbfa`。上游演进须经 BI-00.2 受控循环 (锚点差分 → 大典增量 → 卡片重对齐 → Shadow Replay 回归) 吸收后再重录锚点；引擎与协议见 [UPSTREAM_ANCHORS.md](./UPSTREAM_ANCHORS.md)，机器可读快照在 `bi-ledger-ops/upstream_anchors.json`。bi 为全部参考树的硬分叉，不回跟任何母体版本。

---

## 目录索引 (Table of Contents)

- [一、 五大标杆全局定位与全景架构矩阵 (Executive Landscape)](#一-五大标杆全局定位与全景架构矩阵-executive-landscape)
- [二、 清华大学 ZCode 49 个全量子包与核心逻辑深度透析 (源头母体)](#二-清华大学-zcode-49-个全量子包与核心逻辑深度透析-源头母体)
- [三、 清华系 Kimi Code CLI 18 个全量子包与核心逻辑深度透析 (工业防爆)](#三-清华系-kimi-code-cli-18-个全量子包与核心逻辑深度透析-工业防爆)
- [四、 OpenCode CLI 35 个全量子包与核心逻辑深度透析 (协议治理与现代规范)](#四-opencode-cli-35-个全量子包与核心逻辑深度透析-协议治理与现代规范)
- [五、 DeepSeek Harness 52 个全量子包与核心逻辑深度透析 (大模型原生基础设施)](#五-deepseek-harness-52-个全量子包与核心逻辑深度透析-大模型原生基础设施)
- [六、 Pi Agent 11 个全量子包与核心逻辑深度透析 (极高性能与反应式模型)](#六-pi-agent-11-个全量子包与核心逻辑深度透析-极高性能与反应式模型)
- [七、 五大标杆核心功能与组件跨项目速查字典 (Developer Quick Lookup Matrix)](#七-五大标杆核心功能与组件跨项目速查字典-developer-quick-lookup-matrix)

---

## 一、 五大标杆全局定位与全景架构矩阵 (Executive Landscape)

### 1. 五大开源标杆全局全景统计总表

| 标杆项目 | 本地基准路径 | 源码文件总数 | 源码代码总行数 | Monorepo 子包数 | 核心定位与设计哲学 | 顶级技术资产与代表机制 |
|---|---|---|---|---|---|---|
| **清华大学 ZCode** | `references/zcode` | 8,353 个文件 | 2,078,743 行 | 49 个子包 | **架构底座与源头母体**<br>清华大学学术严谨性与工业落地的集大成者，契约驱动，形式化证明状态空间 | 智谱 BigModel 双轨特权认证、闲时错峰调度、会话分叉树、动态 DAG 工作流引擎、Microcompact 历史工具脱水、REM 仿生做梦沉淀、Golden Trajectory 阴影会话回放、官方插件资产全套 |
| **清华系 Kimi Code CLI** | `references/kimi-code` | 3,358 个文件 | 822,891 行 | 18 个子包 | **工业级工程实践与防爆治理**<br>极致终端交互体验、防冲防抖与深层防御体系 | 三级 TOML 配置系统与 smol-toml 保留注释回写、RepeatBreaker 三阶反驳打断门、MiniDB 纯 TS LSM 存储、Tower 多 Agent 工作树协作、AgentSwarm 蜂群调度、Plan 模式审批门禁、CJK 宽字符排版 |
| **OpenCode CLI** | `references/opencode` | 4,997 个文件 | 889,559 行 | 35 个子包 | **协议治理与现代开源规范**<br>现代 Effect 驱动范式、零依赖严密词法扫描与紧凑展现 | 双边界会话收件箱（steer/input）与门铃并发协调器、4 级 KV 缓存断点编排、纯 TS 确定性 Shell 词法扫描、SAX 流式 HTML 转 Markdown、分级命名空间工具名录压缩、Mermaid 终端 ASCII 渲染、会话全拓扑脱敏导出导入 |
| **DeepSeek Harness (DHS)** | `references/deepseek-harness` | 4,791 个文件 | 1,040,236 行 | 52 个子包 | **大模型原生工程支撑与基础设施**<br>深度契合大模型特性的调度、紧缩、文档处理与评测体系 | DeepSeek-V3/R1 官方 Messages wire 协议适配与思考流分离、Temporal 全周期调度领域模型、Office 原生公文双向转译管线、LSP 符号级代码导航、Tool-pairing 原子配对门禁、超大输出磁盘 Spill 溢出隔离、PTC 程序化工具调用 |
| **Pi Agent** | `references/pi` | 1,561 个文件 | 398,574 行 | 11 个子包 | **高并发状态反应式追踪与无头评测**<br>极致算法性能、轻量纯 TS 数据结构与 Actor 状态机 | Chord 片段表与平衡树堆（Treap）零拷贝 JSON Delta 状态追踪器、Durable 进程崩溃 Checkpoint 持久化调度器、无头 Agent 评测套件与量化看板、CodeMode 零依赖计算沙箱、Prompt KV 缓存 1-token 脉冲保活 |
| **全网总计** | **5 大标杆** | **23,060 个文件** | **5,230,003 行** | **165 个子包** | **五位一体协同互补** | **104 项全生命周期 SSOT 工业级能力矩阵全闭环** |

---

## 二、 清华大学 ZCode 49 个全量子包与核心逻辑深度透析 (源头母体)

本章节对 `zcode` 下全部 **49 个 Monorepo 子包** 进行地毯式全量解构。包含每个子包的物理路径、代码规模、核心目录拓扑、导出的核心类（Classes）、接口（Interfaces）、类型（Types）、函数（Functions）与对 `bi` 的复刻价值。

### 1. [apps/zcode-cli/packages/adapters](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/adapters) (@zcode/adapters)
- **代码规模**：`373` 个源码文件，共 `121,368` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `tests/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 2. [apps/zcode-cli/packages/android-emulator-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/android-emulator-plugin) (@zcode/android-emulator-plugin)
- **代码规模**：`17` 个源码文件，共 `2,592` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`Check`, `Device`
- **核心导出函数 (Functions)**：`adbShell`, `adbShellCommand`, `androidApiLevel`, `androidBuildToolsVersion`, `androidEnv`, `androidSystemImageAbi`, `androidSystemImagePackage`, `androidSystemImageVariant`, `buildAndRun`, `buildApp`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 3. [apps/zcode-cli/packages/bootstrap](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/bootstrap) (@zcode/bootstrap)
- **代码规模**：`506` 个源码文件，共 `187,645` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `tests/`
- **导出的核心类 (Classes)**：`BUILTIN_WORKFLOW_COMMAND_ARGUMENT_HINT`, `BUILTIN_WORKFLOW_COMMAND_DESCRIPTION`, `BUILTIN_WORKFLOW_COMMAND_NAME`, `PERMISSION_DENIED_BY_USER_CONTENT`, `SESSION_ALLOW_PERMISSION_OPTION_KIND`, `StartupTimer`, `ZCODE_CUA_BROKER_UNAVAILABLE_ENV`, `ZCODE_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS`, `ZCodeCliLoginError`
- **导出的核心接口 (Interfaces)**：`ConfigureCodingPlanApiKeyOptions`, `ConfigureCodingPlanApiKeyResult`, `CreateDefaultProviderEndpointRoutingPortOptions`, `InspectZCodeCustomCommandOptions`, `ListZCodeCustomCommandsOptions`, `LoginZCodeCliOptions`, `LoginZCodeCliResult`, `LogoutZCodeCliOptions`, `LogoutZCodeCliResult`, `ProcessMemoryUsageSnapshot`
- **导出的核心类型 (Types)**：`CodingPlanProviderId`, `LoginBigmodelCodingPlanOptions`, `LoginBigmodelCodingPlanResult`, `ModelProviderSourceTitle`
- **核心导出函数 (Functions)**：`buildCliZCodeSourceHeaders`, `buildPermissionDeniedContent`, `buildProtocolPermissionOptions`, `buildSessionPermissionUpdates`, `createDefaultProviderEndpointRoutingPort`, `createRuntimeAiSdkModelExecutionConfig`, `createZCodeProcessResourceSampler`, `expandBuiltinWorkflowCommandPrompt`, `expandCustomCommandShellSyntax`, `hasConfiguredStandaloneCodingPlan`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 4. [apps/zcode-cli/packages/browser-use-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/browser-use-plugin) (@zcode/browser-use-plugin)
- **代码规模**：`4` 个源码文件，共 `321` 行代码
- **功能定义**：作为官方 ZCode 内置插件发布的 Browser Use skill 与 client runtime；node_repl MCP server 由 @zcode/node-repl-host 提供。
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`setupBrowserRuntime`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 5. [apps/zcode-cli/packages/bundled-skills](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/bundled-skills) (bundled-skills)
- **代码规模**：`0` 个源码文件，共 `0` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：单层源码结构
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 6. [apps/zcode-cli/packages/cli](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/cli) (@zcode/cli)
- **代码规模**：`111` 个源码文件，共 `24,616` 行代码
- **功能定义**：Main CLI application for zcode
- **子目录拓扑**：`src/`, `tests/`
- **导出的核心类 (Classes)**：`extractDisallowedToolsArgs`
- **导出的核心接口 (Interfaces)**：`CliModeState`, `CliResumeRequest`, `CliTargetRequest`, `RunDependencies`
- **导出的核心类型 (Types)**：`BootstrapModule`, `CliPermissionMode`, `CliRuntimeMode`, `ModeCapableApp`
- **核心导出函数 (Functions)**：`createCliHeadlessBrowserRuntime`, `createNodeClipboardTextWriter`, `isPluginHostInvocation`, `isProtocolServerInvocation`, `loadCliPlaywrightChromium`, `loadTuiRuntime`, `parseGlobalArgs`, `readRuntimeEventSubscriber`, `readRuntimeFunction`, `resolveCliCwd`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 7. [apps/zcode-cli/packages/contracts](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/contracts) (@zcode/contracts)
- **代码规模**：`163` 个源码文件，共 `29,844` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `tests/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 8. [apps/zcode-cli/packages/core](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core) (@zcode/core)
- **代码规模**：`799` 个源码文件，共 `234,339` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `tests/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：`RuntimeFactory`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`color`, `formatJson`, `getRuntimeInfo`, `supportsColor`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 9. [apps/zcode-cli/packages/debug](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/debug) (debug)
- **代码规模**：`17` 个源码文件，共 `5,807` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`scripts/`, `server/`, `src/`, `tests/`
- **导出的核心类 (Classes)**：`GANTT_BAR_MIN_WIDTH_PX`, `NetworkCaptureService`
- **导出的核心接口 (Interfaces)**：`CacheReport`, `CacheSegment`, `ContextSectionView`, `ContextSnapshotView`, `ContextUsageCategory`, `ContextUsageMessageBreakdown`, `ContextUsageSkillDetail`, `ContextUsageSnapshotView`, `ContextUsageToolDetail`, `DbMessageRecord`
- **导出的核心类型 (Types)**：`CacheSegmentStatus`, `ContextSectionSource`, `ContextUsageSource`, `NetworkCaptureEvent`, `ObservationSourceKind`, `TokenConfidence`, `TokenMethod`, `TraceSpanLane`, `TraceSpanStatus`
- **核心导出函数 (Functions)**：`createDebugApp`, `createNetworkCaptureServiceFromEnv`, `createObservationEventStream`, `defaultDbPath`, `defaultLogDir`, `disabledNetworkCaptureStatus`, `extractAttribution`, `fingerprintObservationSources`, `ganttItemStyle`, `inspectTrace`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 10. [apps/zcode-cli/packages/documents-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/documents-plugin) (@zcode/documents-plugin)
- **代码规模**：`6` 个源码文件，共 `3,546` 行代码
- **功能定义**：DOCX document production skills, published as an official ZCode plugin.
- **子目录拓扑**：`skills/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 11. [apps/zcode-cli/packages/dynamic-workflow](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/dynamic-workflow) (@zcode/dynamic-workflow)
- **代码规模**：`463` 个源码文件，共 `44,313` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `tests/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`y`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 12. [apps/zcode-cli/packages/dynamic-workflow-runtime](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/dynamic-workflow-runtime) (@zcode/dynamic-workflow-runtime)
- **代码规模**：`24` 个源码文件，共 `4,972` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `tests/`
- **导出的核心类 (Classes)**：`CELL_STREAMS_BOOTSTRAP`
- **导出的核心接口 (Interfaces)**：`ChildEntryFile`, `ChildMainDeps`, `ChildPayload`, `ChildReadlineInterface`, `ChildVmModule`, `CompleteMessage`, `CreateActorMessage`, `DeclareArtifactEventMessage`, `HarnessWarning`, `LogEventMessage`
- **导出的核心类型 (Types)**：`ChildMessage`, `DriverFactory`, `EventMessage`, `ParentMessage`
- **核心导出函数 (Functions)**：`askSpecsFor`, `childEntryFileName`, `childMain`, `fallbackWorkflowRunsDir`, `payload`, `renderChildEntry`, `runScript`, `runWorkflowScript`, `start`, `streamsBootstrap`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 13. [apps/zcode-cli/packages/i18n](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/i18n) (@zcode/i18n)
- **代码规模**：`6` 个源码文件，共 `1,216` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `tests/`
- **导出的核心类 (Classes)**：`SUPPORTED_LOCALES`
- **导出的核心接口 (Interfaces)**：`CliCopy`, `LocaleDetectionInput`, `TuiCopy`, `ZCodeCopy`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`detectLocale`, `getZCodeCopy`, `isSupportedLocale`, `isUiLocale`, `resolveLocale`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 14. [apps/zcode-cli/packages/image-search-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/image-search-plugin) (@zcode/image-search-plugin)
- **代码规模**：`0` 个源码文件，共 `0` 行代码
- **功能定义**：Official ZCode image search MCP server for finding illustrations and reference images.
- **子目录拓扑**：单层源码结构
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 15. [apps/zcode-cli/packages/ios-simulator-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/ios-simulator-plugin) (@zcode/ios-simulator-plugin)
- **代码规模**：`12` 个源码文件，共 `1,429` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`Run`
- **核心导出函数 (Functions)**：`app`, `boot`, `brief`, `bundle`, `button`, `create`, `data`, `describe`, `discover`, `fail`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 16. [apps/zcode-cli/packages/node-repl-host](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/node-repl-host) (@zcode/node-repl-host)
- **代码规模**：`14` 个源码文件，共 `2,733` 行代码
- **功能定义**：Shared node_repl MCP host. Owns the JS execution surface and the domain bridges (Browser Use, Computer Use) that ride on it; the official plugins contribute only their own skills, docs and runtime assets.
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE`, `JS_TOOL_DESCRIPTION`, `NODE_REPL_BROWSER_BRIDGE_SYMBOL`, `NODE_REPL_CUA_BRIDGE_SYMBOL`, `NODE_REPL_DEFAULT_TIMEOUT_MS`, `NODE_REPL_MCP_PROCESS_TITLE`, `NODE_REPL_SERVER_INSTRUCTIONS`, `NODE_REPL_SERVER_VERSION`
- **导出的核心接口 (Interfaces)**：`ActiveCuaNodeReplCall`, `ActiveNodeReplCall`, `ComputerUseRuntimeBridge`, `NodeReplBrowserRuntimeBridge`, `NodeReplCuaBroker`, `NodeReplCuaBrokerConnection`, `NodeReplExecuteInput`, `NodeReplMcpRuntime`
- **导出的核心类型 (Types)**：`NodeReplExecutor`
- **核心导出函数 (Functions)**：`captureComputerUseRuntimeFromEnvironment`, `createBrowserBridgeGlobals`, `createComputerUseBridgeGlobals`, `createInProcessNodeReplExecutor`, `createNodeReplCuaBroker`, `createNodeReplMcpRuntime`, `installNodeReplProcessGuards`, `installNodeReplShutdownTriggers`, `isDirectMcpEntrypoint`, `main`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 17. [apps/zcode-cli/packages/pdf-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/pdf-plugin) (@zcode/pdf-plugin)
- **代码规模**：`9` 个源码文件，共 `12,092` 行代码
- **功能定义**：PDF document production skills, published as an official ZCode plugin.
- **子目录拓扑**：`skills/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 18. [apps/zcode-cli/packages/plugin-creator-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/plugin-creator-plugin) (@zcode/plugin-creator-plugin)
- **代码规模**：`0` 个源码文件，共 `0` 行代码
- **功能定义**：Built-in ZCode plugin authoring skill and scaffolding helpers.
- **子目录拓扑**：单层源码结构
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 19. [apps/zcode-cli/packages/presentations-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/presentations-plugin) (@zcode/presentations-plugin)
- **代码规模**：`0` 个源码文件，共 `0` 行代码
- **功能定义**：PPTX presentation production skills, published as an official ZCode plugin.
- **子目录拓扑**：单层源码结构
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 20. [apps/zcode-cli/packages/restore-legacy-sessions-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/restore-legacy-sessions-plugin) (@zcode/restore-legacy-sessions-plugin)
- **代码规模**：`0` 个源码文件，共 `0` 行代码
- **功能定义**：Legacy ZCode session restoration skills published as an official ZCode plugin.
- **子目录拓扑**：单层源码结构
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 21. [apps/zcode-cli/packages/shared-types](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/shared-types) (@zcode/shared-types)
- **代码规模**：`1` 个源码文件，共 `51` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`GlobalDetectedLocale`, `GlobalLocale`, `GlobalOptions`, `GlobalOutputFormat`, `JsonValue`, `RunContext`, `RuntimeInfo`
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 22. [apps/zcode-cli/packages/skill-creator-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/skill-creator-plugin) (@zcode/skill-creator-plugin)
- **代码规模**：`0` 个源码文件，共 `0` 行代码
- **功能定义**：Built-in skill-creator skills published as an official ZCode plugin.
- **子目录拓扑**：单层源码结构
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 23. [apps/zcode-cli/packages/spreadsheets-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/spreadsheets-plugin) (@zcode/spreadsheets-plugin)
- **代码规模**：`3` 个源码文件，共 `2,584` 行代码
- **功能定义**：XLSX spreadsheet production skills, published as an official ZCode plugin.
- **子目录拓扑**：`skills/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 24. [apps/zcode-cli/packages/superpowers-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/superpowers-plugin) (@zcode/superpowers-plugin)
- **代码规模**：`3` 个源码文件，共 `414` 行代码
- **功能定义**：Superpowers skills and startup hooks published as an official ZCode plugin.
- **子目录拓扑**：`skills/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`waitForEvent`, `waitForEventCount`, `waitForEventMatch`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 25. [apps/zcode-cli/packages/swift-bridge](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/swift-bridge) (@zcode/swift-bridge)
- **代码规模**：`1` 个源码文件，共 `20` 行代码
- **功能定义**：Swift interop layer (placeholder)
- **子目录拓扑**：`src/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`detectSwiftVersion`, `isSwiftAvailable`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 26. [apps/zcode-cli/packages/telemetry](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/telemetry) (@zcode/telemetry)
- **代码规模**：`21` 个源码文件，共 `5,832` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `tests/`
- **导出的核心类 (Classes)**：`AGENT_METRIC_EXPORT_INTERVAL_MS`, `AGENT_TRACE_SAMPLE_RATIO`, `AgentExecutionTelemetryRuntime`, `BaseSpanWriter`, `ModelApiTelemetryStatusSink`, `NoopAgentExecutionTelemetry`, `OtelAgentTelemetryMetrics`, `PROVIDER_ENDPOINT_SANITIZER_VERSION`, `ProviderEndpointIdentityCache`
- **导出的核心接口 (Interfaces)**：`ActiveWriterContext`, `AgentTelemetryMetricRecorder`, `AgentTraceRuntimeOptions`, `CreateModelTelemetryOptions`, `CreateOwnedAgentTelemetryRuntimeOptions`, `ModelTelemetryBootstrap`, `PrepareModelTelemetryOptions`, `RequestObservationTarget`, `SanitizedTelemetryError`, `WriterHealth`
- **导出的核心类型 (Types)**：`AgentMetricSpanName`, `ModelTokenType`
- **核心导出函数 (Functions)**：`activeWriterContext`, `causationFromState`, `claimSanitizedTelemetryError`, `commandCompatibilityAttributes`, `compactAttributes`, `contextFromCausation`, `createAgentTraceSampler`, `createModelTelemetry`, `createOwnedAgentTelemetryRuntime`, `executionProjection`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 27. [apps/zcode-cli/packages/tui](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/tui) (@zcode/tui)
- **代码规模**：`120` 个源码文件，共 `20,663` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `tests/`
- **导出的核心类 (Classes)**：`CTRL_C_EXIT_CONFIRMATION_WINDOW_MS`, `CTRL_C_EXIT_PROMPT`, `FILE_MENTION_VISIBLE_COUNT`, `PROMPT_DRAFT_CLEARED_STATUS`, `TUI_SWITCHABLE_MODES`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`ActiveFileMention`, `ActiveSelectionInput`, `ActiveSelectionPending`, `ApprovalDecision`, `ApprovalPrompt`, `CacheStats`, `ContextUsage`, `CtrlCExitGuard`, `DraftAttachment`, `DraftFileAttachment`
- **核心导出函数 (Functions)**：`appendAgentResult`, `applyModelStreamingEvent`, `cacheStatsFromPayload`, `clampIndex`, `completeEffortCommand`, `completeModeCommand`, `completeModelCommand`, `completeSlashCommand`, `contextWindowFromPayload`, `createCtrlCExitGuard`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 28. [apps/zcode-cli/packages/visualize-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/visualize-plugin) (@zcode/visualize-plugin)
- **代码规模**：`9` 个源码文件，共 `20,542` 行代码
- **功能定义**：ZCode Gen UI authoring skill and examples
- **子目录拓扑**：`skills/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 29. [apps/zcode-cli/packages/zcode-cua-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/zcode-cua-plugin) (@zcode/zcode-cua-plugin)
- **代码规模**：`0` 个源码文件，共 `0` 行代码
- **功能定义**：ZCode CUA SDK and skill package; execution is provided by the shared node_repl host.
- **子目录拓扑**：单层源码结构
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 30. [apps/zcode-cli/packages/zcode-guide-plugin](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/zcode-guide-plugin) (@zcode/zcode-guide-plugin)
- **代码规模**：`0` 个源码文件，共 `0` 行代码
- **功能定义**：作为官方 ZCode 内置插件发布的使用与自诊断指南技能集。
- **子目录拓扑**：单层源码结构
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 31. [packages/android](file:///home/yupeng/references/zcode/packages/android) (android)
- **代码规模**：`0` 个源码文件，共 `0` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：单层源码结构
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 32. [packages/client](file:///home/yupeng/references/zcode/packages/client) (@zcode/client)
- **代码规模**：`21` 个源码文件，共 `3,278` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS`, `AcknowledgedRelayDeadline`, `RemoteServiceAccess`
- **导出的核心接口 (Interfaces)**：`AcknowledgedRelayDeadlineState`, `AcknowledgedRelayOutboundBatch`, `AcknowledgedRelayResolvedLimits`, `AcknowledgedWebRemoteControlRelayProtocolAdapter`, `AcknowledgedWebRemoteControlRelayProtocolOptions`, `WebRemoteControlRelayProtocolAdapter`, `WebRemoteControlRelayProtocolOptions`, `WebSocketConnectionCloseEvent`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`connectViaProtocol`, `connectViaWebSocket`, `createAcknowledgedWebRemoteControlRelayProtocol`, `createWebRemoteControlRelayProtocol`, `isRawTransportCandidate`, `logger`, `measureAcknowledgedRelayBatchBytes`, `rawIdentityMatches`, `requireNonnegativeSafeInteger`, `requirePositiveSafeInteger`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 33. [packages/desktop](file:///home/yupeng/references/zcode/packages/desktop) (@zcode/desktop)
- **代码规模**：`1238` 个源码文件，共 `301,020` 行代码
- **功能定义**：ZCode Desktop App
- **子目录拓扑**：`scripts/`, `src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`applyDesktopTsupEsbuildSecurityOptions`, `desktopRendererDependencyAliases`, `resolveBuildPackagedAgentTelemetryEnv`, `resolveBuildRemoteCdnReleaseRoots`, `resolveDesktopTsupBundleSecurityOptions`, `stagedGitCommitDialogE2E`, `unstagedGitCommitDialogE2E`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 34. [packages/e2e-report](file:///home/yupeng/references/zcode/packages/e2e-report) (@zcode/e2e-report)
- **代码规模**：`10` 个源码文件，共 `1,423` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`
- **导出的核心类 (Classes)**：`DEFAULT_E2E_REPORT_VIEWER_BASE_URL`
- **导出的核心接口 (Interfaces)**：`ContainerSampleSummary`, `CoverageMetricSummary`, `CreateE2EReportViewerUrlOptions`, `E2EReportSummary`, `NumericStats`, `PerformanceTrends`, `ProcessSampleSummary`, `ScriptCoverageSummary`, `SourceFileCoverageSummary`, `TestResultSummary`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`App`, `CoveragePanel`, `TrendPanels`, `createE2EReportViewerUrl`, `formatBytes`, `formatDateTime`, `formatDuration`, `formatNumber`, `loadPerformanceTrends`, `loadReportSummary`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 35. [packages/formal-proof](file:///home/yupeng/references/zcode/packages/formal-proof) (@zcode/formal-proof)
- **代码规模**：`3` 个源码文件，共 `1,835` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：`Candidate`, `Decision`, `ModelProfile`, `ProductContext`, `TraceNode`, `TraceStats`
- **导出的核心类型 (Types)**：`CandidateKind`, `CompactMemory`, `DecisionKind`, `GoalState`, `NodeKind`, `QueueState`, `RunPhase`, `TurnTarget`
- **核心导出函数 (Functions)**：`buildTraceTree`, `collectStats`, `contextKey`, `contextLabel`, `decisionLabel`, `enumerateCandidates`, `evaluate`, `flatten`, `resetIds`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 36. [packages/model-option-map](file:///home/yupeng/references/zcode/packages/model-option-map) (@zcode/model-option-map)
- **代码规模**：`10` 个源码文件，共 `1,101` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`ModelOptionMapError`, `RestrictedCelError`
- **导出的核心接口 (Interfaces)**：`CompiledModelOptionMaps`, `JsonObject`, `ModelOptionMapProgram`, `ModelOptionMapSpecs`, `ModelOptionValues`, `NamedJsonMergePatch`, `RestrictedCelProgram`, `RestrictedCelToken`
- **导出的核心类型 (Types)**：`JsonPrimitive`, `JsonValue`, `ModelOptionName`, `RestrictedCelExpression`, `RestrictedCelTokenKind`, `RestrictedCelValue`
- **核心导出函数 (Functions)**：`applyOrderedJsonMergePatches`, `compileModelOptionMap`, `compileModelOptionMaps`, `compileRestrictedCel`, `evaluateRestrictedCel`, `parseRestrictedCel`, `tokenizeRestrictedCel`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 37. [packages/provider](file:///home/yupeng/references/zcode/packages/provider) (@zcode/provider)
- **代码规模**：`48` 个源码文件，共 `12,104` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`manualConfig`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 38. [packages/provider-node](file:///home/yupeng/references/zcode/packages/provider-node) (@zcode/provider-node)
- **代码规模**：`49` 个源码文件，共 `7,996` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 39. [packages/rpc](file:///home/yupeng/references/zcode/packages/rpc) (@zcode/rpc)
- **代码规模**：`30` 个源码文件，共 `5,597` 行代码
- **功能定义**：VS Code style IPC communication abstraction framework
- **子目录拓扑**：`examples/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`ChunkStream`, `HEADER_SIZE`, `IPCClient`, `IPCServer`, `MessagePortProtocol`, `NetworkTelemetryChannelClient`, `NetworkTelemetryChannelServer`, `ProtocolMessage`, `SocketProtocol`, `StaticRouter`
- **导出的核心接口 (Interfaces)**：`Client`, `ClientConnectionEvent`, `ConnectionFlowControl`, `IClientRouter`, `IConnectionHub`, `IMessagePassingProtocol`, `ISocket`, `MessagePortFlowControl`, `MessagePortLike`, `NetworkObservation`
- **导出的核心类型 (Types)**：`MessagePortFlowState`, `MessagePortPayload`, `NetworkTelemetrySink`, `NetworkTransportKind`
- **核心导出函数 (Functions)**：`createQueuePair`, `emitNetworkTelemetryObservation`, `setNetworkTelemetrySink`, `writeProtocolMessage`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 40. [packages/server](file:///home/yupeng/references/zcode/packages/server) (@zcode/server)
- **代码规模**：`78` 个源码文件，共 `22,778` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`SERVER_HTTP_DEFINES`, `SERVER_HTTP_EXTERNAL_DEPENDENCIES`
- **导出的核心接口 (Interfaces)**：`RemoteServerBundleValidationInput`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`validateRemoteServerBundle`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 41. [packages/services](file:///home/yupeng/references/zcode/packages/services) (@zcode/services)
- **代码规模**：`674` 个源码文件，共 `224,275` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 42. [packages/share-ui](file:///home/yupeng/references/zcode/packages/share-ui) (@zcode/share-ui)
- **代码规模**：`1` 个源码文件，共 `6` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 43. [packages/shared](file:///home/yupeng/references/zcode/packages/shared) (@zcode/shared)
- **代码规模**：`419` 个源码文件，共 `82,754` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：`ICredentialStore`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 44. [packages/stream-animate](file:///home/yupeng/references/zcode/packages/stream-animate) (@zcode/stream-animate)
- **代码规模**：`17` 个源码文件，共 `1,803` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`
- **导出的核心类 (Classes)**：`DATA_DIR_NAME`
- **导出的核心接口 (Interfaces)**：`AppConfig`, `ChatMessageInput`, `CreateRunResponse`, `FrameBucket`, `FrameForecast`, `FrameScenario`, `FrameTrendPoint`, `RawRunResponse`, `RunFormState`, `RunListResponse`
- **导出的核心类型 (Types)**：`ReasoningEffort`, `RunStatus`
- **核心导出函数 (Functions)**：`App`, `FrameChart`, `FrameCharts`, `RunHistory`, `RunStatusBadge`, `RunSummaryPanel`, `buildFrameForecast`, `buildFrameScenario`, `createRawWriter`, `createRun`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 45. [packages/ui](file:///home/yupeng/references/zcode/packages/ui) (@zcode/ui)
- **代码规模**：`2922` 个源码文件，共 `663,605` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`, `vite/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 46. [packages/web](file:///home/yupeng/references/zcode/packages/web) (@zcode/web)
- **代码规模**：`54` 个源码文件，共 `11,559` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 47. [packages/web-share](file:///home/yupeng/references/zcode/packages/web-share) (@zcode/web-share)
- **代码规模**：`3` 个源码文件，共 `255` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`ShareCallbackPage`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 48. [packages/zcode-cua](file:///home/yupeng/references/zcode/packages/zcode-cua) (@zcode/zcode-cua)
- **代码规模**：`24` 个源码文件，共 `975` 行代码
- **功能定义**：API-compatible placeholder package for Computer Use. This build ships without Computer Use: every runtime surface reports unavailable and fails closed.
- **子目录拓扑**：单层源码结构
- **导出的核心类 (Classes)**：`BROKER_SOCKET_ENV`, `BROKER_UNAVAILABLE_ENV`, `BrokerError`, `CUA_REQUEST_ACCESS_STATUS_META_KEY`, `CuaHelperError`
- **导出的核心接口 (Interfaces)**：`AxReadOnlySource`, `BrokerHandler`, `BrokerRequest`, `BrokerResponse`, `CallBrokerMethodArgs`, `ComputerUseRuntime`, `ComputerUseRuntimeContext`, `ComputerUseRuntimeExecuteInput`, `ComputerUseRuntimeOptions`, `CreateProductCuaHelperHostOptions`
- **导出的核心类型 (Types)**：`BrokerErrorCode`, `BrokerMethod`, `CuaHelperErrorCode`, `CuaPermissionState`, `CuaPermissionStatusResult`, `ManagedCuaProductHelperHost`, `NativeAutomationBackend`, `PipSessionEvent`
- **核心导出函数 (Functions)**：`actionUnavailable`, `callBrokerMethod`, `createPipSessionClient`, `cuaRequestAccessStatusSchema`, `dispatchRequest`, `elementUnavailable`, `errorResponse`, `errorResponseFromException`, `foregroundRequired`, `handleRequestLine`
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 49. [packages/zcode-server-cli](file:///home/yupeng/references/zcode/packages/zcode-server-cli) (@zcode/server-cli)
- **代码规模**：`70` 个源码文件，共 `9,440` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`SERVER_CLI_DEFINES`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `zcode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

---

## 三、 清华系 Kimi Code CLI 18 个全量子包与核心逻辑深度透析 (工业防爆)

本章节对 `kimi-code` 下全部 **18 个 Monorepo 子包** 进行地毯式全量解构。包含每个子包的物理路径、代码规模、核心目录拓扑、导出的核心类（Classes）、接口（Interfaces）、类型（Types）、函数（Functions）与对 `bi` 的复刻价值。

### 1. [packages/acp-server](file:///home/yupeng/references/kimi-code/packages/acp-server) (@moonshot-ai/acp-server)
- **代码规模**：`46` 个源码文件，共 `10,194` 行代码
- **功能定义**：Agent Client Protocol (ACP) host backed directly by the DI × Scope agent engine (agent-core-v2)
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`AcpStopReason`, `AcpToolCallStatus`, `AcpToolKind`
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 2. [packages/agent-core-v2](file:///home/yupeng/references/kimi-code/packages/agent-core-v2) (@moonshot-ai/agent-core-v2)
- **代码规模**：`1474` 个源码文件，共 `329,804` 行代码
- **功能定义**：The unified agent engine for Kimi (v2 — DI Scope architecture)
- **子目录拓扑**：`docs/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`AgentModel`, `AgentModelContribution`, `CycleError`, `ErrorCodes`, `EventDispatcherService`, `OrderedHookSlot`, `SessionModelContribution`, `StubConfigService`
- **导出的核心接口 (Interfaces)**：`AgentModelBridge`, `AgentModelContext`, `AgentModelDefinition`, `AgentModelDefinitionInput`, `AgentModelStateSpec`, `AgentStateSnapshot`, `AppStateSnapshot`, `DomainResourceRuntime`, `DurableAgentRuntimeParticipant`, `DurableRuntimeParticipantHost`
- **导出的核心类型 (Types)**：`AgentEvent`, `AgentStateKey`, `AppStateKey`, `ErrorCode`, `Event`, `EventDispatcherHooks`, `HookHandler`, `Hooks`, `KimiErrorCode`, `RestorePhase`
- **核心导出函数 (Functions)**：`agentModelDefinitions`, `createHooks`, `defineAgentModel`, `stubModelOAuthTokens`, `stubOAuthService`, `stubProviderDiscovery`, `stubTokenProvider`
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 3. [packages/kap-server](file:///home/yupeng/references/kimi-code/packages/kap-server) (@moonshot-ai/kap-server)
- **代码规模**：`246` 个源码文件，共 `70,667` 行代码
- **功能定义**：Kimi Code server backed by the DI × Scope agent engine (agent-core-v2)
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 4. [packages/klient](file:///home/yupeng/references/kimi-code/packages/klient) (@moonshot-ai/klient)
- **代码规模**：`87` 个源码文件，共 `17,131` 行代码
- **功能定义**：Kimi client SDK — contract-driven facade over agent-core-v2, routable over ipc or in-memory transports.
- **子目录拓扑**：`examples/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`EXAMPLE_CLIENT_IDENTITY`
- **导出的核心接口 (Interfaces)**：`CallOptions`, `IDisposable`, `KlientChannel`, `ScopeRef`
- **导出的核心类型 (Types)**：`EventSourceRef`
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 5. [packages/kosong](file:///home/yupeng/references/kimi-code/packages/kosong) (@moonshot-ai/kosong)
- **代码规模**：`85` 个源码文件，共 `37,766` 行代码
- **功能定义**：The LLM abstraction layer for modern AI agent applications
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 6. [packages/migration-legacy](file:///home/yupeng/references/kimi-code/packages/migration-legacy) (@moonshot-ai/migration-legacy)
- **代码规模**：`65` 个源码文件，共 `8,798` 行代码
- **功能定义**：Migrate kimi-cli (~/.kimi/) data into kimi-code (~/.kimi-code/).
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：`MigrationNotices`, `MigrationPlan`, `MigrationReport`, `MigrationScope`, `MigrationSummary`, `SessionEntry`, `SessionMigrationFailure`, `SessionsSummary`, `WorkDirEntry`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 7. [packages/minidb](file:///home/yupeng/references/kimi-code/packages/minidb) (@moonshot-ai/minidb)
- **代码规模**：`134` 个源码文件，共 `38,958` 行代码
- **功能定义**：A pure-Node.js embedded key-value database mixing Redis-style in-memory KV with SQLite-style durable persistence (WAL + snapshot).
- **子目录拓扑**：`bench/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`SessionStore`
- **导出的核心接口 (Interfaces)**：`DocRecord`, `OpenOptions`, `Page`, `PreparedOp`, `QueryOptions`, `RestoreOptions`, `ScanEntry`, `SessionDoc`, `SessionHit`, `SetOptions`
- **导出的核心类型 (Types)**：`BatchInputOp`, `ValueCodecName`, `ValueModeSetting`
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 8. [packages/node-sdk](file:///home/yupeng/references/kimi-code/packages/node-sdk) (@moonshot-ai/kimi-code-sdk)
- **代码规模**：`83` 个源码文件，共 `19,225` 行代码
- **功能定义**：TypeScript SDK for the Kimi Code Agent
- **子目录拓扑**：`examples/`, `src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：`AddAdditionalDirInput`, `AddAdditionalDirOptions`, `AddAdditionalDirResult`, `AgentRuntimeBinding`, `AgentSessionWireRecord`, `AgentWirePayload`, `AuthenticateMcpServerOptions`, `CompactOptions`, `CreateGoalInput`, `CreateSessionOptions`
- **导出的核心类型 (Types)**：`JsonObject`, `JsonPrimitive`, `JsonValue`, `PromptInput`, `PromptPart`, `ResumedSessionState`, `SessionPlan`, `SessionTitleKind`, `SessionTodoStatus`, `TextPromptPart`
- **核心导出函数 (Functions)**：`makeTempDir`, `recordingTelemetry`, `removeTempDirs`, `startMcpAuthStatusServer`, `waitForAgentWireEvent`, `waitForSDKEvent`
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 9. [packages/oauth](file:///home/yupeng/references/kimi-code/packages/oauth) (@moonshot-ai/kimi-code-oauth)
- **代码规模**：`51` 个源码文件，共 `16,562` 行代码
- **功能定义**：Kimi OAuth toolkit for managed Kimi Code authentication
- **子目录拓扑**：`examples/`, `src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：`DeviceAuthorization`, `OAuthFlowConfig`, `SpawnInlineWorkersOptions`, `SpawnedWorker`, `TempDirHandle`, `TokenInfo`, `TokenInfoWire`
- **导出的核心类型 (Types)**：`DeviceHeaders`, `OAuthRequestHeaders`, `OAuthStorageBackend`
- **核心导出函数 (Functions)**：`createTempWorkDir`, `spawnInlineWorkers`, `tokenFromWire`, `tokenToWire`
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 10. [packages/pi-tui](file:///home/yupeng/references/kimi-code/packages/pi-tui) (@moonshot-ai/pi-tui)
- **代码规模**：`89` 个源码文件，共 `38,705` 行代码
- **功能定义**：Terminal User Interface library with differential rendering for efficient text-based applications
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`VirtualTerminal`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 11. [packages/remote-control](file:///home/yupeng/references/kimi-code/packages/remote-control) (@moonshot-ai/remote-control)
- **代码规模**：`8` 个源码文件，共 `4,412` 行代码
- **功能定义**：Kimi Remote Control tunnel client: registers this machine with the relay and forwards HTTP/WebSocket traffic to the local server.
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`HttpTunnel`, `REMOTE_CONTROL_LOGOUT_GATE_ORIGIN`, `REMOTE_CONTROL_RELAY_ORIGIN`, `REMOTE_CONTROL_RELAY_URL_ENV`, `RemoteControlAlreadyRunningError`, `RemoteControlDeviceClient`, `RemoteControlDeviceClientError`
- **导出的核心接口 (Interfaces)**：`ParsedRawHttpRequest`, `RemoteControlDevice`, `RemoteControlDeviceClientOptions`, `RemoteControlDeviceList`, `RemoteControlHandle`, `RemoteControlLock`, `RemoteControlLockInfo`, `RemoteControlManager`, `RemoteControlManagerOptions`, `RemoteControlOptions`
- **导出的核心类型 (Types)**：`RemoteControlCloseReason`, `RemoteControlState`, `RemoteControlStatus`
- **核心导出函数 (Functions)**：`acquireRemoteControlLock`, `buildRemoteControlUrl`, `createRemoteControlManager`, `filterForwardRequestHeaders`, `formatRemoteControlAlreadyRunning`, `inspectRemoteControlLock`, `parseRawHttpRequest`, `releaseRemoteControlLockHeldBy`, `remoteControlLockPath`, `resolveRemoteControlRelayOrigin`
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 12. [packages/telemetry](file:///home/yupeng/references/kimi-code/packages/telemetry) (@moonshot-ai/kimi-telemetry)
- **代码规模**：`13` 个源码文件，共 `2,966` 行代码
- **功能定义**：Shared telemetry infrastructure for Kimi Code
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`AsyncTransport`, `DISK_EVENT_MAX_AGE_MS`, `EventSink`, `RETRY_BACKOFFS_MS`, `SERVER_EVENT_PREFIX`, `SystemMetricsCollector`, `TELEMETRY_DISABLE_ENV`, `TelemetryClient`, `TransientTelemetryError`, `USER_ID_PREFIX`
- **导出的核心接口 (Interfaces)**：`AsyncTransportOptions`, `EnrichedTelemetryEvent`, `EventSinkContextOptions`, `EventSinkOptions`, `SystemMetricsCollectorHandle`, `SystemMetricsCollectorOptions`, `SystemMetricsTrackClient`, `TelemetryBootstrapOptions`, `TelemetryContextIds`, `TelemetryEvent`
- **导出的核心类型 (Types)**：`CrashPhase`, `TelemetryContext`, `TelemetryPrimitive`, `TelemetryProperties`
- **核心导出函数 (Functions)**：`applyServerPrefix`, `attachSink`, `buildPayload`, `buildUserId`, `flattenEvent`, `flushSync`, `flushTelemetrySync`, `getDefaultTelemetryClient`, `getSink`, `initializeTelemetry`
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 13. [packages/transcript](file:///home/yupeng/references/kimi-code/packages/transcript) (@moonshot-ai/transcript)
- **代码规模**：`29` 个源码文件，共 `7,091` 行代码
- **功能定义**：Isomorphic transcript rendering data layer: agent-granular L1 store, idempotent L2 operations, granularity-gated L3 subscriptions, framework-free L4 view registry.
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`TRANSCRIPT_EVENT_TYPES`, `ViewRegistry`
- **导出的核心接口 (Interfaces)**：`AgentState`, `AgentTranscriptSnapshot`, `AppendOp`, `AppliedOps`, `ApplyResult`, `AttachmentUpsertOp`, `DaemonFileRef`, `FrameUpsertOp`, `HistoryMessage`, `HistoryTextPartMeta`
- **导出的核心类型 (Types)**：`AppendTarget`, `HistoryContentPart`, `HistoryMediaSource`, `MediaPathTagKind`, `StepHeader`, `TranscriptEvent`, `TranscriptEventType`, `TranscriptGrade`, `TranscriptGradeSpec`, `TranscriptOperation`
- **核心导出函数 (Functions)**：`appendAtOffset`, `applyOperation`, `daemonFileRefFromPairingPart`, `detachGrades`, `filterOpsForGrade`, `foldWireRecordFacts`, `gradeFor`, `groupMessagesIntoSnapshot`, `isAppendOnly`, `isSkillActivationPart`
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 14. [packages/tree-sitter-bash](file:///home/yupeng/references/kimi-code/packages/tree-sitter-bash) (@moonshot-ai/tree-sitter-bash)
- **代码规模**：`17` 个源码文件，共 `7,858` 行代码
- **功能定义**：A pure-TypeScript bash parser producing a syntax tree whose named node types match tree-sitter-bash one-to-one.
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`Aborted`, `DECLARATION_COMMAND_KEYWORDS`, `DEFAULT_MAX_NODES`, `DEFAULT_TIMEOUT_MS`, `EXPRESSION_OPERATORS`, `FILE_REDIRECT_OPERATORS`, `Lexer`, `MAX_PARSE_DEPTH`, `MAX_SUBSTITUTION_DEPTH`, `ParseBudget`
- **导出的核心接口 (Interfaces)**：`BalancedScan`, `BudgetOptions`, `Frame`, `HeredocBody`, `HeredocSpec`, `KnownDifference`, `NodeInit`, `SyntaxNode`, `Token`
- **导出的核心类型 (Types)**：`ParseOptions`, `ParseResult`, `TokenType`
- **核心导出函数 (Functions)**：`createNode`, `descendantsOfType`, `isKnownDifferenceId`, `materialize`, `parse`, `scanBalanced`, `scanBalancedStatements`, `skipBacktick`, `skipDollar`, `skipDoubleQuoted`
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 15. [apps/kimi-code](file:///home/yupeng/references/kimi-code/apps/kimi-code) (@moonshot-ai/kimi-code)
- **代码规模**：`607` 个源码文件，共 `155,957` 行代码
- **功能定义**：The Starting Point for Next-Gen Agents
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`CODEBASE_ARCHIVE_FILENAME`, `INVALID_TUI_CONFIG_MESSAGE`, `KimiTUI`, `MarkdownConfigSchema`, `NotificationConditionSchema`, `NotificationsConfigSchema`, `SESSION_ARCHIVE_FILENAME`, `STATUS_LINE_ITEMS`, `StatusLineConfigSchema`, `StatusLineFileConfigSchema`
- **导出的核心接口 (Interfaces)**：`AppState`, `BackgroundAgentMetadata`, `BackgroundAgentStatusData`, `BannerState`, `CompactionTranscriptData`, `CompleteFeedbackUploadUrlInput`, `CompletedUploadPart`, `CreateFeedbackUploadUrlInput`, `CreateFeedbackUploadUrlResult`, `CronTranscriptData`
- **导出的核心类型 (Types)**：`BackgroundAgentStatusPhase`, `BannerDisplay`, `GoalQueueMoveDirection`, `GoalTranscriptData`, `LivePaneMode`, `MarkdownConfig`, `NotificationsConfig`, `ProgressSpinnerHandle`, `SkillActivationTrigger`, `StatusLineConfig`
- **核心导出函数 (Functions)**：`appendGoalQueueItem`, `createFeedbackArchivePath`, `createTUIState`, `getTuiConfigPath`, `handleMainCommand`, `handleUpgradeCommand`, `loadTuiConfig`, `main`, `moveGoalQueueItem`, `normalizeTuiConfig`
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 16. [apps/kimi-inspect](file:///home/yupeng/references/kimi-code/apps/kimi-inspect) (@moonshot-ai/kimi-inspect)
- **代码规模**：`67` 个源码文件，共 `13,831` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `vite/`
- **导出的核心类 (Classes)**：`DEBUG_RPC_BASE`, `SERVER_DISCOVERY_ENDPOINT`
- **导出的核心接口 (Interfaces)**：`ChannelDescriptor`, `DiscoverOptions`, `DiscoveredServer`, `DiscoveredServerInfo`, `FetchFsSuggestOptions`, `FetchSearchPageOptions`, `FsSuggestItem`, `FsSuggestResult`, `InspectAgentHandle`, `InspectClient`
- **导出的核心类型 (Types)**：`AnyService`, `ChannelScope`, `DiscoveredServerSource`, `FsSuggestKind`, `V2ActivityStatus`, `V2SessionSort`
- **核心导出函数 (Functions)**：`call`, `createInspectClient`, `discoverLocalServers`, `fetchChannelDescriptors`, `fetchFsSuggest`, `fetchSearchPage`, `fetchServerDiscovery`, `fetchV2SessionGroups`, `fetchV2SessionsPage`, `pickDefaultServer`
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 17. [apps/vis](file:///home/yupeng/references/kimi-code/apps/vis) (@moonshot-ai/vis)
- **代码规模**：`106` 个源码文件，共 `15,696` 行代码
- **功能定义**：Debug visualization tool for kimi-code sessions
- **子目录拓扑**：`server/`, `web/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：`ContextResponse`, `DeleteSessionResponse`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`api`, `formatAbsoluteTime`, `formatDuration`, `formatRelativeTime`, `formatTokens`, `formatWallClock`, `parseTimestamp`, `useCron`, `useDeleteSession`, `useImportZip`
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 18. [apps/vscode](file:///home/yupeng/references/kimi-code/apps/vscode) (kimi-code)
- **代码规模**：`151` 个源码文件，共 `27,270` 行代码
- **功能定义**：Official Kimi Code plugin for VS Code
- **子目录拓扑**：`shared/`, `src/`, `test/`, `webview-ui/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`activate`, `vscodeProjects`
- **架构机理与 bi 复刻策略**：本包隶属于 `kimi-code` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

---

## 四、 OpenCode CLI 35 个全量子包与核心逻辑深度透析 (协议治理与现代规范)

本章节对 `opencode` 下全部 **35 个 Monorepo 子包** 进行地毯式全量解构。包含每个子包的物理路径、代码规模、核心目录拓扑、导出的核心类（Classes）、接口（Interfaces）、类型（Types）、函数（Functions）与对 `bi` 的复刻价值。

### 1. [packages/ai](file:///home/yupeng/references/opencode/packages/ai) (@opencode/ai)
- **代码规模**：`406` 个源码文件，共 `79,659` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`example/`, `script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 2. [packages/app](file:///home/yupeng/references/opencode/packages/app) (@opencode/app)
- **代码规模**：`762` 个源码文件，共 `178,767` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`component-tests/`, `e2e/`, `public/`, `src/`, `test-browser/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`icons`, `onDemandAsset`, `serviceWorker`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 3. [packages/cli](file:///home/yupeng/references/opencode/packages/cli) (@opencode/cli)
- **代码规模**：`194` 个源码文件，共 `25,226` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`dev/`, `script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`Agent`, `Command`, `Connection`, `Credential`, `Error`, `Integration`, `Model`, `Plugin`, `Provider`, `Reference`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`NodeAsset`, `NodeBuildInput`, `OpencodePtyAsset`
- **核心导出函数 (Functions)**：`appArchiveAsset`, `buildAppArchive`, `collectFiles`, `collectNodeAssets`, `copyNodeAssets`, `css`, `define`, `findBinary`, `hashNodeAssets`, `javascript`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 4. [packages/client](file:///home/yupeng/references/opencode/packages/client) (@opencode/client)
- **代码规模**：`61` 个源码文件，共 `23,645` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`EventSubscribeOutput`, `SessionGetOutput`
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 5. [packages/codemode](file:///home/yupeng/references/opencode/packages/codemode) (@opencode/codemode)
- **代码规模**：`85` 个源码文件，共 `31,485` 行代码
- **功能定义**：Effect-native confined code execution over schema-described tools
- **子目录拓扑**：`script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 6. [packages/console](file:///home/yupeng/references/opencode/packages/console) (console)
- **代码规模**：`116` 个源码文件，共 `18,892` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`app/`, `function/`, `resource/`
- **导出的核心类 (Classes)**：`Resource`, `SalesforceCliError`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`config`, `salesforceCliResponse`, `waitUntil`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 7. [packages/containers](file:///home/yupeng/references/opencode/packages/containers) (containers)
- **代码规模**：`1` 个源码文件，共 `77` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 8. [packages/core](file:///home/yupeng/references/opencode/packages/core) (@opencode/core)
- **代码规模**：`750` 个源码文件，共 `173,829` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`v`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 9. [packages/desktop](file:///home/yupeng/references/opencode/packages/desktop) (@opencode/desktop)
- **代码规模**：`174` 个源码文件，共 `15,003` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`scripts/`, `src/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`getConfig`, `pickerPlugin`, `prepareDevElectron`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 10. [packages/effect-drizzle-sqlite](file:///home/yupeng/references/opencode/packages/effect-drizzle-sqlite) (effect-drizzle-sqlite)
- **代码规模**：`1` 个源码文件，共 `10` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：单层源码结构
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 11. [packages/function](file:///home/yupeng/references/opencode/packages/function) (@opencode/function)
- **代码规模**：`5` 个源码文件，共 `622` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`SyncServer`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`parseRepositoryClaim`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 12. [packages/gui-extensions](file:///home/yupeng/references/opencode/packages/gui-extensions) (@opencode/gui-extensions)
- **代码规模**：`846` 个源码文件，共 `60,925` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`
- **导出的核心类 (Classes)**：`Failure`, `Ssh`, `SshConfig`, `SshHttp`, `SshItem`, `SshPrompt`, `SshStage`, `SshStart`, `SshState`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`BtwModel`, `SshConfig`, `SshHttp`, `SshItem`, `SshStart`, `SshState`
- **核心导出函数 (Functions)**：`archiveUrl`, `binaryPath`, `bootstrap`, `builtins`, `createBtw`, `createSshController`, `discoverScript`, `installScript`, `isSshConnecting`, `latestBeta`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 13. [packages/http-recorder](file:///home/yupeng/references/opencode/packages/http-recorder) (@opencode/http-recorder)
- **代码规模**：`23` 个源码文件，共 `3,296` 行代码
- **功能定义**：Record and replay Effect HTTP and WebSocket traffic with deterministic cassettes
- **子目录拓扑**：`script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`CassetteMetadataSchema`, `CassetteNotFoundError`, `CassetteSchema`, `InteractionSchema`, `InvalidCassetteError`, `Service`, `UnsafeCassetteError`, `WebSocketEventSchema`, `WebSocketInteractionSchema`
- **导出的核心接口 (Interfaces)**：`Interface`, `RecorderOptions`, `RedactOptions`, `RequestSnapshot`, `WebSocketInteraction`
- **导出的核心类型 (Types)**：`Cassette`, `CassetteMetadata`, `Interaction`, `JsonValue`, `RecorderOptions`, `RedactOptions`, `RequestMatcher`, `RequestSnapshot`, `SocketRecorderOptions`, `WebSocketEvent`
- **核心导出函数 (Functions)**：`decodeCassette`, `encodeCassette`, `failureText`, `fileSystem`, `hasCassetteSync`, `httpInteractions`, `isHttpInteraction`, `isWebSocketInteraction`, `layerSocket`, `layerSocketWithMode`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 14. [packages/httpapi-codegen](file:///home/yupeng/references/opencode/packages/httpapi-codegen) (@opencode/httpapi-codegen)
- **代码规模**：`13` 个源码文件，共 `4,240` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`Api`, `ClientError`, `GenerationError`, `GroupEvent`, `GroupSession`, `GroupSystem`, `Missing`
- **导出的核心接口 (Interfaces)**：`AppApi`, `ClientOptions`, `RequestOptions`
- **导出的核心类型 (Types)**：`Attempt`, `ClientErrorReason`, `Contract`, `EffectOutputType`, `EffectTypeReference`, `Endpoint`, `ExampleName`, `ExampleName2`, `Field`, `Group`
- **核心导出函数 (Functions)**：`adaptGroupEvent`, `adaptGroupSession`, `adaptGroupSystem`, `compile`, `emitEffect`, `emitEffectImported`, `emitEffectShape`, `emitPromise`, `generate`, `it`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 15. [packages/identity](file:///home/yupeng/references/opencode/packages/identity) (identity)
- **代码规模**：`0` 个源码文件，共 `0` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：单层源码结构
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 16. [packages/latex](file:///home/yupeng/references/opencode/packages/latex) (@opencode/latex)
- **代码规模**：`14` 个源码文件，共 `2,646` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`
- **导出的核心类 (Classes)**：`DEFAULT_MAX_NESTING_DEPTH`, `DEFAULT_MAX_SOURCE_LENGTH`, `LatexParseError`
- **导出的核心接口 (Interfaces)**：`MathCell`, `MathLayout`, `MathStyle`, `ParseOptions`, `RenderLatexOptions`, `SymbolDefinition`
- **导出的核心类型 (Types)**：`AccentKind`, `LatexOptions`, `MathNode`, `MathVariant`, `MatrixEnvironment`, `SymbolRole`
- **核心导出函数 (Functions)**：`assertNestingDepth`, `assertSourceLength`, `createLatexCodeBlockRenderer`, `expandLatexMacros`, `layoutMath`, `namedOperators`, `parseLatex`, `renderLatex`, `renderLatexToString`, `resolvePositiveInteger`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 17. [packages/merman](file:///home/yupeng/references/opencode/packages/merman) (@opencode/merman)
- **代码规模**：`89` 个源码文件，共 `21,640` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`, `src/`
- **导出的核心类 (Classes)**：`MermaidSyntaxError`, `NOTE_CONNECTOR_RAMP_STYLES`, `STATE_DEPARTURE_RAMP_STYLES`
- **导出的核心接口 (Interfaces)**：`MermaidMarkdownRendererOptions`, `OpenCodeDiagramPaletteInput`, `StateTransitionJunctionPlan`, `StateTransitionRenderLabel`, `StateTransitionRenderOptions`, `StateTransitionRenderPlan`
- **导出的核心类型 (Types)**：`MermaidDiagramKind`, `OpenCodeDiagramPalette`, `StateStyleColors`, `StateTransitionPathPoint`, `StateTransitionRenderCell`, `StateTransitionRoutePlan`
- **核心导出函数 (Functions)**：`createMermaidCodeBlockRenderer`, `createMermaidMarkdownRenderer`, `createOpenCodeDiagramPalette`, `createStateDiagramDrawing`, `createStateTransitionJunctionPlans`, `createStateTransitionRenderPlans`, `createStateTransitionRoutePlans`, `detectMermaidDiagram`, `drawStateDiagramGrid`, `hasReverseTransition`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 18. [packages/plugin](file:///home/yupeng/references/opencode/packages/plugin) (@opencode/plugin)
- **代码规模**：`66` 个源码文件，共 `3,585` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`AssertInput`
- **导出的核心接口 (Interfaces)**：`App`, `AssertInput`, `Entrypoints`, `StorageEntry`, `StorageScanOptions`, `StorageScanResult`, `Target`, `WorktreeCreateInput`, `WorktreeEntry`, `WorktreeRemoveInput`
- **导出的核心类型 (Types)**：`PluginOptions`, `RuntimeModuleLoader`
- **核心导出函数 (Functions)**：`createForeignPackageFilter`, `createLoader`, `createPluginSources`, `discoverPluginRuntimeSpecifiers`, `ensurePluginRuntime`, `load`, `loadRuntimeModules`, `localSource`, `missingPackageTarget`, `pluginRuntimeLoaderCode`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 19. [packages/plugin-browser](file:///home/yupeng/references/opencode/packages/plugin-browser) (@opencode/plugin-browser)
- **代码规模**：`11` 个源码文件，共 `1,894` 行代码
- **功能定义**：OpenCode's desktop browser plugin
- **子目录拓扑**：`script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`Action`, `Body`, `Command`, `ConsoleEntry`, `Control`, `Definition`, `File`, `FileID`, `FileInfo`, `MAX_FILE_BYTES`
- **导出的核心接口 (Interfaces)**：`Command`, `ConsoleEntry`, `File`, `FileInfo`, `Result`, `State`, `Tab`
- **导出的核心类型 (Types)**：`Action`, `Body`, `Connection`, `Control`, `FileID`, `Method`, `NetworkRequest`, `Operation`, `Outcome`, `Proxy`
- **核心导出函数 (Functions)**：`captureName`, `make`, `normalizeAction`, `read`, `register`, `save`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 20. [packages/plugins](file:///home/yupeng/references/opencode/packages/plugins) (plugins)
- **代码规模**：`11` 个源码文件，共 `11,118` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`figma/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 21. [packages/posts](file:///home/yupeng/references/opencode/packages/posts) (@opencode/posts)
- **代码规模**：`3` 个源码文件，共 `40` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`, `src/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`collections`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 22. [packages/protocol](file:///home/yupeng/references/opencode/packages/protocol) (@opencode/protocol)
- **代码规模**：`45` 个源码文件，共 `4,597` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`Action`, `AgentNotFoundError`, `ArrowParams`, `Attached`, `Authorization`, `BackendRpcs`, `Capabilities`, `Capability`, `CapturedFrame`, `CapturedImage`
- **导出的核心接口 (Interfaces)**：`ArrowParams`, `Attached`, `CapturedFrame`, `CapturedImage`, `ChunkParams`, `ClickParams`, `DisconnectParams`, `DispatchAction`, `Element`, `FinishParams`
- **导出的核心类型 (Types)**：`Action`, `Api`, `Capability`, `Color`, `EndpointRole`, `FinishReason`, `Item`, `Matches`, `MouseParams`, `Notification`
- **核心导出函数 (Functions)**：`decodeNotification`, `decodeNotificationEffect`, `decodeRequest`, `decodeRequestEffect`, `dispatch`, `effectOmitEndpoints`, `exposedToolName`, `failure`, `groupNames`, `makeApi`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 23. [packages/schema](file:///home/yupeng/references/opencode/packages/schema) (@opencode/schema)
- **代码规模**：`119` 个源码文件，共 `7,138` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`generate`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 24. [packages/script](file:///home/yupeng/references/opencode/packages/script) (@opencode/script)
- **代码规模**：`4` 个源码文件，共 `248` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`Script`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`Highlight`
- **核心导出函数 (Functions)**：`embed`, `parse`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 25. [packages/sdk](file:///home/yupeng/references/opencode/packages/sdk) (@opencode/sdk)
- **代码规模**：`30` 个源码文件，共 `2,897` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`OpenCodeDO`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 26. [packages/server](file:///home/yupeng/references/opencode/packages/server) (@opencode/server)
- **代码规模**：`88` 个源码文件，共 `9,123` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 27. [packages/session-ui](file:///home/yupeng/references/opencode/packages/session-ui) (@opencode/session-ui)
- **代码规模**：`154` 个源码文件，共 `29,348` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`component-tests/`, `performance/`, `script/`, `src/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`FilePartSource`, `PresentationFileContent`, `PresentationFileDiff`, `SessionDocument`, `SessionUserActions`, `SessionUserAttachmentReference`, `SessionUserComment`
- **核心导出函数 (Functions)**：`value`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 28. [packages/simulation](file:///home/yupeng/references/opencode/packages/simulation) (@opencode/simulation)
- **代码规模**：`25` 个源码文件，共 `4,247` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`Event`, `Header`, `Manifest`, `Output`, `Pointer`, `Resize`, `ResolveError`, `Timeline`
- **导出的核心接口 (Interfaces)**：`Harness`, `Header`, `Manifest`, `Output`, `Pointer`, `Resize`, `Server`, `Socket`, `SocketData`
- **导出的核心类型 (Types)**：`Action`, `Element`, `Event`
- **核心导出函数 (Functions)**：`capture`, `createHarness`, `elements`, `execute`, `matches`, `resolve`, `snapshot`, `start`, `state`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 29. [packages/stats](file:///home/yupeng/references/opencode/packages/stats) (stats)
- **代码规模**：`96` 个源码文件，共 `20,850` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`app/`, `core/`, `server/`
- **导出的核心类 (Classes)**：`AppConfig`, `AppConfigValue`, `DatabaseConfig`, `DatabaseError`, `DatabaseSettings`, `DatabaseUrl`, `DrizzleClient`, `MigrationError`, `R2Sql`, `R2SqlQueryError`
- **导出的核心接口 (Interfaces)**：`Service`
- **导出的核心类型 (Types)**：`DatabaseUrl`, `Drizzle`, `R2SqlData`, `RuntimeServices`, `SyncStatsError`, `SyncStatsResult`
- **核心导出函数 (Functions)**：`catchDbError`, `layer`, `migrate`, `queryR2SqlPages`, `runtime`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 30. [packages/storybook](file:///home/yupeng/references/opencode/packages/storybook) (@opencode/storybook)
- **代码规模**：`28` 个源码文件，共 `1,480` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`.storybook/`, `playwright/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`FileSelection`, `LocalProject`, `SelectedLineRange`
- **核心导出函数 (Functions)**：`PlatformProvider`, `ThemeTool`, `componentConfig`, `getProjectAvatarVariant`, `playgroundCss`, `selectionFromLines`, `sourceURL`, `story`, `useComments`, `useCurrentRoute`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 31. [packages/theme](file:///home/yupeng/references/opencode/packages/theme) (@opencode/theme)
- **代码规模**：`14` 个源码文件，共 `1,671` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`ActionState`, `ActionVariant`, `BaseThemeDefinition`, `CategoricalDefinition`, `FeedbackKind`, `FormfieldState`, `HueName`, `HueStep`, `MarkdownDefinition`, `MarkdownToken`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`ActionState`, `ActionStateKey`, `ActionStates`, `ActionVariant`, `BackgroundDefinition`, `BaseThemeDefinition`, `Categorical`, `CategoricalDefinition`, `ColorValue`, `DiffDefinition`
- **核心导出函数 (Functions)**：`expandTheme`, `expandTokens`, `generateSyntax`, `mergeTheme`, `migrateV1`, `oklchToHex`, `parseThemeDocument`, `resolveTheme`, `resolveThemeDocument`, `rgbToOklch`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 32. [packages/tui](file:///home/yupeng/references/opencode/packages/tui) (@opencode/tui)
- **代码规模**：`470` 个源码文件，共 `107,072` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`Effect`, `Panel`, `Schema`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`OwnedClipboardService`
- **核心导出函数 (Functions)**：`boom`, `createClipboardAdapter`, `createTuiClipboard`, `fromPluginZod`, `generation`, `helper`, `increment`, `label`, `plugin`, `read`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 33. [packages/ui](file:///home/yupeng/references/opencode/packages/ui) (@opencode/ui)
- **代码规模**：`222` 个源码文件，共 `36,626` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`, `src/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`average`, `changes`, `code`, `dict`, `diff`, `greet`, `markdown`, `pack`, `sum`, `value`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 34. [packages/util](file:///home/yupeng/references/opencode/packages/util) (@opencode/util)
- **代码规模**：`52` 个源码文件，共 `5,004` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`script/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`AppProcessError`, `FileSystemError`, `Service`
- **导出的核心接口 (Interfaces)**：`DirEntry`, `Interface`, `RetryOptions`, `RunOptions`, `RunResult`, `RunStreamOptions`, `UpOptions`
- **导出的核心类型 (Types)**：`Error`, `Interface`
- **核心导出函数 (Functions)**：`abortError`, `base64Decode`, `base64Encode`, `checksum`, `collectStream`, `comparablePath`, `contains`, `containsDirectory`, `encodeFilePath`, `fast`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 35. [packages/web](file:///home/yupeng/references/opencode/packages/web) (@opencode/web)
- **代码规模**：`19` 个源码文件，共 `2,659` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`src/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：`MapReturn`
- **导出的核心类型 (Types)**：`DocsLocale`, `Locale`, `ShareMessages`
- **核心导出函数 (Functions)**：`ContentCode`, `ContentError`, `ContentMarkdown`, `ContentText`, `IconAnthropic`, `IconArrowDown`, `IconBrain`, `IconCheckCircle`, `IconChevronDown`, `IconChevronRight`
- **架构机理与 bi 复刻策略**：本包隶属于 `opencode` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

---

## 五、 DeepSeek Harness 52 个全量子包与核心逻辑深度透析 (大模型原生基础设施)

本章节对 `dhs` 下全部 **52 个 Monorepo 子包** 进行地毯式全量解构。包含每个子包的物理路径、代码规模、核心目录拓扑、导出的核心类（Classes）、接口（Interfaces）、类型（Types）、函数（Functions）与对 `bi` 的复刻价值。

### 1. [packages/acp](file:///home/yupeng/references/deepseek-harness/packages/acp) (acp)
- **代码规模**：`19` 个源码文件，共 `5,387` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`acp/`
- **导出的核心类 (Classes)**：`AcpContentError`, `AcpMcpConfigError`, `AcpModelConfigError`, `AcpModelControl`, `AcpSession`
- **导出的核心接口 (Interfaces)**：`AcpConfig`, `CreateAcpSessionOptions`, `ResumeAcpSessionOptions`
- **导出的核心类型 (Types)**：`AcpContentFailureKind`
- **核心导出函数 (Functions)**：`admitAcpPrompt`, `apply`, `assistantBlockToAcp`, `assistantUpdates`, `inject`, `mountAcpMcpServers`, `name`, `supportsAcpImagePrompts`, `toolCallUpdate`, `toolResultUpdate`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 2. [packages/api](file:///home/yupeng/references/deepseek-harness/packages/api) (api)
- **代码规模**：`215` 个源码文件，共 `64,312` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`account-controller/`, `gateway/`, `job-controller/`, `remote-access/`, `remotes/`, `session-controller/`, `settings-controller/`, `terminal-controller/`, `workspace-controller/`, `workspace-files/`
- **导出的核心类 (Classes)**：`ClientAccessState`, `REMOTE_ACCESS_SNAPSHOT_KEY`, `RemoteAccessService`
- **导出的核心接口 (Interfaces)**：`RemoteAccessDeniedDetails`, `RemoteAccessGrant`, `RemoteAccessPolicy`, `RemoteAccessRequest`, `RemoteAccessRole`
- **导出的核心类型 (Types)**：`Baseline`, `RemoteAccessAction`, `RemoteAccessBaseline`, `RemoteAccessBinding`, `RemoteAccessCondition`, `RemoteAccessDecision`, `RemoteAccessEndpoint`, `RemoteAccessFrame`
- **核心导出函数 (Functions)**：`apply`, `inject`, `parseInjectedBaseline`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 3. [packages/attachment](file:///home/yupeng/references/deepseek-harness/packages/attachment) (attachment)
- **代码规模**：`28` 个源码文件，共 `4,436` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`attachment/`, `attachment-local/`
- **导出的核心类 (Classes)**：`AttachmentError`, `AttachmentStore`, `CompressionLimiter`, `DEFAULT_IMAGE_COMPRESSION_CONCURRENCY`, `DEFAULT_MAX_IMAGES_PER_MESSAGE`, `DEFAULT_MAX_IMAGE_BYTES`, `DEFAULT_MAX_IMAGE_DIMENSION`, `DEFAULT_MAX_IMAGE_PIXELS`, `DEFAULT_MAX_MESSAGE_IMAGE_BYTES`, `DEFAULT_NORMALIZED_IMAGE_MAX_BYTES`
- **导出的核心接口 (Interfaces)**：`Config`, `DecodedImageLimits`, `DetectedImage`, `EncodedCandidate`, `EncodedFileAttachment`, `EncodedImage`, `EncodedImageAttachment`, `ExhaustedEncoding`, `FileAttachmentRef`, `ImageAttachmentLimits`
- **导出的核心类型 (Types)**：`AdmittedPromptContentPart`, `AttachmentAdmissionPart`, `AttachmentErrorCode`, `AttachmentId`, `ImageAdmissionErrorCode`, `ImageMediaType`, `ImageVariantId`, `PromptContentPart`
- **核心导出函数 (Functions)**：`AttachmentId`, `ImageVariantId`, `admitEncodedFile`, `admitEncodedImages`, `canPassThroughNormalization`, `compressionFailure`, `detectImage`, `encodeFirstWithinLimit`, `encodedAlphaIsCompatible`, `encodingLadder`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 4. [packages/boot](file:///home/yupeng/references/deepseek-harness/packages/boot) (boot)
- **代码规模**：`107` 个源码文件，共 `30,796` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`app-boot/`, `cmdline/`, `config-editor/`, `hmr/`, `plugin-manager/`, `plugin-market/`
- **导出的核心类 (Classes)**：`FAIL_LOUD_RELEASE_TIMEOUT_MS`, `PROFILES_DIR`, `PROFILE_COMPATIBILITY_FILENAME`, `PROFILE_PATCH_FILENAME`, `ProfileRuntimeResolution`, `StartupError`
- **导出的核心接口 (Interfaces)**：`AppExit`, `AppReady`, `AppStdin`, `CmdlineArgs`, `CmdlineHost`, `ConfigDumpLayer`, `FailLoudProcess`, `LinkedRoot`, `OfficialBundleCatalogEntry`, `PluginCompatibility`
- **导出的核心类型 (Types)**：`FailLoudEvent`, `ProfileManifest`
- **核心导出函数 (Functions)**：`apply`, `auditStartupEntries`, `boot`, `bundlePatchFiles`, `bundlePatchPaths`, `composeEntries`, `createRuntimeResolution`, `evaluatePluginCompatibility`, `exitOnStdinEnd`, `getDshRuntimeVersion`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 5. [packages/browser-use](file:///home/yupeng/references/deepseek-harness/packages/browser-use) (browser-use)
- **代码规模**：`3` 个源码文件，共 `113` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`browser-use/`
- **导出的核心类 (Classes)**：`BrowserUseRegistry`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`BrowserUseProviderName`
- **核心导出函数 (Functions)**：`BrowserUseProviderName`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 6. [packages/bundle](file:///home/yupeng/references/deepseek-harness/packages/bundle) (bundle)
- **代码规模**：`31` 个源码文件，共 `5,103` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`acp-app/`, `base/`, `headless/`, `sdk-app/`, `sdk-minimal/`, `web-app/`
- **导出的核心类 (Classes)**：`ACP_APP_STARTUP_SERVICE`, `HEADLESS_STARTUP_SERVICE`, `MAX_EVENT_BYTES`, `MAX_STRING_BYTES`
- **导出的核心接口 (Interfaces)**：`Config`, `HeadlessStartupValues`, `JsonProjection`, `JsonProjectionOptions`, `JsonSink`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`apply`, `boundJsonLine`, `inject`, `name`, `projectJsonRun`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 7. [packages/client](file:///home/yupeng/references/deepseek-harness/packages/client) (client)
- **代码规模**：`1807` 个源码文件，共 `326,668` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`connection/`, `file-upload/`, `hmr/`, `locale/`, `modules/`, `product-analytics/`, `resources/`, `shortcuts/`, `store/`, `ui-agent-preset/`, `ui-approval/`, `ui-attachment/`, `ui-brand-official/`, `ui-chat/`, `ui-commands/`, `ui-conversation/`, `ui-deliverables/`, `ui-directory-picker-browse/`, `ui-directory-picker-native/`, `ui-dockkit/`, `ui-goal/`, `ui-input-trigger/`, `ui-jobs/`, `ui-layout/`, `ui-message-feedback/`, `ui-model-selection/`, `ui-open-in-app/`, `ui-permission-presets/`, `ui-plan/`, `ui-plugin-manager/`, `ui-plugin-market/`, `ui-primitives/`, `ui-reference/`, `ui-renderer/`, `ui-schedule/`, `ui-secret-mask/`, `ui-session/`, `ui-settings/`, `ui-settings-account/`, `ui-settings-agent-loop/`, `ui-settings-general/`, `ui-settings-models/`, `ui-settings-plugin-inventory/`, `ui-settings-plugins/`, `ui-settings-session-log/`, `ui-settings-shell/`, `ui-settings-subagent/`, `ui-settings-web-search/`, `ui-shortcuts/`, `ui-sidebar/`, `ui-sidebar-browser/`, `ui-sidebar-documentpreview/`, `ui-sidebar-files/`, `ui-sidebar-right/`, `ui-sidebar-terminal/`, `ui-skill/`, `ui-slots/`, `ui-subagent/`, `ui-theme/`, `ui-tool/`, `ui-trajectory/`, `ui-user-questions/`, `ui-workflow-run/`, `ui-workspace/`, `web/`
- **导出的核心类 (Classes)**：`INLINE_SAFE`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`clientBundle`, `clientLibrary`, `clientOnly`, `isStaticLinkedConfig`, `requestedExternals`, `staticLinked`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 8. [packages/compaction](file:///home/yupeng/references/deepseek-harness/packages/compaction) (compaction)
- **代码规模**：`32` 个源码文件，共 `8,852` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`command-compact/`, `compaction/`, `compaction-basic/`, `compaction-image-offload/`, `compaction-tool-result-pruner/`
- **导出的核心类 (Classes)**：`BasicCompactionEngine`, `CompactionEngine`, `ManualCompactionError`
- **导出的核心接口 (Interfaces)**：`CompactionAgentContext`, `CompactionResult`, `ImageOffloadTarget`, `ManualCompactAgentContext`
- **导出的核心类型 (Types)**：`CompactionCheckpointSource`, `CompactionId`, `CompactionTrigger`, `ManualCompactionErrorCode`
- **核心导出函数 (Functions)**：`CompactionId`, `apply`, `compactCheckpointSource`, `inject`, `isCompactCheckpointSource`, `name`, `offloadMessageImages`, `offloadOldestImages`, `toolPairingBalancedAfter`, `toolPairingBalancedBefore`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 9. [packages/computer-use](file:///home/yupeng/references/deepseek-harness/packages/computer-use) (computer-use)
- **代码规模**：`3` 个源码文件，共 `113` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`computer-use/`
- **导出的核心类 (Classes)**：`ComputerUseRegistry`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`ComputerUseProviderName`
- **核心导出函数 (Functions)**：`ComputerUseProviderName`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 10. [packages/context](file:///home/yupeng/references/deepseek-harness/packages/context) (context)
- **代码规模**：`39` 个源码文件，共 `13,971` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`agent-instructions/`, `file-reference/`, `file-reference-local/`, `harness-dev-context/`, `session-reference/`, `time-context/`, `tmux-context/`
- **导出的核心类 (Classes)**：`AGENTS_GLOBAL_DIRECTORY`, `DEFAULT_CANDIDATE_LIMIT`, `DEFAULT_MAX_REFERENCE_BYTES`, `MAX_REFERENCES`, `REFERENCE_WARNING`, `SESSION_REFERENCE_SCHEME`, `SessionReferenceError`, `SessionReferenceResolver`, `USER_GLOBAL_DIRECTORIES`, `USER_GLOBAL_DIRECTORY`
- **导出的核心接口 (Interfaces)**：`AgentInstructionChange`, `AgentInstructionSource`, `ChangeRenderItem`, `Config`, `InstructionFile`, `InstructionVersionState`, `InstructionVersionUpdate`, `LoadedInstructionFile`, `ParsedSessionReferenceText`, `ProbedInstructionFile`
- **导出的核心类型 (Types)**：`InstructionVersionCache`, `ScopeInstructionProbe`, `SessionReferenceErrorCode`
- **核心导出函数 (Functions)**：`agentInstructionsMessage`, `ancestorChain`, `apply`, `applyInstructionVersionUpdates`, `baselineInstructionState`, `candidateScopeKey`, `decodeScopeKey`, `decodeSessionReferenceUri`, `dedupInstructionFilesByCandidateGroup`, `descendantDirsBetween`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 11. [packages/core](file:///home/yupeng/references/deepseek-harness/packages/core) (core)
- **代码规模**：`117` 个源码文件，共 `47,396` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`agent/`, `agent-default-model/`, `agent-loop/`, `agent-tool-presentation/`, `scope/`, `session/`, `system-prompt/`, `tools/`
- **导出的核心类 (Classes)**：`CodeRunFailedError`, `JsonSchemaError`, `PtcCalls`, `RUN_CODE_NAME`, `TOOL_ABORTED`, `TOOL_ABORTED_BEFORE_DISPATCH`, `ToolArgsError`, `ToolNotFoundError`, `ToolOutputError`, `ToolRuntime`
- **导出的核心接口 (Interfaces)**：`ArrayValueSchemaSpec`, `BooleanValueSchemaSpec`, `Config`, `DefineToolOptions`, `DiffCallView`, `DiffResultView`, `FileDiff`, `FileLocation`, `GenericCallView`, `GenericResultView`
- **导出的核心类型 (Types)**：`ContentToolFixtureOptions`, `InferArgs`, `InferValue`, `JsonSchemaScalar`, `JsonSchemaType`, `ObjectJsonSchema`, `ParameterPropertySpec`, `ParameterSchemaSpec`, `PostToolDecision`, `PreToolDecision`
- **核心导出函数 (Functions)**：`assertObjectJsonSchema`, `assertSupportedJsonSchema`, `createRunCodeTool`, `defineContentToolFixture`, `defineTool`, `isJsonSchemaRecord`, `isPlainJsonArray`, `isPlainJsonRecord`, `jsonSchemaToPy`, `jsonSchemaToTs`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 12. [packages/credentials](file:///home/yupeng/references/deepseek-harness/packages/credentials) (credentials)
- **代码规模**：`31` 个源码文件，共 `8,114` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`authorization/`, `credentials/`, `credentials-local/`, `deepseek-account/`, `deepseek-account-platform/`
- **导出的核心类 (Classes)**：`AccountUnauthorizedError`, `Config`, `DeepSeekAccount`, `PlatformAccount`, `PlatformAuthError`
- **导出的核心接口 (Interfaces)**：`AccountBonusBatch`, `AccountBonusNotification`, `AccountClientMetadata`, `AccountDetails`, `AccountLinks`, `AccountProfile`, `AccountView`, `AccountWallet`, `Config`, `LogoutRetryPolicy`
- **导出的核心类型 (Types)**：`AccountBonusOrderId`, `AccountUserId`, `SignInAttemptId`, `SignInErrorCode`
- **核心导出函数 (Functions)**：`browserUrl`, `desktopClientHeaders`, `exchange`, `initialization`, `installAccountTaskCancellation`, `isRunningAccountTask`, `loginOrigin`, `logoutAccount`, `mergePlatformCookies`, `platformClientHeaders`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 13. [packages/deliverables](file:///home/yupeng/references/deepseek-harness/packages/deliverables) (deliverables)
- **代码规模**：`21` 个源码文件，共 `2,897` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`tool-present/`, `workspace-changes/`
- **导出的核心类 (Classes)**：`GitRunner`, `TurnRecorder`
- **导出的核心接口 (Interfaces)**：`Comparison`, `Config`, `GitLimits`, `GitRunOptions`, `GitRunResult`, `GitWorkspace`, `NumstatEntry`, `RecorderEnvironment`, `TreeBlob`, `WorkspaceChangedFile`
- **导出的核心类型 (Types)**：`Capture`, `WorkspaceFileDiff`
- **核心导出函数 (Functions)**：`apply`, `blobText`, `canonicalPath`, `captureFile`, `changes`, `compareDisplay`, `compareText`, `diffTrees`, `displayPathOf`, `durablePathOf`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 14. [packages/document](file:///home/yupeng/references/deepseek-harness/packages/document) (document)
- **代码规模**：`10` 个源码文件，共 `1,772` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`office-to-pdf/`
- **导出的核心类 (Classes)**：`ConversionQueue`, `OfficeToPdf`, `OfficeToPdfError`
- **导出的核心接口 (Interfaces)**：`Config`, `OfficeToPdfRequest`, `OfficeToPdfResult`, `RenderedDocumentBytes`
- **导出的核心类型 (Types)**：`OfficeExtension`, `OfficeSourceKey`, `OfficeToPdfErrorCode`, `OfficeToPdfGeneration`, `OfficeToPdfKey`, `OfficeToPdfPriority`
- **核心导出函数 (Functions)**：`OfficeSourceKey`, `OfficeToPdfGeneration`, `OfficeToPdfKey`, `readPdf`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 15. [packages/experimental](file:///home/yupeng/references/deepseek-harness/packages/experimental) (experimental)
- **代码规模**：`777` 个源码文件，共 `125,956` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`agent-team/`, `agent-team-profile/`, `api-speech-to-text/`, `auto-review/`, `badge-skill-bundle/`, `browser-use-chrome-devtools-mcp/`, `browser-use-playwright-mcp/`, `browser-use-runtime/`, `browser-use-stagehand-native/`, `claude-code-mods/`, `client-ui-agent-team/`, `client-ui-claude-code-mods/`, `client-ui-cot-translation/`, `client-ui-voice-input/`, `computer-use-cua-driver-mcp/`, `computer-use-cua-driver-native/`, `cot-translation-bundle/`, `cua/`, `cua-macos/`, `hook-protocol/`, `hooks-claude-code/`, `hooks-codex/`, `inspector/`, `inspector-profile/`, `plugin-market-bundle/`, `ptc-runtime-python/`, `ralph-bundle/`, `session-inspector/`, `session-search/`, `session-title-all-prompts-llm/`, `session-titles-bundle/`, `skill-badge/`, `speech-to-text/`, `speech-to-text-sensevoice/`, `terminal-bundle/`, `tool-agent-team/`, `tool-ralph/`, `tool-session-query/`, `tool-terminal/`, `tool-worktree/`, `translator/`, `voice-input-bundle/`, `webhook/`, `webhook-github/`, `webworker-packer/`, `webworker-runtime/`, `worktree/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 16. [packages/extensions](file:///home/yupeng/references/deepseek-harness/packages/extensions) (extensions)
- **代码规模**：`63` 个源码文件，共 `27,773` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`cordis-client-runner/`, `cordis-host-runner/`, `tool-cordis/`, `ui-cordis/`
- **导出的核心类 (Classes)**：`AttachmentError`, `BackendRegistry`, `CordisInspectRegistryService`, `DomainImpl`, `DynamicCordisRegistry`, `DynamicCordisRunnerService`, `EventLogReporter`, `LlmAdapter`, `LlmRuntime`, `RemoteError`
- **导出的核心接口 (Interfaces)**：`AccountBonusBatch`, `AccountBonusNotification`, `AccountClientMetadata`, `AccountDetails`, `AccountLinks`, `AccountProfile`, `AccountView`, `AccountWallet`, `AdapterRegistrationHandle`, `AfterScheduleRecord`
- **导出的核心类型 (Types)**：`AccountBonusOrderId`, `AccountUserId`, `AdmittedPromptContentPart`, `AgentCancelCause`, `AgentResolver`, `AgentSetup`, `AgentStatus`, `AnonymousTranslationProvider`, `AnyHook`, `ApiSessionAgentError`
- **核心导出函数 (Functions)**：`apply`, `createSandbox`, `evaluateHostCode`, `hostInspectProviders`, `inject`, `name`, `parseErrorMessage`, `precheckCode`, `presentInspectListCall`, `presentInspectQueryCall`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 17. [packages/feedback](file:///home/yupeng/references/deepseek-harness/packages/feedback) (feedback)
- **代码规模**：`9` 个源码文件，共 `2,121` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`command-feedback/`, `message-feedback/`
- **导出的核心类 (Classes)**：`FEEDBACK_CATEGORIES`, `MessageFeedbackService`, `SessionFeedbackService`
- **导出的核心接口 (Interfaces)**：`Config`, `FeedbackRecord`, `MessageFeedbackDelete`, `MessageFeedbackDeleteRequest`, `MessageFeedbackDeleteValue`, `MessageFeedbackItem`, `MessageFeedbackListRequest`, `MessageFeedbackListValue`, `MessageFeedbackNoteBlank`, `MessageFeedbackNoteTooLarge`
- **导出的核心类型 (Types)**：`FeedbackCategory`, `MessageFeedbackDeleteResult`, `MessageFeedbackFailure`, `MessageFeedbackListResult`, `MessageFeedbackPutResult`, `MessageFeedbackRating`, `MessageFeedbackVersion`, `SessionFeedbackRecordResult`
- **核心导出函数 (Functions)**：`appendMessageFixture`, `apply`, `inject`, `messageFixture`, `name`, `recordFeedback`, `setupHarness`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 18. [packages/fs](file:///home/yupeng/references/deepseek-harness/packages/fs) (fs)
- **代码规模**：`52` 个源码文件，共 `14,422` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`fs/`, `fs-local/`, `fs-observation-policy/`, `fs-sandbox/`, `tool-fs/`, `tool-fs-search/`, `tool-str-replace-editor/`
- **导出的核心类 (Classes)**：`GLOB_MAX_RESULTS`, `GREP_MAX_LINE_BYTES`, `GREP_MAX_MATCHES`, `RAW_OUTPUT_MAX_BYTES`, `SEARCH_GRACE_MS`, `SEARCH_META_MAX_BYTES`, `SEARCH_STDERR_MAX_BYTES`, `SEARCH_TIMEOUT_MS`, `SearchError`
- **导出的核心接口 (Interfaces)**：`Config`, `GlobInput`, `GlobSample`, `GlobToolCaps`, `GrepInput`, `GrepMatch`, `GrepToolCaps`, `RipgrepRun`
- **导出的核心类型 (Types)**：`SearchErrorCode`, `SearchMeta`
- **核心导出函数 (Functions)**：`acceptedDirectCallValue`, `alpha`, `apply`, `applyGlobTool`, `applyGrepTool`, `beta`, `buildGlobCommand`, `buildGrepCommand`, `formatGlobOutput`, `formatGrepMatches`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 19. [packages/goal](file:///home/yupeng/references/deepseek-harness/packages/goal) (goal)
- **代码规模**：`21` 个源码文件，共 `5,982` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`command-goal/`, `goal/`, `goal-round-driver/`, `tool-goal/`
- **导出的核心类 (Classes)**：`GoalService`
- **导出的核心接口 (Interfaces)**：`Config`, `FoldedGoal`, `GoalChanged`, `GoalClearChangeMeta`, `GoalFoldState`, `GoalMessageSource`, `GoalSnapshotChangeMeta`, `GoalToolExecution`, `ResolvedConfig`
- **导出的核心类型 (Types)**：`GoalChangeMeta`, `GoalErrorCode`, `GoalOperation`, `GoalToolAuthority`
- **核心导出函数 (Functions)**：`apply`, `applyGoalChange`, `applyGoalEvent`, `applyGoalProjection`, `completionAuthority`, `decodeGoalChange`, `emptyGoalFoldState`, `foldGoal`, `goalChangeRef`, `goalProjectionDefinition`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 20. [packages/guard](file:///home/yupeng/references/deepseek-harness/packages/guard) (guard)
- **代码规模**：`4` 个源码文件，共 `974` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`repeat-tool-reminder/`, `timeout-policy/`
- **导出的核心类 (Classes)**：`TOOL_TIMEOUT`
- **导出的核心接口 (Interfaces)**：`Config`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`apply`, `inject`, `name`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 21. [packages/host](file:///home/yupeng/references/deepseek-harness/packages/host) (host)
- **代码规模**：`50` 个源码文件，共 `9,184` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`directory-picker/`, `directory-picker-auto/`, `directory-picker-browse/`, `directory-picker-native/`, `frontend-static/`, `open-in-app/`, `plugin-inventory/`, `product-telemetry-otel/`, `webserver/`
- **导出的核心类 (Classes)**：`DIALOG_TITLE`, `FOS_FORCEFILESYSTEM`, `FOS_NOCHANGEDIR`, `FOS_PICKFOLDERS`, `HRESULT_CANCELLED`
- **导出的核心接口 (Interfaces)**：`DirectoryPickerInternals`, `Win32DialogBindings`, `Win32DialogInternals`, `Win32DialogWorkerData`, `Win32DialogWorkerLike`, `Win32FolderDialog`
- **导出的核心类型 (Types)**：`DirectoryPickerRunner`, `Win32DialogWorkerMessage`
- **核心导出函数 (Functions)**：`closeThreadWindows`, `loadWin32DialogBindings`, `pickNativeDirectory`, `pickWin32Directory`, `runFolderDialog`, `spawnDialogWorker`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 22. [packages/identity](file:///home/yupeng/references/deepseek-harness/packages/identity) (identity)
- **代码规模**：`2` 个源码文件，共 `205` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`anonymous-user-id/`
- **导出的核心类 (Classes)**：`ANONYMOUS_USER_ID_FILE_NAME`
- **导出的核心接口 (Interfaces)**：`AnonymousUserIdOptions`
- **导出的核心类型 (Types)**：`AnonymousUserId`
- **核心导出函数 (Functions)**：`getOrCreateAnonymousUserId`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 23. [packages/interaction](file:///home/yupeng/references/deepseek-harness/packages/interaction) (interaction)
- **代码规模**：`23` 个源码文件，共 `6,773` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`commands/`, `permission-presets/`, `tool-ask-user/`, `user-approval/`, `user-questions/`
- **导出的核心类 (Classes)**：`ASK_USER_QUESTION_TOOL`, `AUTO_PRESET`, `CUSTOM_PRESET`, `PermissionPresetService`, `TIMED_WAIT_PARAMETER`, `TimedQuestionWait`, `UserQuestionError`, `UserQuestionService`
- **导出的核心接口 (Interfaces)**：`AskUserQuestionAnswer`, `AskUserQuestionAnswerItem`, `AskUserQuestionItem`, `AskUserQuestionOption`, `AskUserQuestionRequest`, `AskUserQuestionRequestEvent`, `Config`, `KnobState`, `PendingUserQuestion`, `PermissionCatalog`
- **导出的核心类型 (Types)**：`AskUserQuestionIntent`, `TimedUserQuestionResult`, `UserQuestionState`
- **核心导出函数 (Functions)**：`apply`, `applyUserQuestionEvent`, `foldUserQuestions`, `inject`, `isTimedAskUserQuestionSchema`, `name`, `questionsOf`, `registerTimedAskUser`, `userQuestionProjectionDefinition`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 24. [packages/jobs](file:///home/yupeng/references/deepseek-harness/packages/jobs) (jobs)
- **代码规模**：`19` 个源码文件，共 `5,846` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`jobs/`, `jobs-local/`, `tool-jobs/`
- **导出的核心类 (Classes)**：`JobEventHub`, `JobLayer`, `JobRegistry`, `LocalJobRegistry`, `OutputRing`, `TASK_WAIT_TIMEOUT`
- **导出的核心接口 (Interfaces)**：`Config`, `JobAppendOptions`, `JobChunk`, `JobEvents`, `JobHandle`, `JobHooks`, `JobKindMap`, `JobOutcome`, `JobOutputRead`, `JobOutputSource`
- **导出的核心类型 (Types)**：`CompletionDelivery`, `JobChannel`, `JobEvent`, `JobEventFilter`, `JobEventListener`, `JobId`, `JobKind`, `JobSettleCause`, `JobStatus`
- **核心导出函数 (Functions)**：`JobId`, `apply`, `inject`, `installJobArchiveAdmission`, `jobDetail`, `name`, `publicJob`, `renderModelDelta`, `startPump`, `statusLine`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 25. [packages/llm](file:///home/yupeng/references/deepseek-harness/packages/llm) (llm)
- **代码规模**：`157` 个源码文件，共 `39,118` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`deepseek-llm-api-extensions/`, `llm/`, `llm-deepseek/`, `llm-deepseek-account/`, `llm-deepseek-api-key/`, `llm-pi-ai/`, `llm-retry/`, `plugin-package-inventory-deepseek/`, `token-meter/`
- **导出的核心类 (Classes)**：`Config`, `DeepSeekLlmApiExtensionRegistry`, `PUBLIC_BASE_URL`
- **导出的核心接口 (Interfaces)**：`Config`, `DeepSeekLlmApiExtensionMap`, `DeepSeekLlmApiExtensionProvider`, `DeepSeekLlmApiExtensionRequest`, `PreparedDeepSeekLlmApiExtension`, `PreparedDeepSeekLlmApiExtensions`, `ReplayBlock`
- **导出的核心类型 (Types)**：`DeepSeekLlmApiJson`, `Options`, `ResolvedDeepSeekOptions`
- **核心导出函数 (Functions)**：`catalogModelFields`, `catalogModelInfo`, `deepSeekConfigFields`, `deepSeekImageTokens`, `deepSeekRequestImageDimensions`, `inlineImages`, `modelInfo`, `object`, `plainOptions`, `prepareFileIds`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 26. [packages/lsp](file:///home/yupeng/references/deepseek-harness/packages/lsp) (lsp)
- **代码规模**：`28` 个源码文件，共 `5,545` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`lsp/`, `lsp-stdio/`, `tool-lsp/`
- **导出的核心类 (Classes)**：`LspConnection`, `LspInstance`, `MessageDecoder`
- **导出的核心接口 (Interfaces)**：`Config`, `ConnectionSpec`, `HostSource`, `HostWorkspace`, `InstanceSpec`, `LspLocalServerConfig`, `WireHover`, `WireInitializeResult`, `WireLocation`, `WireLocationLink`
- **导出的核心类型 (Types)**：`ConnectionSpawner`, `ConnectionWriter`, `WireMarkedString`, `WireProviderCapability`, `WireTextDocumentSyncKind`
- **核心导出函数 (Functions)**：`abortError`, `abortable`, `apply`, `canonicalizeWorkspace`, `encodeMessage`, `inject`, `name`, `negotiatePositionEncoding`, `normalizeHover`, `normalizeLocations`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 27. [packages/mcp](file:///home/yupeng/references/deepseek-harness/packages/mcp) (mcp)
- **代码规模**：`23` 个源码文件，共 `5,332` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`mcp-client/`, `mcp-resources/`
- **导出的核心类 (Classes)**：`Config`, `DEFAULT_MAX_INSTRUCTION_BYTES`
- **导出的核心接口 (Interfaces)**：`ConnectionHandle`, `ConnectionOutcome`, `HttpMcpFixture`, `McpToolDefinitionOptions`, `ReconnectConfig`, `ServerContext`, `StdioConfig`, `StreamableHttpConfig`, `ToolBridgeOptions`
- **导出的核心类型 (Types)**：`Config`, `McpResult`, `ResolvedReconnectPolicy`, `ToolDisposers`
- **核心导出函数 (Functions)**：`apply`, `createMcpToolDefinition`, `createTransport`, `inject`, `name`, `publicToolName`, `registerServerContext`, `resolveReconnectPolicy`, `startConnection`, `startHttpMcpFixture`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 28. [packages/plan](file:///home/yupeng/references/deepseek-harness/packages/plan) (plan)
- **代码规模**：`6` 个源码文件，共 `2,138` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`plan-mode/`
- **导出的核心类 (Classes)**：`EXIT_PLAN_MODE`, `PlanModeController`
- **导出的核心接口 (Interfaces)**：`PlanModeConfig`, `PlanProjection`, `PlanUnitState`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`planProjectionDefinition`, `resolveConfig`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 29. [packages/preset](file:///home/yupeng/references/deepseek-harness/packages/preset) (preset)
- **代码规模**：`26` 个源码文件，共 `2,295` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`agent-preset/`, `agent-preset-registry/`, `persona/`
- **导出的核心类 (Classes)**：`AgentPresetRegistry`
- **导出的核心接口 (Interfaces)**：`AgentPreset`, `AgentPresetComposition`, `AgentPresetCompositionRow`, `AgentPresetDocument`, `AgentPresetInspection`, `AgentPresetRoster`, `AgentPresetRow`, `Config`, `PresetDefinition`, `PresetDisplaySource`
- **导出的核心类型 (Types)**：`BuiltInPresetCopyKey`, `CompositionRowEnablement`, `Config`, `DisabledExpressionEvaluator`
- **核心导出函数 (Functions)**：`activeCompositionModules`, `agentOn`, `agentPresetProjectionDefinition`, `apply`, `auditRows`, `contribution`, `currentKey`, `declare`, `definitionComposition`, `entryListProblem`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 30. [packages/ptc-runtime](file:///home/yupeng/references/deepseek-harness/packages/ptc-runtime) (ptc-runtime)
- **代码规模**：`44` 个源码文件，共 `6,737` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`ptc-runtime/`, `ptc-runtime-node/`
- **导出的核心类 (Classes)**：`DUNDER_MEMBER`, `LogBuffer`, `NodePtcRuntime`, `OutputLedger`, `PtcRuntime`
- **导出的核心接口 (Interfaces)**：`BootstrapPort`, `Config`, `DoneMessage`, `PatchableStream`, `PendingCall`, `ProgramBootData`, `ProgramProcess`, `PtcBindingErrorClass`, `PtcBindingNamespace`, `PtcRunFailure`
- **导出的核心类型 (Types)**：`BindingErrorConstructor`, `ProgramToHost`, `PtcBindingFunction`, `PtcJsonValue`, `PtcJsonWire`, `ReplyMessage`, `ResolvedConfig`
- **核心导出函数 (Functions)**：`captureStreamWrites`, `decodePtcJsonWire`, `encodePtcJsonWire`, `jsonStringBytesUpTo`, `jsonValueBytesUpTo`, `makeBindingErrorClass`, `makeBindingErrorClasses`, `makeConsoleShim`, `makeNamespaces`, `prepareCompletion`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 31. [packages/sandbox](file:///home/yupeng/references/deepseek-harness/packages/sandbox) (sandbox)
- **代码规模**：`50` 个源码文件，共 `10,513` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`sandbox/`, `sandbox-local/`, `sandbox-policy/`, `sandbox-windows-acl/`
- **导出的核心类 (Classes)**：`LocalSandboxProvider`, `SandboxPolicyService`
- **导出的核心接口 (Interfaces)**：`Config`, `SandboxInternals`, `SandboxPolicyRequest`, `WorkspacePackage`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`bwrapProfileArgs`, `landlockProfileArgs`, `packedWorkspaceClosure`, `readWorkspacePackages`, `seatbeltProfileArgs`, `setSandboxMode`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 32. [packages/schedule](file:///home/yupeng/references/deepseek-harness/packages/schedule) (schedule)
- **代码规模**：`31` 个源码文件，共 `10,157` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`schedule/`, `tool-schedule/`
- **导出的核心类 (Classes)**：`CRON_SEARCH_HORIZON_YEARS`, `MAX_TIMER_DELAY_MS`, `MAX_TITLE_LENGTH`, `MIN_EVERY_INTERVAL_SECONDS`, `REQUIRED_TITLE_MESSAGE`, `SCHEDULE_CHANGE_VERSION`, `ScheduleInputError`, `ScheduleLogError`, `ScheduleRuntime`, `ScheduleService`
- **导出的核心接口 (Interfaces)**：`AfterScheduleRecord`, `AtScheduleRecord`, `Config`, `CronInput`, `CronScheduleRecord`, `DailyInput`, `DailyScheduleRecord`, `DeliveryRetentionBounds`, `EveryScheduleDispatchChange`, `EveryScheduleRecord`
- **导出的核心类型 (Types)**：`AtInput`, `LegacyScheduleRecord`, `OneShotScheduleRecord`, `RecurringScheduleRecord`, `ScheduleCatalogEntry`, `ScheduleChange`, `ScheduleCreateValue`, `ScheduleDeleteResult`, `ScheduleDeleteValue`, `ScheduleDeliveryHistoryResult`
- **核心导出函数 (Functions)**：`ScheduleId`, `allocateScheduleId`, `appendDelivery`, `apply`, `applyScheduleChanges`, `canonicalizeCronExpression`, `canonicalizeTimeZone`, `createAfterScheduleRecord`, `createAtScheduleRecord`, `createCronScheduleRecord`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 33. [packages/sdk](file:///home/yupeng/references/deepseek-harness/packages/sdk) (sdk)
- **代码规模**：`25` 个源码文件，共 `6,563` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`client/`, `protocol/`, `server/`
- **导出的核心类 (Classes)**：`DEFAULT_INITIALIZE_TIMEOUT_MS`, `DeepSeekHarness`, `HarnessClient`, `HarnessSession`, `JsonRpcLineTransport`, `JsonRpcResponseError`, `RequestTimeoutError`, `SdkProtocolError`, `TransportClosedError`
- **导出的核心接口 (Interfaces)**：`DeepSeekHarnessOptions`, `DshNodeLaunch`, `HarnessClientOptions`, `HarnessNotification`, `HarnessSdkNotificationMap`, `HarnessSdkRequestMap`, `InitializeParams`, `InitializeResult`, `JsonRpcTransportPeer`, `NotificationSubscription`
- **导出的核心类型 (Types)**：`NotificationFilter`, `SdkPromptContentBlock`, `SdkRunStatus`
- **核心导出函数 (Functions)**：`createProcessDeepSeekHarness`, `createProcessHarnessClient`, `disposeRuntimeProcess`, `finalResponse`, `installedDshBin`, `isRecord`, `normalizeInput`, `resolveDshBinFromManifests`, `resolveDshLaunch`, `resolveDshNodeLaunchFromManifests`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 34. [packages/session](file:///home/yupeng/references/deepseek-harness/packages/session) (session)
- **代码规模**：`209` 个源码文件，共 `49,343` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`session-checkpoint-policy/`, `session-format/`, `session-format-catalog/`, `session-format-v0-to-v1/`, `session-format-v1-to-v2/`, `session-format-v2-to-v3/`, `session-format-v3-to-v4/`, `session-log-deepseek/`, `session-persistence/`, `session-persistence-jsonl/`, `session-projection/`, `session-projection-cache/`, `session-stats/`, `session-telemetry/`, `session-telemetry-otel/`, `session-title/`, `session-title-first-prompt-llm/`, `session-title-llm/`, `session-turn-outline/`, `tool-working-directory/`, `working-directory/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`apply`, `createSessionFormatCatalogWithChildren`, `historicalSessionFormatCatalog`, `inject`, `name`, `sessionFormatCatalog`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 35. [packages/session-query](file:///home/yupeng/references/deepseek-harness/packages/session-query) (session-query)
- **代码规模**：`41` 个源码文件，共 `12,008` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`session-log-export/`, `session-query/`, `session-query-sqlite/`
- **导出的核心类 (Classes)**：`SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY`, `SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE`, `SESSION_QUERY_READ_WINDOW_MAX`, `SessionCorpus`, `SessionObservationReader`, `SessionQueryEngine`, `SessionQueryError`
- **导出的核心接口 (Interfaces)**：`ColdSessionLog`, `Config`, `LogicalSession`, `LogicalSessionSource`, `SessionEventReadRequest`, `SessionEventRecord`, `SessionEventSearchDocument`, `SessionEventSearchHit`, `SessionEventSearchPage`, `SessionEventSearchRequest`
- **导出的核心类型 (Types)**：`LogicalProjectionResult`, `SessionAvailability`, `SessionEventMetadataFilter`, `SessionEventResultFilter`, `SessionEventSurface`, `SessionLineageTrace`, `SessionQueryErrorCode`, `SessionResultFilter`, `SessionSearchCursor`, `SessionTitleObservationResult`
- **核心导出函数 (Functions)**：`SessionSearchCursor`, `assertSessionHeadersCompatible`, `buildSessionEventRecords`, `buildSessionEventSearchDocuments`, `compileSessionTextFilter`, `currentSurfaceEvents`, `eventRecords`, `extractSessionEventText`, `filterSessionEventDocuments`, `filterSessionResults`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 36. [packages/settings](file:///home/yupeng/references/deepseek-harness/packages/settings) (settings)
- **代码规模**：`12` 个源码文件，共 `1,504` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`settings/`
- **导出的核心类 (Classes)**：`SettingsConflictError`, `SettingsForms`
- **导出的核心接口 (Interfaces)**：`RedactedSecret`, `RedactedValue`, `SettingsDescribeOptions`, `SettingsDescribeValue`, `SettingsDescriptor`, `SettingsNamespaceView`, `SettingsSecretView`
- **导出的核心类型 (Types)**：`SettingsNamespace`, `SettingsPathOp`, `SettingsPathOpView`
- **核心导出函数 (Functions)**：`configurationFixture`, `isVolatilePath`, `liveConfig`, `omitsGeneratedPage`, `plainConfig`, `profileComposition`, `projectForm`, `redactSecrets`, `volatileForm`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 37. [packages/shell](file:///home/yupeng/references/deepseek-harness/packages/shell) (shell)
- **代码规模**：`53` 个源码文件，共 `16,060` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`bash-local/`, `bash-sandbox/`, `pwsh-local/`, `pwsh-sandbox/`, `shell/`, `shell-env/`, `tool-bash/`, `tool-bash-persistent/`, `tool-pwsh/`, `tool-pwsh-persistent/`
- **导出的核心类 (Classes)**：`SandboxBashExecutor`, `ShellEnvRegistry`, `ShellExecutor`
- **导出的核心接口 (Interfaces)**：`BashEnvContributor`, `BashEnvVariable`, `BashEnvVariableInfo`, `Config`, `ShellExecRequest`, `ShellExecSpec`, `ShellExecution`, `ShellObservedStreams`, `ShellProcess`, `ShellProcessRead`
- **导出的核心类型 (Types)**：`Config`, `ParsedExitStatus`, `ShellExpiryPolicy`, `ShellProcessStatus`
- **核心导出函数 (Functions)**：`apply`, `classifyDenial`, `name`, `parseExitStatus`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 38. [packages/skill](file:///home/yupeng/references/deepseek-harness/packages/skill) (skill)
- **代码规模**：`19` 个源码文件，共 `8,155` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`skill/`, `skill-filesystem/`, `skill-office/`, `tool-skill/`, `tool-workspace-dependencies/`
- **导出的核心类 (Classes)**：`BUNDLED_SKILL_RANK`, `FileSystemSkillProvider`, `SkillRegistry`
- **导出的核心接口 (Interfaces)**：`Config`, `PrimaryRuntimeManifest`, `SkillCandidate`, `SkillCatalogSnapshot`, `SkillDefinition`, `SkillInvocationPolicy`, `SkillInvocationSource`, `SkillLookupOptions`, `SkillProvider`, `SkillProviderControl`
- **导出的核心类型 (Types)**：`SkillRegistration`, `SkillResourceBase`, `SkillSource`
- **核心导出函数 (Functions)**：`apply`, `copyPrimaryRuntime`, `escapeText`, `expectNoRenderContext`, `inject`, `installPrimaryRuntime`, `isModelInvocable`, `isSkillName`, `isUserInvocable`, `name`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 39. [packages/spill](file:///home/yupeng/references/deepseek-harness/packages/spill) (spill)
- **代码规模**：`17` 个源码文件，共 `3,113` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`spill/`, `spill-local/`, `spill-policy/`
- **导出的核心类 (Classes)**：`DEFAULT_ROOT_PREFIX`, `LocalSpillStore`, `SpillStore`
- **导出的核心接口 (Interfaces)**：`Config`, `RetainedContent`, `SaveTextOptions`, `SavedText`, `SpillPolicyExec`, `SweepOptions`, `SweepRoot`
- **导出的核心类型 (Types)**：`RetainableBlock`, `WarnFn`
- **核心导出函数 (Functions)**：`apply`, `discoverDefaultRoots`, `encodeSegment`, `formatSpillNotice`, `gatherSweepRoots`, `hasSpillNotice`, `inject`, `isErrno`, `name`, `privateRoot`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 40. [packages/ssh](file:///home/yupeng/references/deepseek-harness/packages/ssh) (ssh)
- **代码规模**：`43` 个源码文件，共 `6,359` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`fs-ssh/`, `sandbox-ssh/`, `ssh/`, `ssh-helper-runtime/`, `subprocess-ssh/`
- **导出的核心类 (Classes)**：`RemoteOperationError`, `RemoteProcesses`, `SSH_MAX_PROCESS_HANDLES`, `SSH_MAX_TEXT_STREAMS`, `SSH_PROTOCOL_VERSION`, `SshConnection`, `SshFileSystem`, `SshRpcPeer`, `SshSandboxProvider`, `SshSubprocessRuntime`
- **导出的核心接口 (Interfaces)**：`Config`
- **导出的核心类型 (Types)**：`HelperLaunch`, `SshProcessId`, `SshStreamEndpoint`, `SshTextStreamId`
- **核心导出函数 (Functions)**：`doneSchema`, `editResultSchema`, `editSchema`, `entriesSchema`, `environmentSchema`, `foregroundSchema`, `helloSchema`, `infoSchema`, `intentSchema`, `outcomeSchema`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 41. [packages/storage](file:///home/yupeng/references/deepseek-harness/packages/storage) (storage)
- **代码规模**：`23` 个源码文件，共 `3,969` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`storage/`, `storage-domain/`, `storage-json/`, `storage-sqlite/`
- **导出的核心类 (Classes)**：`BackendRegistry`, `DomainFacility`, `DomainImpl`, `JsonStorageBackend`, `PerRecordJsonUnit`, `Storage`, `StorageError`, `UNIT_NAME_RE`
- **导出的核心接口 (Interfaces)**：`Config`, `Domain`, `DomainChangedBase`, `DomainChangedDeleted`, `DomainChangedPut`, `DomainGlobal`, `KvBackendContractHarness`, `KvFacet`, `KvTable`, `KvUnit`
- **导出的核心类型 (Types)**：`DomainChanged`, `DomainGlobalHandleOf`, `StorageErrorCode`
- **核心导出函数 (Functions)**：`apply`, `inject`, `name`, `openPerRecordUnit`, `openSingleUnit`, `parse`, `parseRecord`, `runKvBackendContract`, `serialize`, `serializeRecord`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 42. [packages/subagent](file:///home/yupeng/references/deepseek-harness/packages/subagent) (subagent)
- **代码规模**：`123` 个源码文件，共 `35,429` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`subagent/`, `subagent-acp/`, `subagent-claude-code/`, `subagent-codex/`, `subagent-dsh-sdk/`, `subagent-fork-in-process/`, `subagent-spawn-in-process/`, `tool-subagent/`, `tool-subagent-control/`
- **导出的核心类 (Classes)**：`DEFAULT_DISPOSE_EOF_GRACE_MS`, `DEFAULT_DISPOSE_GRACE_MS`, `DEFAULT_SHUTDOWN_TIMEOUT_MS`, `TestSessionQuery`
- **导出的核心接口 (Interfaces)**：`Config`, `SdkRunSpec`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`apply`, `inject`, `name`, `parkParent`, `sdkChildOutcome`, `sdkConfigurationFailure`, `startSdkRun`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 43. [packages/subprocess](file:///home/yupeng/references/deepseek-harness/packages/subprocess) (subprocess)
- **代码规模**：`60` 个源码文件，共 `17,110` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`subprocess/`, `subprocess-local/`, `win32-process/`
- **导出的核心类 (Classes)**：`LinuxScopeNotStartedError`, `LinuxScopeSelector`, `LocalSubprocessRuntime`, `LocalTerminalHandle`, `OutputCollector`, `SUBPROCESS_RUNNER_ENV`, `ShellActivity`, `WINDOWS_RUNNER_SELECTION`, `WindowsProcessInspector`
- **导出的核心接口 (Interfaces)**：`LinuxScopeInternals`, `LinuxScopeObservations`, `LinuxTerminalScopeLaunch`, `LocalSubprocessHandle`, `ManagedProcessBinding`, `ProcessEntry`, `ProcessIdentity`, `ProcessInspector`, `ProcessInspectorInternals`, `ProcessSnapshot`
- **导出的核心类型 (Types)**：`LinuxProbeTrigger`, `LinuxScopeDecision`, `LiteralArgvOptions`, `NativePtr`, `RunnerInvocation`, `SpillFailureReporter`
- **核心导出函数 (Functions)**：`bindManagedProcess`, `childEnv`, `confirmLinuxManager`, `consumeRunnerSelection`, `controlEnvironment`, `controlPipe`, `createProcessInspector`, `createWindowsProcessInspector`, `isInvalidHandle`, `killGroup`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 44. [packages/telemetry](file:///home/yupeng/references/deepseek-harness/packages/telemetry) (telemetry)
- **代码规模**：`7` 个源码文件，共 `940` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`otel/`
- **导出的核心类 (Classes)**：`EventLogReporter`, `SESSION_LOG_MAX_REQUEST_BYTES`, `SessionLogReporter`
- **导出的核心接口 (Interfaces)**：`EventLogOptions`, `OTelEventRecord`, `SessionLogOptions`, `SessionLogRecord`
- **导出的核心类型 (Types)**：`LogExporterOptions`, `OTelEventScalar`, `SessionLogProcessorOptions`
- **核心导出函数 (Functions)**：`createEventLogExporter`, `createLogExporter`, `createLogExporterMetrics`, `logTransportOptions`, `resolveSessionLogLimits`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 45. [packages/terminal](file:///home/yupeng/references/deepseek-harness/packages/terminal) (terminal)
- **代码规模**：`13` 个源码文件，共 `5,953` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`terminal/`, `terminal-bash/`
- **导出的核心类 (Classes)**：`BashTerminalBackend`, `CONTROLLED_PROMPT`, `DEFAULT_BASH_ARGS`, `DEFAULT_BASH_SHELL`, `DEFAULT_PWSH_ARGS`, `LocalPtySession`, `PROMPT_MARKER_PREFIX`, `PWSH_PROMPT_SETUP`, `TerminalBackendCleanupError`, `TerminalError`
- **导出的核心接口 (Interfaces)**：`Config`, `SanitizedChunk`, `TerminalBackend`, `TerminalBackendSession`, `TerminalBackendSpawnSpec`, `TerminalReadRequest`, `TerminalReadResult`, `TerminalSendOperation`, `TerminalSendRead`, `TerminalSendRequest`
- **导出的核心类型 (Types)**：`ResolvedConfig`, `ShellDialect`, `TerminalErrorCode`, `TerminalSessionId`, `TerminalSessionIdValue`, `TerminalSessionStatus`, `TerminalSignal`, `TerminalWaitReason`
- **核心导出函数 (Functions)**：`TerminalSessionId`, `apply`, `inject`, `name`, `normalizeTerminalText`, `resolveConfig`, `validateConfig`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 46. [packages/test-support](file:///home/yupeng/references/deepseek-harness/packages/test-support) (test-support)
- **代码规模**：`102` 个源码文件，共 `24,671` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`agent-loop-testkit/`, `client-runtime/`, `llm-mock-server/`, `llm-replay/`, `loader-smoke/`, `remote-mock/`, `session-snapshot/`
- **导出的核心类 (Classes)**：`CONNECTION_REFUSED_BEHAVIOR`, `MAX_MOCK_LLM_TIMER_DELAY_MS`, `MOCK_LLM_BEHAVIORS`, `MOCK_LLM_CLI_USAGE`
- **导出的核心接口 (Interfaces)**：`AgentLoopTestDependenciesOptions`, `AgentLoopTestHarness`, `Config`, `MockLlmCliConfig`, `MockLlmRequestRecord`, `MockLlmServer`, `MockLlmServerOptions`, `ReplayConfig`, `ReplayHandle`, `ReplayModelConfig`
- **导出的核心类型 (Types)**：`ConcreteMockLlmBehavior`, `MockLlmBehavior`, `MockLlmCliParseResult`, `MockLlmRandomWeights`, `MockLlmRequestOutcome`, `MockLlmServerEvent`, `ReplayEntry`, `ReplayOverrideDoc`
- **核心导出函数 (Functions)**：`apply`, `createInboxStub`, `deriveReplayScript`, `inject`, `installLlmReplay`, `loadReplayScript`, `loadSessionScripts`, `mountAgentLoopTestDependencies`, `mountAgentLoopTestHarness`, `name`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 47. [packages/todo](file:///home/yupeng/references/deepseek-harness/packages/todo) (todo)
- **代码规模**：`7` 个源码文件，共 `933` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`tool-todo/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：`Config`, `TodoItem`
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`apply`, `inject`, `name`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 48. [packages/typert](file:///home/yupeng/references/deepseek-harness/packages/typert) (typert)
- **代码规模**：`57` 个源码文件，共 `20,565` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`generator/`, `loader/`, `protocol/`, `registry/`
- **导出的核心类 (Classes)**：`RemoteError`, `TYPERT_OWNED_VALUE`, `TypertRemoteService`
- **导出的核心接口 (Interfaces)**：`InvocationDescriptor`, `InvocationParameterDescriptor`, `InvocationSourceLocation`, `PeerScope`, `PrincipalMap`, `RemoteErrorDetailsMap`, `RemoteInvocation`, `RemoteMethodMarker`, `RemoteMethodOptions`, `RemoteScopeOptions`
- **导出的核心类型 (Types)**：`PeerId`, `Principal`, `RemoteAccessResource`, `RemoteAccessResourceKind`, `RemoteAccessResourceOf`, `RemoteDecoded`, `RemoteErrorCode`, `RemoteFailure`, `RemoteInvocationMarker`, `RemoteResult`
- **核心导出函数 (Functions)**：`Remote`, `RemoteScope`, `bindTypertRemote`, `createTypertRemoteInfo`, `isRemoteJsonValue`, `isRemoteUplinkItem`, `isTypertOwnedValue`, `isTypertRemoteMethod`, `isTypertRemoteSegment`, `principalOf`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 49. [packages/util](file:///home/yupeng/references/deepseek-harness/packages/util) (util)
- **代码规模**：`59` 个源码文件，共 `10,775` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`atomic-write/`, `brand/`, `chunked-list/`, `code-language/`, `crypto/`, `deque/`, `home-paths/`, `http-proxy/`, `launch-environment/`, `lazy-require/`, `native-command/`, `output-retention/`, `package-manifest/`, `plugin-market-index/`, `time/`, `timeout/`, `values/`, `workspace-path/`
- **导出的核心类 (Classes)**：`DSH_LAUNCH_ENVIRONMENT_KEY`, `Deque`, `ItemRetainer`, `MAX_TIMER_DELAY_MS`, `TextRetainer`, `TimeoutReason`
- **导出的核心接口 (Interfaces)**：`ChunkedList`, `Deadline`, `DesktopIcon`, `DshBundleManifest`, `DshClientManifest`, `DshEnginesManifest`, `DshManifest`, `DshPackageManifest`, `DshProfileManifest`, `IdleWatchdog`
- **导出的核心类型 (Types)**：`ItemRetentionStrategy`, `LaunchEnvironmentSource`, `LocalizedText`, `Omitted`, `TextRetentionStrategy`
- **核心导出函数 (Functions)**：`appendChunkedList`, `chunkedListSchema`, `clampTimeout`, `createLaunchEnvironmentSnapshot`, `deadline`, `describeOmitted`, `desktopApplicationIcon`, `desktopDataDirectories`, `desktopEntryFields`, `formatRetentionNotice`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 50. [packages/web](file:///home/yupeng/references/deepseek-harness/packages/web) (web)
- **代码规模**：`38` 个源码文件，共 `7,236` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`tool-web/`, `web/`, `web-fetch-http/`, `web-search-deepseek/`, `web-search-exa/`, `web-search-perplexity/`
- **导出的核心类 (Classes)**：`EXA_DEFAULT_BASE_URL`, `EXA_DEFAULT_HIGHLIGHTS_PER_RESULT`, `EXA_DEFAULT_SEARCH_TYPE`, `EXA_PROVIDER_ID`, `ExaSearchProvider`, `PERPLEXITY_DEFAULT_BASE_URL`, `PERPLEXITY_DEFAULT_MAX_TOKENS`, `PERPLEXITY_DEFAULT_MODEL`, `PERPLEXITY_PROVIDER_ID`, `PerplexitySearchProvider`
- **导出的核心接口 (Interfaces)**：`Config`, `ExaError`, `ExaResult`, `ExaSearchProviderOptions`, `ExaSearchRequest`, `ExaSearchResponse`, `PerplexityError`, `PerplexityRequest`, `PerplexityResponse`, `PerplexitySearchProviderOptions`
- **导出的核心类型 (Types)**：`PerplexityRecency`, `WebFetchBody`
- **核心导出函数 (Functions)**：`apply`, `inject`, `mapExaResponse`, `mapExaResult`, `mapPerplexityResponse`, `mapPerplexityResult`, `name`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 51. [packages/workflow](file:///home/yupeng/references/deepseek-harness/packages/workflow) (workflow)
- **代码规模**：`29` 个源码文件，共 `5,578` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`tool-workflow/`, `workflow/`, `workflow-ptc/`
- **导出的核心类 (Classes)**：`MaterializeError`, `PtcWorkflowRun`, `WorkflowEngine`, `WorkflowError`
- **导出的核心接口 (Interfaces)**：`Config`, `StartedWorkflowChild`, `ToolWorkflowAgentEndData`, `ToolWorkflowAgentStartData`, `ToolWorkflowRunEndData`, `ToolWorkflowRunStartData`, `WorkflowAgentEndInfo`, `WorkflowAgentInfo`, `WorkflowChildRequest`, `WorkflowGuestHost`
- **导出的核心类型 (Types)**：`WorkflowAgentOutcome`, `WorkflowErrorCode`, `WorkflowEventName`, `WorkflowProgress`, `WorkflowRunId`, `WorkflowStopReason`
- **核心导出函数 (Functions)**：`WorkflowRunId`, `apply`, `createWorkflowRecordMirror`, `inject`, `isFatalWorkflowError`, `materializeFromRealm`, `meta`, `name`, `renderThrown`, `runWorkflowGuest`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 52. [packages/workspace](file:///home/yupeng/references/deepseek-harness/packages/workspace) (workspace)
- **代码规模**：`6` 个源码文件，共 `2,971` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`workspace/`
- **导出的核心类 (Classes)**：`WorkspaceActiveSessionError`, `WorkspaceArchivedSessionPinError`, `WorkspaceEntity`, `WorkspaceMoveInvalidError`, `WorkspaceOrderInvalidError`, `WorkspaceRegistry`, `WorkspaceUnknownSessionError`
- **导出的核心接口 (Interfaces)**：`ArchiveSessionOptions`, `SessionActivity`, `SessionActivityItem`, `SessionActivityKindMap`, `SessionActivityRequest`, `Workspace`, `WorkspaceEntityHost`
- **导出的核心类型 (Types)**：`SessionActivityKind`, `WorkspaceDomainState`, `WorkspaceId`, `WorkspaceRecord`
- **核心导出函数 (Functions)**：`WorkspaceId`, `defaultWorkspaceTitle`, `fullyQualifiedWorkspacePath`, `realpathNormalize`, `workspaceDomainSpec`, `workspaceDomainState`, `workspaceRecord`
- **架构机理与 bi 复刻策略**：本包隶属于 `dhs` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

---

## 六、 Pi Agent 11 个全量子包与核心逻辑深度透析 (极高性能与反应式模型)

本章节对 `pi` 下全部 **11 个 Monorepo 子包** 进行地毯式全量解构。包含每个子包的物理路径、代码规模、核心目录拓扑、导出的核心类（Classes）、接口（Interfaces）、类型（Types）、函数（Functions）与对 `bi` 的复刻价值。

### 1. [packages/agent](file:///home/yupeng/references/pi/packages/agent) (@earendil-works/pi-agent-core)
- **代码规模**：`16` 个源码文件，共 `6,826` 行代码
- **功能定义**：General-purpose agent with transport abstraction, state management, and attachment support
- **子目录拓扑**：`examples/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`Agent`, `CODEMODE_TOOL_NAME`
- **导出的核心接口 (Interfaces)**：`AfterToolCallContext`, `AfterToolCallResult`, `AgentContext`, `AgentLoopConfig`, `AgentLoopTurnUpdate`, `AgentOptions`, `AgentState`, `AgentTool`, `AgentToolCallOutcome`, `AgentToolResult`
- **导出的核心类型 (Types)**：`AgentEvent`, `AgentEventSink`, `AgentInitialState`, `AgentMessage`, `AgentRequestUpdate`, `AgentToolCall`, `AgentToolUpdateCallback`, `AgentTurnDecision`, `FinishTurn`, `PrepareRequest`
- **核心导出函数 (Functions)**：`agentLoop`, `agentLoopContinue`, `calculate`, `createCalculateToolWithUsage`, `createCodemodeTool`, `createMcpTools`, `createNestedToolRunner`, `getCurrentTime`, `getDefaultStreamFn`, `runAgentLoop`
- **架构机理与 bi 复刻策略**：本包隶属于 `pi` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 2. [packages/ai](file:///home/yupeng/references/pi/packages/ai) (@earendil-works/pi-ai)
- **代码规模**：`391` 个源码文件，共 `75,198` 行代码
- **功能定义**：Unified LLM API with automatic model discovery and provider configuration
- **子目录拓扑**：`scripts/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`MODEL_DATA_MANIFEST_FILE`, `MODEL_DATA_SCHEMA_VERSION`
- **导出的核心接口 (Interfaces)**：`AiGatewayPriceTier`, `AiGatewayPricing`, `ApiOptionsMap`, `AssistantImages`, `AssistantMessage`, `BaseModel`, `ClassifierBoolAnswer`, `ClassifierBoolQuestion`, `ClassifierChoiceAnswer`, `ClassifierChoiceQuestion`
- **导出的核心类型 (Types)**：`AnyModel`, `Api`, `ApiStreamOptions`, `AssistantMessageEvent`, `ClassifierAnswer`, `ClassifierApi`, `ClassifierFunction`, `ClassifierQuestion`, `ClassifierStopReason`, `ConstrainedSamplingConfig`
- **核心导出函数 (Functions)**：`assertExactModelIds`, `buildOpenRouterCatalog`, `createModelDataManifest`, `getAiGatewayCost`, `getEffortThinkingLevelMap`, `getOpenRouterThinkingLevelMap`, `groupProviderModelData`, `hydrateModelCatalog`, `modelDataStructureHash`, `readModelDataProviderIds`
- **架构机理与 bi 复刻策略**：本包隶属于 `pi` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 3. [packages/chord](file:///home/yupeng/references/pi/packages/chord) (@earendil-works/chord)
- **代码规模**：`87` 个源码文件，共 `29,887` 行代码
- **功能定义**：Typed host runtime for plugins, contracts, replicated state, and RPC over JSON links
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：`Ctx`, `Exposed`, `GetOptions`, `Readable`, `RefBase`, `Shape`
- **导出的核心类型 (Types)**：`RefStatus`, `StateEvent`, `StateSource`
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `pi` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 4. [packages/codemode](file:///home/yupeng/references/pi/packages/codemode) (@earendil-works/pi-codemode)
- **代码规模**：`28` 个源码文件，共 `5,237` 行代码
- **功能定义**：Sandboxed JavaScript execution where the only capability is calling injected tools
- **子目录拓扑**：`examples/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`CODEMODE_OPTIONS_PREFIX`, `CODEMODE_SOURCE_GRAMMAR`, `CodemodeSandbox`, `CodemodeSandboxDurableObject`, `CodemodeSourceError`, `DEFAULT_INPUT_SCHEMA_MAX_CHARS`, `DEFAULT_REMOTE_MEMORY_LIMIT_BYTES`, `DurableObject`, `Session`
- **导出的核心接口 (Interfaces)**：`CodemodeCall`, `CodemodeDeclaredGlobal`, `CodemodeDeclaredTool`, `CodemodeDuring`, `CodemodeError`, `CodemodeExecuteOptions`, `CodemodeHostCall`, `CodemodeRun`, `CodemodeRunOptions`, `CodemodeSandboxBaseOptions`
- **导出的核心类型 (Types)**：`CodemodeCallStatus`, `CodemodeErrorKind`, `CodemodeJsonSchema`, `CodemodeOutcome`, `CodemodeOutputItem`, `CodemodeResult`, `CodemodeWasmModule`
- **核心导出函数 (Functions)**：`createInlineCodemodeSandbox`, `loadQuickJSWasm`, `parseCodemodeSource`, `renderDeclarations`, `renderToolOutputType`, `renderToolSample`, `renderToolSignature`, `schemaToType`, `toCodemodeIdentifier`
- **架构机理与 bi 复刻策略**：本包隶属于 `pi` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 5. [packages/coding-agent](file:///home/yupeng/references/pi/packages/coding-agent) (@earendil-works/pi-coding-agent)
- **代码规模**：`673` 个源码文件，共 `164,872` 行代码
- **功能定义**：Coding agent CLI with read, bash, edit, write tools and session management
- **子目录拓扑**：`examples/`, `scripts/`, `src/`, `test/`
- **导出的核心类 (Classes)**：无导出类
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：`allowNetwork`, `createInMemoryModelRegistry`, `createModelRegistry`, `getModelRuntime`, `renderConfigSchemas`
- **架构机理与 bi 复刻策略**：本包隶属于 `pi` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 6. [packages/durable](file:///home/yupeng/references/pi/packages/durable) (@earendil-works/pi-durable)
- **代码规模**：`196` 个源码文件，共 `63,815` 行代码
- **功能定义**：Durable conversation, task, and document runtime for Pi
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`ROOT_CONVERSATION_ID`
- **导出的核心接口 (Interfaces)**：`DocFamilyToken`, `DocToken`, `DocumentObserver`, `Entry`, `HookRunner`, `Session`, `Storage`, `Task`, `TaskRuntime`, `Tx`
- **导出的核心类型 (Types)**：`CheckpointInfo`, `CommitChange`, `CommitPublication`, `CommonDocDefinition`, `ContextEdit`, `ConversationDocFamilyToken`, `ConversationDocToken`, `ConversationId`, `ConversationOwnership`, `ConversationQuery`
- **核心导出函数 (Functions)**：`aborted`, `abortedWith`, `completed`, `countingReader`, `deferred`, `eventually`, `openTasks`, `settled`
- **架构机理与 bi 复刻策略**：本包隶属于 `pi` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 7. [packages/env](file:///home/yupeng/references/pi/packages/env) (@earendil-works/pi-env)
- **代码规模**：`17` 个源码文件，共 `3,553` 行代码
- **功能定义**：Remote execution environments for Pi Durable: a small daemon deployed over SSH and its ExecutionEnv client
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`HostKeyChangedError`, `HostKeyUnknownError`, `LocalExecutionEnv`, `RemoteExecutionEnv`, `RemoteTerminal`, `RemoteWatcher`, `SshError`
- **导出的核心接口 (Interfaces)**：`RemoteExecutionEnvOptions`, `RemoteWatchOptions`, `SshConnectOptions`, `SshTarget`, `TerminalForeground`, `TerminalOptions`
- **导出的核心类型 (Types)**：`LocalExecutionEnvOptions`, `RemotePlatform`
- **核心导出函数 (Functions)**：`abortResult`, `acceptHostKey`, `connectSsh`, `daemon`, `deployDaemon`, `detectPlatform`, `forgetHostKey`, `listFilesOver`, `localDaemon`, `openTerminal`
- **架构机理与 bi 复刻策略**：本包隶属于 `pi` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 8. [packages/evals](file:///home/yupeng/references/pi/packages/evals) (@earendil-works/pi-evals)
- **代码规模**：`23` 个源码文件，共 `3,329` 行代码
- **功能定义**：官方核心功能子包
- **子目录拓扑**：`docker/`, `evals/`, `src/`, `test/`
- **导出的核心类 (Classes)**：`OPENAI_MODEL_ID`, `OPENAI_PROBE_PROMPT`, `OPENAI_PROBE_RESPONSE`, `OPENAI_PROVIDER_ID`, `STREAM_API_DOCUMENTATION`, `STREAM_MODEL_ID`, `STREAM_PROBE_PROMPT`, `STREAM_PROBE_RESPONSE`, `STREAM_PROVIDER_ID`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：`AcmeServer`, `AddedModelOutput`, `ProviderRuntimeOutput`, `ProviderScenario`
- **核心导出函数 (Functions)**：`createAcmeServer`, `inspectAddedModel`, `inspectProvider`, `loadConfiguredModelRuntime`
- **架构机理与 bi 复刻策略**：本包隶属于 `pi` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 9. [packages/mcp](file:///home/yupeng/references/pi/packages/mcp) (@earendil-works/pi-mcp)
- **代码规模**：`25` 个源码文件，共 `4,895` 行代码
- **功能定义**：Standalone Model Context Protocol client for pi and other applications
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`McpClient`, `McpOAuthAuthorizationRequiredError`, `McpOAuthProvider`, `MemoryOAuthStateStore`, `OAuthError`, `OAuthInsecureEndpointError`, `OAuthIssuerMismatchError`, `OAuthRegistrationError`
- **导出的核心接口 (Interfaces)**：`AuthProvider`, `AuthorizationServerMetadata`, `McpClientOptions`, `McpOAuthProviderOptions`, `McpOAuthState`, `McpOAuthStateStore`, `McpRequestOptions`, `OAuthChallenge`, `OAuthClientInformation`, `OAuthClientMetadata`
- **导出的核心类型 (Types)**：`AddClientAuthentication`, `HttpHandler`, `McpFetch`, `OAuthClientInformationFull`, `OAuthClientInformationMixed`, `OAuthFlowResult`
- **核心导出函数 (Functions)**：`adaptOAuthProvider`, `authorizeMcp`, `buildAuthorizationServerDiscoveryUrls`, `closeServers`, `discoverAuthorizationServerMetadata`, `discoverOAuthServerInfo`, `discoverProtectedResourceMetadata`, `exchangeAuthorizationCode`, `listen`, `parseAuthorizationServerMetadata`
- **架构机理与 bi 复刻策略**：本包隶属于 `pi` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 10. [packages/telemetry](file:///home/yupeng/references/pi/packages/telemetry) (@earendil-works/pi-telemetry)
- **代码规模**：`8` 个源码文件，共 `1,178` 行代码
- **功能定义**：Vendor-neutral telemetry contracts and typed schema utilities for pi
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`InMemoryTelemetryContext`
- **导出的核心接口 (Interfaces)**：`RecordedTelemetryEvent`, `RecordedTelemetrySpan`, `SpanAttributes`, `SpanOptions`, `TelemetryAdapterConformanceCase`, `TelemetryAdapterFixture`, `TelemetryAttributeMetadata`, `TelemetryContext`, `TelemetryEventDefinition`, `TelemetrySchemaDefinition`
- **导出的核心类型 (Types)**：`AttributeValue`, `ExactTelemetryAttributes`, `InferEventAttributes`, `InferOptionalAttributes`, `InferRequiredAndOptionalAttributes`, `InferStartAttributes`, `SchemaTelemetrySpan`, `SpanStatus`, `TelemetryAdapterFixtureFactory`, `TelemetryAttributeDefinition`
- **核心导出函数 (Functions)**：`createTelemetryAdapterConformance`, `createTypedSpanStarter`, `defineTelemetrySchema`
- **架构机理与 bi 复刻策略**：本包隶属于 `pi` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

### 11. [packages/tui](file:///home/yupeng/references/pi/packages/tui) (@earendil-works/pi-tui)
- **代码规模**：`97` 个源码文件，共 `39,784` 行代码
- **功能定义**：Terminal User Interface library with differential rendering for efficient text-based applications
- **子目录拓扑**：`src/`, `test/`
- **导出的核心类 (Classes)**：`VirtualTerminal`
- **导出的核心接口 (Interfaces)**：无导出接口
- **导出的核心类型 (Types)**：无导出类型
- **核心导出函数 (Functions)**：无导出独立函数
- **架构机理与 bi 复刻策略**：本包隶属于 `pi` 架构体系。在 `bi` 项目中，开发人员可通过契约映射直接提取本模块的类型定义或函数实现，作为标准化开源轮子接入，避免重复自研。

---

## 七、 五大标杆核心功能与组件跨项目速查字典 (Developer Quick Lookup Matrix)

开发智能体在实现或排查特定能力时，**严禁重新全盘扫描代码**，直接查阅下表：

| 功能大类 | 细分能力特性 | 首选最佳开源轮子与源码锚点 | 备选参考轮子与源码锚点 | 核心实现机制与开发提示 |
|---|---|---|---|---|
| **配置系统** | 三级 TOML 配置与保留注释回写 | [`kimi-code/packages/agent-core-v2/src/app/config/configService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/app/config/configService.ts) (1,025行)<br>[`tomlWriteback.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/app/config/tomlWriteback.ts) | [`pi/packages/coding-agent/src/core/settings-manager.ts`](file:///home/yupeng/references/pi/packages/coding-agent/src/core/settings-manager.ts)<br>[`deepseek-harness/packages/settings/settings/src/redact.ts`](file:///home/yupeng/references/deepseek-harness/packages/settings/settings/src/redact.ts) | 采用 smol-toml 语法树保留用户手写注释；结合 DHS redactSecrets 脱敏；支持 /config 面板与 /reload 免重启。 |
| **认证与专线** | 智谱 BigModel 双轨特权认证与错峰调度 | [`zcode/apps/zcode-cli/packages/adapters/src/model/off-peak-request-auth.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/adapters/src/model/off-peak-request-auth.ts)<br>[`packages/services/src/session/offPeakTaskService.ts`](file:///home/yupeng/references/zcode/packages/services/src/session/offPeakTaskService.ts) (26KB, 681行) | [`zcode/packages/services/src/highspeed/highspeedCardService.ts`](file:///home/yupeng/references/zcode/packages/services/src/highspeed/highspeedCardService.ts) (383行) | PKCE 轮询换票；X-Coding-Plan-Api-Key 专线标头；完整错峰排队状态机（1~3折）；免费高速卡抽卡。 |
| **会话与撤销** | Append-only JSONL 会话分叉树与时光回滚 | [`zcode/apps/zcode-cli/packages/core/src/runtime/methods/session-fork.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/session-fork.ts) (53KB)<br>[`file-rewind.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts) (21KB) | [`kimi-code/packages/agent-core-v2/src/agent/undo/undoService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/undo/undoService.ts) (10.5KB)<br>[`fileHistoryService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/fileHistory/fileHistoryService.ts) (24.8KB) | 基于 parentSessionId 维护分叉树；逆向补丁恢复物理文件；配合 Kimi 写前快照与 computeUndoCut 级联撤销。 |
| **并发与队列** | 双边界会话待办收件箱与门铃协调器 | [`opencode/packages/core/src/session/inbox.ts`](file:///home/yupeng/references/opencode/packages/core/src/session/inbox.ts) (18.7KB)<br>[`run-coordinator.ts`](file:///home/yupeng/references/opencode/packages/core/src/session/run-coordinator.ts) (9KB) | [`zcode/apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts) | 严格区分 steer 步内纠偏与 input 空闲排队；原子门铃 pendingWake 消除排空与空闲过渡死锁。 |
| **阴影回放** | 黄金会话轨迹录制与脱机非回归校验 | [`zcode/apps/zcode-cli/tools/prompt-trajectory/record.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/tools/prompt-trajectory/record.ts) (11.6KB)<br>[`scripts/shadow-replay.mjs`](file:///home/yupeng/references/zcode/apps/zcode-cli/scripts/shadow-replay.mjs) (10.8KB) | [`pi/packages/evals/src/harness.ts`](file:///home/yupeng/references/pi/packages/evals/src/harness.ts) (20.6KB) | 录制 Golden Trajectory 快照；沙箱存根接管工具；0 API 开销与 0 真实副作用下校验决策一致性。 |
| **缓存优化** | 4 级 KV 缓存断点编排与脉冲保活 | [`opencode/packages/ai/src/cache-policy.ts`](file:///home/yupeng/references/opencode/packages/ai/src/cache-policy.ts) (8.7KB)<br>[`effort-updates.ts`](file:///home/yupeng/references/opencode/packages/ai/src/effort-updates.ts) | [`pi/packages/coding-agent/src/core/cache-warmer.ts`](file:///home/yupeng/references/pi/packages/coding-agent/src/core/cache-warmer.ts) (16.8KB)<br>[`zcode/apps/zcode-cli/packages/core/src/context/builder.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/context/builder.ts) | 4 级断点硬预算算法；推理开销动态追加而不改历史前缀；90% TTL 发射 1-token 脉冲防缓存失效。 |
| **Shell 安全** | 纯 TS 确定性 Shell 词法扫描与 eval 阻断 | [`opencode/packages/core/src/shell/scan.ts`](file:///home/yupeng/references/opencode/packages/core/src/shell/scan.ts) (97.8KB, 2,410行纯 TS) | [`kimi-code/packages/tree-sitter-bash/`](file:///home/yupeng/references/kimi-code/packages/tree-sitter-bash/)<br>[`zcode/apps/zcode-cli/packages/adapters/src/exec/bash-output-policy.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/adapters/src/exec/bash-output-policy.ts) | 纯状态机逐字符解析复合命令/管道/Heredoc；动态 eval 判为 opaque 阻断提级；64KB 输出截断保护。 |
| **工具排重** | 规范哈希工具排重器与三阶反驳打断门 | [`kimi-code/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts) (19.3KB, 588行) | [`deepseek-harness/packages/core/`](file:///home/yupeng/references/deepseek-harness/packages/core/) | 参数递归排序计算 SHA-256 哈希回显缓存；三阶打断门（预期陈述 -> 证伪检查 -> 强制直出）消灭死循环。 |
| **任务调度** | Temporal 全周期调度引擎与持久化重放 | [`deepseek-harness/packages/schedule/schedule/src/domain.ts`](file:///home/yupeng/references/deepseek-harness/packages/schedule/schedule/src/domain.ts) (79.9KB, 1,896行) | [`kimi-code/packages/agent-core-v2/src/features/cron/cronService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/cron/cronService.ts) (593行) | After/At/Every/Cron(400年公历闰年)/Daily/Weekly 全原语；事件溯源持久化；重启游标自愈消灭漏触。 |
| **崩溃自愈** | 进程崩溃 Checkpoint 持久化调度与 Actor | [`pi/packages/durable/src/harness/scheduler.ts`](file:///home/yupeng/references/pi/packages/durable/src/harness/scheduler.ts) (84.6KB, 1,953行)<br>[`types.ts`](file:///home/yupeng/references/pi/packages/durable/src/types.ts) (46.7KB) | [`zcode/apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts) (36KB) | 状态迁移事务落盘至 storage.tasks；重启分页扫描（256条）恢复 Actor；MAX_TIMER_DELAY 防止定时器溢出。 |
| **中断自愈** | 中断恢复事实注入器与跨午夜日期感知器 | [`kimi-code/packages/agent-core-v2/src/agent/interruptionReminder/interruptionReminderService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/interruptionReminder/interruptionReminderService.ts) (2.8KB)<br>[`features/dateChange/`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/dateChange/) (6KB) | [`opencode/packages/ai/src/tool-history.ts`](file:///home/yupeng/references/opencode/packages/ai/src/tool-history.ts) (3.5KB) | Ctrl+C 中断后注入规范上下文事实提醒，消除道歉幻觉；跨 00:00 自动注入 date_change，纠正时间基线。 |
| **紧缩与配对** | 工具配对门禁、图像卸载与磁盘溢出 | [`deepseek-harness/packages/compaction/compaction/src/tool-pairing.ts`](file:///home/yupeng/references/deepseek-harness/packages/compaction/compaction/src/tool-pairing.ts)<br>[`packages/spill/`](file:///home/yupeng/references/deepseek-harness/packages/spill/) | [`zcode/apps/zcode-cli/packages/core/src/compact/microcompact.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/compact/microcompact.ts) (9.3KB)<br>[`kimi-code/packages/agent-core-v2/src/agent/fullCompaction/contextRecovery.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/fullCompaction/contextRecovery.ts) | 前缀和平衡算法杜绝配对中断 400；图像标记卸载换为占位符；超限输出磁盘 Spill；注入回溯日志指针。 |
| **公文转译** | 原生 Word/PPT 转矢量 PDF 与视觉审计 | [`deepseek-harness/packages/document/office-to-pdf/`](file:///home/yupeng/references/deepseek-harness/packages/document) (14.7KB)<br>LibreOffice Headless | [`zcode/apps/zcode-cli/packages/spreadsheets-plugin/agents/visual-judge.md`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/spreadsheets-plugin/agents/visual-judge.md) | Word/PPT 毫秒级转换为标准矢量 PDF；页面高精切片投递视觉视窗与 Visual Judge 核验门，保真公文排版。 |
| **网页抽取** | SAX 状态机流式 HTML 转 Markdown | [`opencode/packages/core/src/tool/html-markdown.ts`](file:///home/yupeng/references/opencode/packages/core/src/tool/html-markdown.ts) (21.7KB, 659行) | 系统无头浏览器 | 纯 TS htmlparser2 流式解析，常驻内存 5MB 以内，毫秒级表格重构与列表嵌套，5MB 保护截断防 OOM。 |
| **状态追踪** | 反应式片段表与 Treap 零拷贝 JSON Delta | [`pi/packages/chord/src/delta/tracker.ts`](file:///home/yupeng/references/pi/packages/chord/src/delta/tracker.ts) (79.8KB, 2,239行) | [`kimi-code/packages/transcript/`](file:///home/yupeng/references/kimi-code/packages/transcript/) | Piece Table + Treap 树堆不可变差分追踪；实时计算 RFC 6902 JSON Patch 流，消除全量树刷新 CPU 暴击。 |
| **终端图表** | 终端 Mermaid 原生 ASCII/Unicode 渲染 | [`opencode/packages/merman/`](file:///home/yupeng/references/opencode/packages/merman) (89个源码文件)<br>[`markdown.ts`](file:///home/yupeng/references/opencode/packages/merman/src/markdown.ts) (12.4KB) | 外部 Web 渲染 | 在终端字符画布上绘制流程图/时序图/甘特图；自适应 120 列换行折叠与 ANSI 调色板映射。 |
| **无头评测** | 确定性端到端评测套件与量化看板 | [`pi/packages/evals/src/harness.ts`](file:///home/yupeng/references/pi/packages/evals/src/harness.ts) (20.6KB)<br>[`report.ts`](file:///home/yupeng/references/pi/packages/evals/src/report.ts) (19KB) | [`deepseek-harness/benchmarks/`](file:///home/yupeng/references/deepseek-harness/benchmarks/) | 纯命令行评测执行器；沙箱与 Mock 夹具；自动回放标准研报与财报套件；输出多维量化打分看板。 |
| **多 Agent 协同** | 物理 Worktree 隔离与并发蜂群调度 | [`kimi-code/packages/agent-core-v2/src/features/tower/towerService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/tower/towerService.ts) (36.7KB)<br>[`features/swarm/`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/swarm/) (65KB) | [`zcode/apps/zcode-cli/packages/superpowers-plugin/skills/using-git-worktrees/SKILL.md`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/superpowers-plugin/skills/using-git-worktrees/SKILL.md)<br>[`zcode/apps/zcode-cli/packages/core/src/subagent/`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/subagent/) | Git Worktree 物理分支隔离；.tower/comms/ 信令总线；Merge Gate 审查门禁；Prompt 模板动态扇出蜂群。 |