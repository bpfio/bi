# bi

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**bi** 是一个用 Bun + TypeScript 构建的终端 CLI Agent（monorepo）。它不是任何现有 Agent
CLI 的 fork：产品代码全部在本仓库逐卡新写，设计上以「五标杆技术大典 + 双基线」方法吸收
既有经验——功能与架构基线取 zcode，CLI/TUI 壳层与装配序基线取 kimi code CLI，其余标杆
仅作工程参考（见 [`devplan.md`](./devplan.md) 与
[`docs/FIVE_AGENTS_FULL_SPECTRUM_ANALYSIS.md`](./docs/FIVE_AGENTS_FULL_SPECTRUM_ANALYSIS.md)）。

> 身份说明：本仓库 git 历史承自早期的 zcode-cli fork，现产品树（bi）为独立重写，
> 不回跟任何参考树上游（RULE-BI-08）。GitHub 侧的 fork 关联标记由仓库所有者另行脱离。

## 当前状态

- **16 个子命令全部真实接线**（init / session / fork / export / transfer / acp / upgrade /
  doctor / vis / config / copy / query / worktree / dag / a2a / plugins），经 `bin/bi.ts` →
  `runBi` 查表派发到真实处理器；未知子命令结构化 exit 2，「器官缺位」场景结构化上报、
  绝不假冒成功。
- **两种会话形态**：带 `--prompt` 走无头会话（JSONL 事件流上屏，`--output-format
  stream-json`）；无参裸跑进交互 REPL（配置装配 → 凭据门 → 真实驱动 → AgentTuiSession）。
- **配置体系**：三级 TOML（`~/.bi/config.toml` → `~/.bi/tui.toml` → 项目级
  `.bi/local.toml`）+ 环境变量覆盖；`providers.entries.*.api_key_env` 间接引用密钥，
  配置文件永不落明文。
- **质量门**：`bun test` 全绿（BI_PTY_E2E=1 全量：270 个测试文件 / 4858 个用例 0 失败，
  含 pty 真人面回归），三包 `tsc --noEmit`（core/tui/a2a）0 错误。

## 快速上手

### 1. 安装依赖

```bash
bun install
```

### 2. 初始化工作区

```bash
bun bin/bi.ts init
```

产物两件（已存在均不覆盖，幂等）：

- `.bi/local.toml` —— 工作区私有配置模板（`.bi/` 已列入 `.gitignore`，不入版本库）；
- `BI.md` —— 项目长期记忆草稿（`detectStack` 探测技术栈自动填写，**待人工审查后生效**；
  未检测到受支持栈清单时出具「未检测到」草稿并结构化提示，不假冒检测结果）。
  开启 `[memory] inject_enabled` 后，`BI.md` 与 `BI.dream.md` 会在会话启动时一并注入
  system 面（`BI.md` 段在前，两文件内容相同时只注一次）。

### 3. 配置 provider（`~/.bi/config.toml`）

配置走三级 TOML 拓扑，优先级从低到高：

| 层 | 路径 | 用途 |
| --- | --- | --- |
| 全局运行 | `~/.bi/config.toml` | provider / model / 权限等运行时行为 |
| 终端外观 | `~/.bi/tui.toml` | 主题、键位等外观偏好 |
| 工作区私有 | `<项目>/.bi/local.toml` | additional_dir、模型覆盖等私有项 |

密钥**只经环境变量间接引用**（`api_key_env`），配置文件永不落明文。最小可跑配置
（anthropic 协议；openai 协议把 `kind` 换为 `"openai"` 即可）：

```toml
[providers.entries.my_provider]
api_key_env = "MY_PROVIDER_API_KEY"      # 从该环境变量读密钥；空串 = 无静态 Key
base_url = "https://api.example.com"     # 空串 = 该协议官方默认端点
kind = "anthropic"                       # openai | anthropic | google
models = ["my-model"]                    # 模型名提示列表

[providers.entries.my_provider.extra_headers]
# 附加请求头（可选）：原样合并进该 provider 每次 wire 请求，同键覆盖缺省头。
# 特例 "auto"：x-opencode-session 每会话自动生成稳定 UUID（opencode Go 网关要求）。
"x-opencode-session" = "auto"

[providers]
default = "my_provider"

[models]
default = "main"

[models.entries.main]
provider = "my_provider"
model = "my-model"
```

验证配置装载（五项体检：配置装载 / 凭据门 / 所配 provider 网络 / 沙箱探针 / 工具注册面）：

```bash
bun bin/bi.ts doctor
```

也可以按键查询生效值（`get` / `set` / `list`，共 73 键，见下文「配置参考」）：

```bash
bun bin/bi.ts config get models.default
```

### 4. 首单跑通

无头形态（`--prompt`，stdout 为 JSONL 事件流，末帧 `session_done` 带 `finalText`）：

```bash
MY_PROVIDER_API_KEY=sk-... bun bin/bi.ts --prompt "用一句话介绍你自己"
```

模型回合上限缺省 16（调研型任务不够）：CLI `--max-rounds <n>` 临时调高，或写进配置的
`[session] max_rounds`（0 = 用缺省 16，调研型任务建议 16-32）。回合打尽时的输出契约：
stream-json 形态落末帧 `session_done`（`exit="rounds-exceeded"`），`--output-format json`
形态 stdout 落一个完整 JSON 对象（`exit="rounds-exceeded"`、`reply` 空串），两者退出码均非零。

交互形态（无参进 REPL；`Ctrl+D` 或空草稿 `Ctrl+C` 退出）：

```bash
bun bin/bi.ts
```

续会话（REPL 形态）：`bun bin/bi.ts --resume <sessionId>` 复用既有会话——会话 id 连续
（JSONL 续写同一份会话文件）、既有历史注入模型上下文；会话不存在 → 结构化报错
`[session-not-found]`，退出码 2（不静默开新会话）。

## 子命令一览

与 `bun bin/bi.ts --help` 的真实文本一致（16 个，按 help 输出顺序）：

| 子命令 | 职责 |
| --- | --- |
| `init` | 脚手架 `.bi/local.toml` 工作区模板 + `BI.md` 草稿（已存在不覆盖） |
| `session` | 列举本地会话（JSONL 行逐条输出元数据，最新在前） |
| `fork` | 从指定节点分叉会话（`bi fork <sessionId> <nodeId>`） |
| `export` | 导出会话为 markdown / json / html（`--out` 落盘，缺省直出） |
| `transfer` | 会话脱敏导出 / 归档导入（`bi transfer export --sanitize <id>` / `bi transfer import <archive.json>`） |
| `acp` | stdio 会话桥接（initialize / session/new / session/prompt / session/end，v1 面） |
| `upgrade` | 自升级真链（manifest 下载 → sha256 门 → 原子换装；`--check` 只比对不换装） |
| `doctor` | 五项全链路体检，按发现项定退出码（全过 0，有异常 1） |
| `vis` | 本地 Web 会话可视化（缺省绑 `127.0.0.1` + 随机端口，只读 API；非回环强制 `BI_VIS_AUTH_TOKEN`） |
| `config` | 全局配置键值面（`get` / `set` / `list`，键面由 schema 默认树推导） |
| `copy` | 复制会话字段到剪贴板（`id` / `title` / `last-reply`；剪贴板工具缺失降级 stdout） |
| `query` | 检索本地会话语料（`bi query "type=user"`，重建索引后按过滤表达式输出 JSON 行） |
| `worktree` | Git worktree 并发沙箱：`create` / `list` / `merge` / `discard`（`bi worktree create --task <id> [--base <ref>]`；`merge --task <id> [--message <msg>]`、`discard --task <id>`；工作树落 `<repo>/.bi/worktrees`） |
| `dag` | DAG 工作流调度：`bi dag run <spec.json> [--workflow-id <id>]`，`WorkflowSpec` 分层并行执行，已注册 `shell` 步骤 handler |
| `a2a` | A2A 服务暴露：`bi a2a host [--listen <ip:port>]`，读 config `[a2a]` 装配 host 并前台运行（`enabled=false` → exit 4；非回环绑定强制 `BI_A2A_TOKEN`） |
| `plugins` | 插件声明面：`bi plugins [list\|validate] [--dir <目录>]`，缺省扫 `~/.bi/plugins` 与 `./.bi/plugins`（零代码执行，`install`/`marketplace` 本波不做） |

统一退出码语义：`0` 成功 / `1` 运行期失败 / `2` 用法错误 / `3` 装配凭据类（无头与
REPL 同一面）/ `4` 已识别但能力未配置（如 `upgrade` 无 manifest 源、`a2a` 的
`[a2a] enabled=false`、`vis` 的 `[vis] enabled=false`）。

## 配置参考

键面以 `bun bin/bi.ts config list` 实测为准（共 73 键 = 47 根键 + 26 挂载分区键，
按分组；复杂表/实体数组如
`providers.entries` / `models.entries` / `permission.rules` / `hooks.entries` 不进
get/set 键面，直接写 TOML）：

| 分组 | 键 |
| --- | --- |
| `a2a` | `a2a.allow`、`a2a.enabled`、`a2a.listen` |
| `hooks` | `hooks.enabled`、`hooks.entries` |
| `identity` | `identity.extra_instructions`（追加为系统指令末条；空串 = 不追加）、`identity.name`（TUI 横幅产品名；未声明 = 用缺省产品名）、`identity.system_prompt_path`（自定义系统提示词文件；CLI `--agent-file` 优先，文件缺失 → 结构化告警并回退内置）、`identity.tagline`（TUI 横幅副题行；空串 = 不出副题） |
| `image` | `image.allowed_types`、`image.max_size_mb` |
| `loop_control` | `loop_control.max_iterations`（会话回合上限通用层；`0` = 不生效，回退内建缺省）、`loop_control.max_tool_calls_per_turn`（单回合工具调用上限，超限调用不执行并回填结构化拒绝；`0` = 不限）、`loop_control.step_timeout_ms`（工具限时看门狗缺省时限；`0` = 关闭看门狗）、`loop_control.turn_timeout_ms`（单回合总时限；`0` = 不限，超时 → 失败码 `turn-timeout`） |
| `models` | `models.default` |
| `permission` | `permission.mode`、`permission.rules` |
| `providers` | `providers.default` |
| `read` | `read.ignore`、`read.max_file_size_kb`、`read.max_output_chars` |
| `secondary_model` | `secondary_model.background`、`secondary_model.subagent`、`secondary_model.summarize` |
| `telemetry` | `telemetry.enabled`、`telemetry.sanitize_errors` |
| `thinking` | `thinking.budget_tokens`、`thinking.effort`、`thinking.enabled` |
| `tools` | `tools.allow`、`tools.code_mode`、`tools.deny`、`tools.output_limit_bytes`、`tools.media`、`tools.job_tools`、`tools.lsp`（需宿主 LSP 装配；本版本未提供 → `lsp_navigate` 不挂载并告警）、`tools.select_tools` |
| `tui` | `tui.mouse_mode`、`tui.notifications`、`tui.show_thoughts`、`tui.theme` |
| `watch` | `watch.debounce_ms`、`watch.enabled`、`watch.ignore` |
| `workspace` | `workspace.additional_dir`、`workspace.respect_gitignore` |

挂载分区的标量子键已进 get/set 键面（共 26 个）：`verify.on_completion` / `verify.checks` / `verify.deliverables` / `verify.objective`；
`subagent.enabled` / `subagent.max_iterations` / `subagent.timeout_ms` / `subagent.default_profile` / `subagent.btw_enabled`；
`ptc.enabled` / `ptc.timeout_ms` / `ptc.max_tool_calls`；`cron.enabled`；
`context.time_context` / `context.date_change_sensor` / `context.tool_result_prune` / `context.max_history_entries` / `context.timezone` / `context.image_offload` / `context.auto_compactor`；
`memory.dream_enabled` / `memory.inject_enabled`；
`session.max_rounds`；
`vis.enabled` / `vis.listen` / `vis.token_env`。

### 挂载式分区（config-gated，缺省关）

以下分区采用挂载式拓扑：**未显式声明时恒不物化**（缺省路径逐字节等价），显式声明
`[分区]` 后才生效，子键经 backfill 补默认。子键虽可经 `bi config get/set` 读写
（get 读到的是 schema 缺省，不改变"未物化"事实；set 写入即显式声明），

| 分区 | 门与作用 |
| --- | --- |
| `[verify]` | 完工自验看门狗（`deliverable` / `command` 检查条目 + `on_completion` 开关） |
| `[subagent]` | `enabled` = 注册 `spawn_subagent` 模型工具；`btw_enabled` = `/btw` 旁路问答 |
| `[ptc]` | `enabled` = 注册 PTC 脚本工具 `run_ptc_script`（`timeout_ms` / `max_tool_calls` 为执行边界） |
| `[cron]` | `enabled` = 注册会话内 cron 三件套（`cron_schedule` / `cron_list` / `cron_remove`；登记/巡检/注销真实生效，调度核走 workflow 解析核）；**到点自动触发尚未接线**（不会自动执行任何动作），归后续卡 |
| `[context]` | 上下文引擎：`time_context` / `date_change_sensor` / `tool_result_prune` / `max_history_entries` / `timezone` / `image_offload`（BI-08.2 渐进图像卸载）/ `auto_compactor`（BI-10 token 水位紧缩） |
| `[memory]` | 记忆面：`dream_enabled`（收尾沉淀到 `<cwd>/BI.dream.md`）/ `inject_enabled`（启动注入 `<cwd>/BI.md` 项目记忆 + `<cwd>/BI.dream.md` 沉淀） |
| `[session]` | 无头会话回合上限：`max_rounds`（缺省 0 = 用内建缺省 16；调研型任务建议 16-32；CLI `--max-rounds` 优先级更高） |
| `[vis]` | 本地会话可视化（`bi vis`）配置面：`enabled`（声明后须 `true` 才启动，否则结构化拒绝 exit 4；未声明 `[vis]` 时不受影响）/ `listen`（缺省监听 `"ip:port"`，CLI `--host`/`--port` 优先）/ `token_env`（令牌环境变量名，缺省空 = 用内建 `BI_VIS_AUTH_TOKEN`） |
| `[mcp]` | `servers.<id>`（`command`/`args`/`env`/`enabled`）= stdio MCP server 装配（工具以 `mcp__<id>__<tool>` 命名入工具面；`servers` 非空即挂载，与 `[ptc]` 无关；坏条目结构化警告不阻塞；SSE 型暂未支持） |

（`[mcp]` 一行按便利列在上表内；实为根分区，缺省恒物化为 `servers = {}`，不属挂载拓扑。）

### `[loop_control]` 分区（Agent 主循环控制）

`[loop_control]` 是根分区（恒物化），四个键约束 Agent 主循环的边界：

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `loop_control.max_iterations` | `0` | 会话回合上限**通用层**（低于 `[session]` 专项）；`0` = 不生效，回退内建缺省 |
| `loop_control.max_tool_calls_per_turn` | `80` | 单回合工具调用上限；超限调用**不执行**，回填结构化拒绝（`loop-control: 单轮工具调用超过上限 N`）回喂模型；`0` = 不限 |
| `loop_control.step_timeout_ms` | `120000` | 工具限时看门狗的缺省时限（未知工具的看门狗上限）；`0` = 关闭看门狗 |
| `loop_control.turn_timeout_ms` | `0` | 单回合总时限；`0` = 不限；超时 → 中止在飞工具 + 结构化失败面（`exit="turn-timeout"`）+ stderr 提示，退出码非零 |

回合上限生效值按四层优先级链取第一个命中者（`0` / 负数 / 未声明视为不命中）：

```
CLI --max-rounds > deps 透传 maxRounds > [session].max_rounds > [loop_control].max_iterations > 内建缺省
```

子代理（`spawn_subagent`）循环**不走**本分区：子代理自带 `max_iterations` /
`timeout_ms` 语义（见 `[subagent]`），与主会话互不干涉。

### `[identity]` 分区（助手身份）

`[identity]` 是根分区（恒物化），四个键分属两条互不重叠的消费面：

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `identity.name` | `bi` | TUI 横幅产品名；未显式声明 = 横幅零变化（沿用现状单行提示） |
| `identity.tagline` | `""` | TUI 横幅副题行；空串 = 不出副题 |
| `identity.system_prompt_path` | `""` | 无头会话系统指令前缀（读该文件内容）；CLI `--agent-file` **优先**，两者不叠加；文件缺失/不可读 → stderr 结构化告警并回退内置，不炸会话 |
| `identity.extra_instructions` | `""` | 追加为系统指令末条；空串 = 不追加 |

系统指令装配顺序（钉死）：CLI `--agent-file`（未给时才用 `system_prompt_path`）
→ 内建段（项目记忆 `BI.md` / 时钟块）→ `extra_instructions`。

### `[a2a]` 分区（`bi a2a host` 装配面）

`[a2a]` 是根分区（恒物化），三个键驱动 `bi a2a host`：

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `a2a.enabled` | `false` | 能力总闸；`false` → 结构化 exit 4（能力未配置） |
| `a2a.listen` | `127.0.0.1:0` | 监听 `ip:port`（`port 0` = 内核随机）；`--listen` 旗标可覆盖 |
| `a2a.allow` | `[]` | 对端角色白名单（`coordinator`/`scout`/`auditor`/`reporter`），透传为宿主 `allowFrom`；空 = 宿主缺省全角色 |

共享密钥走环境变量 `BI_A2A_TOKEN`（不进 TOML 键面）：回环绑定缺省用进程内一次性随机
密钥；非回环绑定（含 `0.0.0.0`/`::` 通配）缺该变量即拒绝启动，不裸奔暴露。
`BI_A2A_TOKEN` 非空时，HTTP 探活面**所有路由**都要带令牌（`?t=<token>` 或
`Authorization: Bearer <token>`），否则回 401 `{"error":"unauthorized"}`；令牌为空
（回环便利态）时维持免校验探活。

### `[vis]` 分区（`bi vis` 配置面）

`[vis]` 是挂载式分区（未声明不物化，`bi vis` 缺省行为零变化），三个键驱动 `bi vis`：

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `vis.enabled` | `false` | 声明 `[vis]` 后的启停闸；`false` → 结构化 exit 4（能力未配置）；未声明 `[vis]` 时不读该键（`bi vis` 照常可用） |
| `vis.listen` | `127.0.0.1:0` | 缺省监听 `ip:port`（`port 0` = 内核随机）；CLI `--host` / `--port` 旗标优先于 config |
| `vis.token_env` | `""` | 令牌环境变量名（非回环绑定的令牌门读哪个 env）；空 = 用内建 `BI_VIS_AUTH_TOKEN`（既有兼容） |

### 接线面一览

以下能力既有库态器官、也已接上 CLI/工具面（原「库态备案」清单已转可调用）：

| 面 | 入口 | 说明 |
| --- | --- | --- |
| worktree | `bi worktree create\|list\|merge\|discard` | Git worktree 并发沙箱引擎；工作树落 `<repo>/.bi/worktrees`；`merge` 冲突如实报 `conflict: true` 并回滚现场交人工审查（exit 1），`discard` 幂等 |
| workflow·DAG | `bi dag run <spec.json> [--workflow-id <id>]` | `WorkflowSpec`（`steps[].id/run/depends_on/params`）分层并行调度；已注册 `shell` 步骤 handler（`params.command` 经 `sh -c` 执行，单步 30s 超时） |
| a2a | `bi a2a host [--listen <ip:port>]` | 由 config `[a2a]` 装配 host 并前台运行（`enabled` 门控，false → exit 4）；回环绑定缺省一次性随机密钥，**非回环绑定强制 `BI_A2A_TOKEN`**（缺失即拒绝启动）；令牌非空时 HTTP 探活面全路由校验令牌（否则 401） |
| plugins | `bi plugins [list\|validate] [--dir <目录>]` | 双协议插件声明加载器（只解析清单、零代码执行）；缺省扫 `~/.bi/plugins` 与 `./.bi/plugins`，`--dir` 覆盖扫描根；加载失败逐条警告不阻塞 |
| CodeMode | 模型工具 `run_js` | `node:vm` 纯计算沙箱（禁网络/禁 fs/禁工具注入），由 config `[tools] code_mode` 显式 `true` 才挂载，缺省工具面零变动 |

诚实边界：`bi dag` 的调度 store 只在单次进程生命周期内有效（缺省内存底座）；`bi plugins`
不执行插件代码、`install`/`marketplace` 本波不做；`run_js` 只能算、不能碰 IO（工具编排归
PTC `run_ptc_script`）。`@bi/a2a` 的邮件信令 / GitHub 中枢 / WS 中继 / 黑板面仍只在库内，
CLI 面仅 `bi a2a host`。

### 环境变量覆盖

优先级高于所有 TOML 层、低于 CLI 旗标：`BI_PROVIDER`、`BI_MODEL`、
`BI_SECONDARY_MODEL`、`BI_BACKGROUND_MODEL`、`BI_THINKING_EFFORT`、
`BI_PERMISSION_MODE`、`BI_TOOLS_ALLOW`、`BI_TOOLS_DENY`、`BI_IDENTITY_NAME`、
`BI_WORKSPACE_ADDITIONAL_DIR`。

另有一枚密钥类环境变量（不经 TOML 键面）：`BI_A2A_TOKEN` —— `bi a2a host` 的共享
密钥来源；回环绑定缺省用进程内一次性随机密钥，非回环绑定缺它即拒绝启动
（对齐 `BI_VIS_AUTH_TOKEN` 的 `bi vis` 先例）。

## 开发

```bash
bun install          # 安装依赖
bun test             # 全部测试
bun run typecheck    # 双 tsconfig 类型门
bun run build:bin    # 单文件二进制构建
```

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `packages/core` | 会话（JSONL）、AgentLoop 状态机、权限门、hooks、config、headless 驱动 |
| `packages/tui` | 终端界面（REPL 主路径 / 候选菜单 / 键位注册表） |
| `packages/{mcp,a2a,plugins,workflow,worktree}` | 子命令器官包（worktree 引擎 / DAG 引擎 / A2A host + CodeMode 沙箱 / 插件加载器 / MCP stdio 客户端），各由对应 `bi <子命令>` 或工具面消费 |
| `bin/bi.ts` | 可执行入口 shim（无参 = REPL；带参 = runBi 分发） |
| `scripts/build-bin.ts` | Bun Compile 单文件二进制构建（`--embed` 资产嵌入预留） |
| `devplan.md` | 开发计划唯一事实源（SSOT） |
| `DEVLOG.md` | 排障手记与验收台账导出 |

## 文档

- [`devplan.md`](./devplan.md) — 117 卡开发计划（SSOT）
- [`DEVLOG.md`](./DEVLOG.md) — 排障手记与验收记录
- [`docs/RESEARCH.md`](./docs/RESEARCH.md) — 架构全景调研与设计蓝图
- [`docs/FIVE_AGENTS_FULL_SPECTRUM_ANALYSIS.md`](./docs/FIVE_AGENTS_FULL_SPECTRUM_ANALYSIS.md) — 五标杆技术大典
- [`docs/E2E_DRILL_REPORT.md`](./docs/E2E_DRILL_REPORT.md) — 终局验收矩阵演练报告
- [`docs/UPSTREAM_ANCHORS.md`](./docs/UPSTREAM_ANCHORS.md) — 上游锚点基线（不回跟追踪）

## License

bi 原生代码以 MIT 发布（见 [LICENSE](./LICENSE)）。
[`LICENSES/`](./LICENSES/README.md) 保留继承自上游 ZCode 的 Apache-2.0 授权文本与
第三方声明，作为仓库历史继承内容的归属记录。
