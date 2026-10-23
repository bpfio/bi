# ISO-0 产出：C1 隔离层施工面定稿（现读复核 + 接线设计 + 文件红线）

主控自查单（zcode），2026-10-21，基线 3bed2bd。只读现读 + 设计，零代码改动。
结论先行：**GAP-1 过期项已刷新，OsSandbox/shell-scan 阻断/PathJail-bash 三件均确证「有器官、零接线」，卡面有效；ISO-1 与 ISO-2 接缝清晰可开工；ISO-3 存在路线重审点（静态分析 vs 内核强制），开工前需定案。**

## 1. OsSandbox 能力面现读（os-sandbox.ts，587 行）

| 能力 | 现读结论 |
|---|---|
| `probe()` :380 | 结构化探测三后端：landlock（真实内核探针，VERSION 优先 + ABI 掩码二分实创，:405-436）/ bwrap（PATH + `--ro-bind / / /bin/true` 功能探针 :438-448，覆盖 userns 被禁内核）/ seatbelt（darwin + sandbox-exec 存在性 :450-456）。verdict 含 `available/preferred/backends[]`，绝不静默降级 |
| `runSandboxed(cmd, policy, ctx)` :466 | mode=off 旁路直跑（backend:"none"）；有后端按平台优先级包装执行；全不可用 fail-closed 返回 `kind:"refused"` + 每后端 refusals[]（:479-489）。refused 不执行命令 |
| errorKind 白名单 | `SANDBOX_PROBE_ERROR_KINDS` :64-71（唯一事实源，6 值：wrong-platform/binary-missing/kernel-unsupported/userns-unsupported/ffi-unavailable/workspace-root-missing） |
| 可测试性 | `OsSandboxDeps` :331-343 全注入（platform/env/spawn/bwrapBinary/...），397 行测试全替身 |
| landlock 机理 | 自重执行：`bun -e` 跑内嵌 loader（`LANDLOCK_LOADER_SRC` :227），env 协议 BI_SANDBOX_LL_PROFILE/BI_SANDBOX_LL_PAYLOAD；信号以 128+n 回传；局限声明在案（非 x86_64 探针失真、二进制输出不保真） |

**接线现状：零**。toolset.ts:43-44 注释明文「os-sandbox …属重量级运行时装配（probe + 平台后端选择），本卡不接线」。全仓消费方仅测试。

配套 `sandbox-policy.ts`（248 行）完备：`SandboxMode = "off" | "readonly" | "workspace-write"`，三后端 profile 生成器（landlockProfileArgs/bwrapProfile/seatbeltProfile）齐备，ISO-1 无需动它。

## 2. 权限门 manual/auto 语义现读（permission-gate.ts，292 行）

三层决策矩阵（顺序钉死）：**会话记忆 → 静态规则 → 三态默认**（check :261-288）。

- `manual` → `ask`（未显式授权均询问）
- `yolo` → `allow`
- `auto` → `allow` + `reasonedDefault:true`（审计标记，与规则命中放行可区分）
- 权威源裁定：`gate.mode` 唯一，请求透传的 mode 不参与决策（防模型侧私盖 "yolo" 自我提权，类注释 :22-25）
- 会话记忆键 = `tool + 归一化 argSummary`（normalizeArgSummary :81，相等归一化非 glob）

**消费点现读（关键接缝）**：
- headless.ts:568 `assembledExecutor`：`gate.check({tool, argSummary, mode: gate.mode})`；deny → throw permission-denied；**ask → headless 无审批 UI，结构化拒绝 `permission-ask-unavailable-in-headless` 回喂模型**（BI-23.2 ask 回路）
- bin/bi.ts:118：config `[permission]` mode/rules 建门禁单实例；PermissionSessionController 喂 /permissions 命令面（BI-28.3）
- 工具绑定层（toolset.ts）**不感知 gate**——argSummary 只做审计标注源（含 shell-scan 标签）

## 3. shell-scan reason code 清单现读（shell-scan.ts，2443 行）

`scanShell(input)` 纯函数（零 IO/零时钟/零随机），三段分析：词法 → 语句分解（pipeline/复合命令/heredoc/重定向全矩阵）→ 三级评分 `safe | opaque | dangerous`。**fail-closed**：预算超限（256KB/50k token/64 层）或不认识的构造整条评 opaque，绝不猜。

REASONS 稳定清单（:147-167，19 个）：

- 预算/解析类：`budget-exceeded`、`unsupported-construct`、`unterminated-construct`
- dynamic-execution:* （8 个，全评 opaque）：`eval`、`source`、`expansion-command-word`、`command-substitution-command-word`、`shell-c-dynamic-script`、`heredoc-expansion`、`command-substitution-content`、`unparseable-input`
- dangerous:* （8 个）：`rm-recursive-force-root`、`chmod-777-root`、`mkfs`、`dd-block-device`、`redirect-block-device`、`power-control`、`pipe-to-shell`、`credential-path`

**现消费点**：仅 bashArgSummary 标注（toolset.ts:698-713）——`[shell-scan:dangerous+opaque]` 后缀进审批浮层可见，**execute 不消费 scan 结果，不阻断**（toolset.ts:38-40 注释明文「不阻断执行，manual 态 ask 由门禁出」）。此即 ISO-2 施工面。

## 4. bash 执行路径与 PathJail 现状

- bash 工具：`bashBinding`（toolset.ts:661）→ `runBashCommand`（:717）：`spawn(["bash","-c",command])`，cwd=root，缺省超时 60s（timeout_ms 可调），尾部 100KB，exitCode 非 0 不抛错。spawn 经 `spawnImpl` 注入面（:139，缺省真实 Bun.spawn，测试全替身）。
- PathJail：已接 edit/write（guardWritePath :407 段级前缀逃逸守卫 + write 裁决）与 glob/grep（read 裁决 + 逐文件复核防凭据外泄 :556）。**bash 不接**——toolset.ts:46-48 注释：PathJail 是路径级器官，bash 是命令词级执行。

## 5. 接线设计（ISO-1/2/3 施工方案）

### ISO-1：OsSandbox 接 bash 执行路径

- **接缝**：`runBashCommand` 的 spawn 处。构造 `SandboxCommand {command:"bash", args:["-c",cmd], cwd:root}`，policy 来自新配置节 `[sandbox] mode = off|readonly|workspace-write`（缺省 off = 现状逐字节等价），ctx = `{home, workspaceRoot: root, tmpDir}`。
- **关键施工难点（现读新识）**：`OsSandbox.runSandboxed` 内部用 **spawnSync**（deps.spawn = spawnSync），而 runBashCommand 走异步 Bun.spawn 流式。两法择一：①给 OsSandboxDeps 加异步 spawn 变体（动 os-sandbox.ts，测试面同步改）；②bash 沙箱轨单独走 spawnSync（超时语义用 timeout 选项复刻，失去流式中途输出——但 bash 工具本就整段返回，无损）。**推荐 ②**：os-sandbox.ts 零改动，runBashCommand 内分叉（沙箱 off → 既有异步路径；≠off → runSandboxed 同步轨）。
- **probe 缓存**：toolset 构造时 probe 一次缓存 verdict（重量级装配的正确位置），拒绝在每次执行重复探针。
- **降级语义（卡面「不可用结构化告警降级」→ 细化定案）**：mode≠off 且 probe 全不可用 → **执行被拒**（fail-closed），工具结果 JSON 返回 `exitCode:null, sandboxRefused:true, refusals[]`——OsSandbox 自身语义即 fail-closed refused，此处定案为「拒执行 + fail-visible 回喂」，不做「带告警继续裸跑」（那会制造安全假象）。这与卡面「不可用结构化告警降级」措辞有张力，**定案：拒绝优于降级，开工时按此实现并在卡面 notes 备案措辞修正**。
- **验收锚**：L2 伪端点断言 refused 路径 + bash spawn 注入面复用 BI-28.1 替身 + 真机 landlock 探针（本机 kernel 7.0.0 已实证 EACCES 语义）。

### ISO-2：shell-scan 升级阻断

- **接缝**：bashBinding.execute 入口。现 shellScanTag 仅标注 → 升级为阻断：`scan.dangerous || scan.opaque` → 不 spawn，返回结构化拒绝（JSON `exitCode:null, shellScanBlocked:true, reasons:[...REASONS]`），模型可见 reason code 清单可自纠。
- **manual 态审批显式放行**：记忆键已天然成立——PermissionGate 会话记忆键 = `tool:"bash" + 归一化 argSummary`，而 argSummary 已含 `[shell-scan:...]` 标签。用户对某命令显式 allow（TUI 审批浮层/记忆）→ 后续同命令放行。**卡面「审批记忆键语义保持」现读确认成立，零额外设计**。
- **阻断层位定案**：放 binding 层（toolset 构造注入 `bashScanBlockade: true` 选项）而非 headless 装配层——TUI/headless 双形态同语义，且 binding 层已有 shellScanTag 就地复用 scanShell 调用。
- **注意**：headless `auto/yolo` 模式下阻断依然生效（安全层独立于权限门模式——dangerous 不因 yolo 而放行，除非显式记忆键）。此为安全底线语义，与 GAP-1 判词「安全层有决策无隔离」的修复方向一致。
- **旧测试转新语义**：toolset.test.ts 断言「标注不阻断」的用例改断言阻断 + 拒绝 JSON 形态。

### ISO-3：PathJail 接 bash 写面 —— **路线重审点，开工前需定案**

现读判断：静态分析 bash 命令词提取写目标不完备（`sh -c` 动态性：变量展开命令词、`$(...)` 重定向目标、source 脚本内写），静态拦截必留旁路。**两条路线**：
- **A（推荐）：写面 jail 走 ISO-1 的 workspace-write 模式**——landlock/bwrap 内核级强制，工作区外写 EACCES，静态分析旁路归零。ISO-3 卡面改为「bash 工作区外写拦截（经沙箱 workspace-write 档）」，L2 断言改为沙箱内 /tmp 外写被拒。PathJail 静态面维持只服务 edit/write/glob/grep（其完备性有保证的域）。
- **B：PathJail 静态接 bash**——从 ScanResult.redirects+命令词提路径过 PathJail 判定，标注 best-effort、动态构造 opaque 拒。代价：语义重叠（与 ISO-2 opaque 拒交叉）、误杀面大（`cp x ~/backup/` 类合法家目录写需逐案白名单）。
- **定案权在用户/开工时**；本设计推荐 A，若采纳则 ISO-3 施工量大幅缩小（复用 ISO-1 成果 + 测试）。

## 6. 文件红线（后续写码单的边界）

| 文件 | ISO-1 | ISO-2 | ISO-3(A) |
|---|---|---|---|
| packages/core/src/cli/toolset.ts（bash 段 :653-805 + 构造选项） | 改 | 改 | 改（仅测试态策略） |
| packages/core/src/sandbox/os-sandbox.ts | **禁改**（方案②） | 禁改 | 禁改 |
| packages/core/src/sandbox/shell-scan.ts | 禁改 | 禁改（REASONS 只消费不扩） | 禁改 |
| packages/core/src/sandbox/sandbox-policy.ts | 禁改 | 禁改 | 禁改 |
| packages/core/src/sandbox/path-jail.ts | 禁改 | 禁改 | 禁改（A 路线下零接触） |
| packages/core/src/guard/permission-gate.ts | 禁改 | 禁改 | 禁改 |
| packages/core/src/cli/headless.ts | 零接触（装配层不感知沙箱） | 零接触 | 零接触 |
| 配置 schema（[sandbox] 节） | 新增 | 零接触 | 零接触 |

ISO-1 与 ISO-2 在 toolset.ts 同文件不同段（构造选项 vs bash execute 入口），**可同波施工但需单内分段提交**；与 ISO-4 收官门禁的文件面交集仅 toolset.ts + 新测试文件。

## 7. 诚实边界

- OsSandbox landlock 在非 x86_64 Linux 探针可能失真（模块头 :25-26 声明局限，探针失败结构化 unavailable 不误报可用）——ISO-4 真机探针只在 x86_64 本机跑，跨架构留 declared。
- seatbelt 路线无 darwin 真机可验，ISO-4 仅 probe 不可用降级路径可测。
- ISO-3 B 路线的静态分析完备性上界未量化（未做旁路穷举），若用户裁定 B 需补设计单。
- 本设计对 spawnSync 方案②的超时/中止语义复刻（AbortSignal → spawnSync timeout 映射）细节留 ISO-1 开工时实现定，现读只确认可行（spawnSync 支持 timeout + killSignal）。
