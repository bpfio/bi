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

- **11 个子命令全部真实接线**（init / session / fork / export / transfer / acp / upgrade /
  doctor / vis / config / copy），经 `bin/bi.ts` → `runBi` 查表派发到真实处理器；
  未知子命令结构化 exit 2，「器官缺位」场景结构化上报、绝不假冒成功。
- **两种会话形态**：带 `--prompt` 走无头会话（JSONL 事件流上屏，`--output-format
  stream-json`）；无参裸跑进交互 REPL（配置装配 → 凭据门 → 真实驱动 → AgentTuiSession）。
- **配置体系**：三级 TOML（`~/.bi/config.toml` → `~/.bi/tui.toml` → 项目级
  `.bi/local.toml`）+ 环境变量覆盖；`providers.entries.*.api_key_env` 间接引用密钥，
  配置文件永不落明文。
- **质量门**：`bun test` 全绿（253 个测试文件 / 4621 个用例：4618 通过、3 跳过、
  0 失败），双 tsconfig `tsc --noEmit` 0 错误。

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

也可以按键查询生效值（`get` / `set` / `list`，共 62 键，见下文「配置参考」）：

```bash
bun bin/bi.ts config get models.default
```

### 4. 首单跑通

无头形态（`--prompt`，stdout 为 JSONL 事件流，末帧 `session_done` 带 `finalText`）：

```bash
MY_PROVIDER_API_KEY=sk-... bun bin/bi.ts --prompt "用一句话介绍你自己"
```

交互形态（无参进 REPL；`Ctrl+D` 或空草稿 `Ctrl+C` 退出）：

```bash
bun bin/bi.ts
```

## 子命令一览

与 `bun bin/bi.ts --help` 的真实文本一致（11 个，按 help 输出顺序）：

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

统一退出码语义：`0` 成功 / `1` 运行期失败 / `2` 用法错误 / `3` 装配凭据类（无头与
REPL 同一面）/ `4` 已识别但能力未配置（如 `upgrade` 无 manifest 源）。

## 配置参考

键面以 `bun bin/bi.ts config list` 实测为准（共 62 键 = 42 根键 + 20 挂载分区键，
按分组；复杂表/实体数组如
`providers.entries` / `models.entries` / `permission.rules` / `hooks.entries` 不进
get/set 键面，直接写 TOML）：

| 分组 | 键 |
| --- | --- |
| `a2a` | `a2a.allow`、`a2a.enabled`、`a2a.listen` |
| `hooks` | `hooks.enabled`、`hooks.entries` |
| `identity` | `identity.extra_instructions`、`identity.name`、`identity.system_prompt_path`、`identity.tagline` |
| `image` | `image.allowed_types`、`image.max_size_mb` |
| `loop_control` | `loop_control.max_iterations`、`loop_control.max_tool_calls_per_turn`、`loop_control.step_timeout_ms`、`loop_control.turn_timeout_ms` |
| `models` | `models.default` |
| `permission` | `permission.mode`、`permission.rules` |
| `providers` | `providers.default` |
| `read` | `read.ignore`、`read.max_file_size_kb`、`read.max_output_chars` |
| `secondary_model` | `secondary_model.background`、`secondary_model.subagent`、`secondary_model.summarize` |
| `telemetry` | `telemetry.enabled`、`telemetry.sanitize_errors` |
| `thinking` | `thinking.budget_tokens`、`thinking.effort`、`thinking.enabled` |
| `tools` | `tools.allow`、`tools.deny`、`tools.output_limit_bytes` |
| `tui` | `tui.mouse_mode`、`tui.notifications`、`tui.show_thoughts`、`tui.theme` |
| `watch` | `watch.debounce_ms`、`watch.enabled`、`watch.ignore` |
| `workspace` | `workspace.additional_dir`、`workspace.respect_gitignore` |

挂载分区的标量子键已进 get/set 键面（共 20 个）：`verify.on_completion`；
`subagent.enabled` / `subagent.max_iterations` / `subagent.timeout_ms` / `subagent.default_profile` / `subagent.btw_enabled`；
`ptc.enabled` / `ptc.timeout_ms` / `ptc.max_tool_calls`；`cron.enabled`；
`context.time_context` / `context.date_change_sensor` / `context.tool_result_prune` / `context.max_history_entries` / `context.timezone`；
`memory.dream_enabled` / `memory.inject_enabled`。

### 挂载式分区（config-gated，缺省关）

以下分区采用挂载式拓扑：**未显式声明时恒不物化**（缺省路径逐字节等价），显式声明
`[分区]` 后才生效，子键经 backfill 补默认。子键虽可经 `bi config get/set` 读写
（get 读到的是 schema 缺省，不改变"未物化"事实；set 写入即显式声明），

| 分区 | 门与作用 |
| --- | --- |
| `[verify]` | 完工自验看门狗（`deliverable` / `command` 检查条目 + `on_completion` 开关） |
| `[subagent]` | `enabled` = 注册 `spawn_subagent` 模型工具；`btw_enabled` = `/btw` 旁路问答 |
| `[ptc]` | `enabled` = 注册 PTC 脚本工具 `run_ptc_script`（`timeout_ms` / `max_tool_calls` 为执行边界） |
| `[cron]` | `enabled` = 注册会话内 cron 三件套（`cron_schedule` / `cron_list` / `cron_remove`） |
| `[context]` | 上下文引擎：`time_context` / `date_change_sensor` / `tool_result_prune` / `max_history_entries` / `timezone` |
| `[memory]` | 记忆面：`dream_enabled`（收尾沉淀到 `<cwd>/BI.dream.md`）/ `inject_enabled`（启动注入） |

### 环境变量覆盖

优先级高于所有 TOML 层、低于 CLI 旗标：`BI_PROVIDER`、`BI_MODEL`、
`BI_SECONDARY_MODEL`、`BI_BACKGROUND_MODEL`、`BI_THINKING_EFFORT`、
`BI_PERMISSION_MODE`、`BI_TOOLS_ALLOW`、`BI_TOOLS_DENY`、`BI_IDENTITY_NAME`、
`BI_WORKSPACE_ADDITIONAL_DIR`。

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
| `packages/{mcp,a2a,plugins,workflow,worktree}` | BI-01 骨架包，按卡填充 |
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
