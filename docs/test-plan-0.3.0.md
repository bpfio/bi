# bi 0.3.0 自助测试计划（全功能矩阵）

> 适用：@bpfio/bi 0.3.0（本机仓库版 `bun bin/bi.ts` 与 npm 发布版行为一致）。
> 每项给出**可直接粘贴的命令**与**通过判据**。预计全量 60-90 分钟；只跑"冒烟组"10 分钟。
> 约定：`$ bi` = 仓库版或全局安装版；测试工作目录建议用一个空目录（如 `mkdir ~/bi-test && cd ~/bi-test`）。

## 0. 环境准备

```bash
# 1) provider：至少配一个可用模型（~/.bi/config.toml）。最小示例：
# [providers.entries.my_llm]
# api_key_env = "MY_API_KEY"          # key 本体放环境变量，配置文件永不落明文
# base_url = "https://<你的端点>/v1"   # openai 兼容端点；anthropic 协议把 kind 换 "anthropic"
# kind = "openai"
# models = ["<模型名>"]
# [models] default = "main"
# [models.entries.main] provider = "my_llm" model = "<模型名>"
# 2) 可选开关（测试新器官行为时加）：
# [tools] media = true / job_tools = true / lsp = true / select_tools = true
# [context] image_offload = true / auto_compactor = true
# [ptc] enabled = true                    # 无头会话工具面总门
# [permission] mode = "auto"              # auto=常规操作放行；manual 会逐条询问
```

## A. 冒烟组（10 分钟，必过）

| # | 项 | 命令 | 通过判据 |
|---|---|---|---|
| A1 | 版本 | `bi --version` | 输出 `0.3.0` |
| A2 | 主帮助 | `bi --help` | 用法+11 子命令列表，exit 0 |
| A3 | 裸跑 | `bi` | 用法+指引，exit 2（不是崩溃） |
| A4 | 体检 | `bi doctor` | 配置/凭据/网络/沙箱/工具注册 5 项，全 ✓ |
| A5a | 无头纯会话 | `bi --prompt "用一句话介绍你自己"` | `--output-format stream-json` 可见 `thinking_delta`/`content_delta`/`usage`/`session_done`，exit ok |
| A5b | 无头工具会话 | **先开 `[ptc] enabled=true`**，再 `bi --prompt "用 bash 工具执行 echo ok"` | 事件链含 `tool_call` 类事件，真实执行并汇报 `ok`；**未开 [ptc] 时模型会"文本演"工具（编造输出），属已知边界 G1** |
| A6 | 子命令帮助 | `bi config --help`（及任选 3 个子命令） | 各自 usage，exit 0 |

## B. CLI 子命令面（15 分钟）

| # | 项 | 命令 | 通过判据 |
|---|---|---|---|
| B1 | config 读写 | `bi config get models.default` → `bi config set models.default main` | get 回显；set 后再 get 一致；非法值 exit 2 |
| B2 | config list | `bi config list` | 66 键全列出 |
| B3 | session | `bi session` | 列出历史会话（JSON 行，最新在前） |
| B4 | fork | `bi fork <sessionId>` | 新会话 id 生成 |
| B5 | export | `bi export <sessionId>` | markdown/json/html 三格式输出非空 |
| B6 | copy | `bi copy <sessionId>` | 剪贴板或 stdout 降级，exit 0 |
| B7 | transfer | `bi transfer --help` | 脱敏导出/导入 usage |
| B8 | upgrade | `bi upgrade --help` | manifest→sha256→原子换装 usage（不真跑） |
| B9 | 未知用法 | `bi copy --bogus` | exit 2 + help 提示（不静默执行） |

## C. 工具面（20 分钟；先在 config 开对应门控）

| # | 工具 | 触发 prompt | 通过判据 |
|---|---|---|---|
| C1 | read_file | "读 README.md 第一段" | 内容正确 |
| C2 | write/edit | "新建 note.txt 写入 ok，再把 ok 改成 done" | 文件落盘+内容替换 |
| C3 | bash | "执行 uname -a" | 真实输出 |
| C4 | grep/glob | "找出 src 下含 ConfigService 的文件" | 路径正确，node_modules 不出现 |
| C5 | web_fetch/search | "抓取 https://example.com 标题" | 结构化内容（需外网） |
| C6 | read_media_file | 先放一张 png 到工作区，"检查它的宽高" | MIME/宽高/字节数；**工作区外路径必须被拒**（path-escape） |
| C7 | JobList/Output/Kill | "列出当前后台任务" | `{"ok":true,"jobs":[...]}` 形态 |
| C8 | lsp_navigate | 配置 LSP server 后 "跳转到某符号定义" | 有 server=导航结果；无 server=结构化 `lsp-unavailable`（不裸崩） |
| C9 | Skill | 工作区放 .bi/skills 试例后 "列出可用技能" | 器官响应；无目录=结构化 `no-skills` |
| C10 | select_tools | "你有哪些工具的详细参数？"（select_tools=true 时） | 返回名录摘要+可换取 schema |
| C11 | AgentSwarm | config `[subagent] enabled=true` 后 "派 2 个子代理分别总结 X 和 Y" | 并发派发+汇总结论 |

## D. 会话与状态（10 分钟）

| # | 项 | 方法 | 通过判据 |
|---|---|---|---|
| D1 | 多轮上下文 | 一次会话内"记住数字 42"→ 新 prompt "刚才的数字？" | 记得 |
| D2 | 崩溃恢复 | 会话中 kill -9 进程 → `bi session` → 恢复 | JSONL 完整到最后一行 |
| D3 | 中断恢复 | 长任务中 Ctrl-C → 续问 | 上下文自愈注入，不报语法树残缺 |
| D4 | 权限门 | mode=manual 下让它写文件 | 弹审批；deny 后不写 |

## E. TUI / REPL（15 分钟；真实终端里 `bi` 无参进入）

| # | 项 | 操作 | 通过判据 |
|---|---|---|---|
| E1 | 流式渲染 | 提问长回答 | delta 实时上屏，无花屏（CJK 对齐） |
| E2 | 状态行 | 看底部 | `[模式] [权限] 就绪 | Tokens: …` HUD 出现且有读数 |
| E3 | /mode | `/mode plan` → 让它写文件 → `/mode build` | plan 拒写（plan-mode-readonly）；切回恢复 |
| E4 | /compact | 长对话后 `/compact` | 紧缩回执，后续对话上下文保持要点 |
| E5 | /rewind /clear | 各执行一次 | 回退/清空生效 |
| E6 | Tab 补全/历史翻页 | 输入 `/` 与 ↑ | 候选菜单、历史回放 |
| E7 | diff 审查门 | 让它改一个文件（auto 态） | diff 展示后再落盘 |

## F. 新器官行为（10 分钟）

| # | 项 | 配置 | 触发 | 通过判据 |
|---|---|---|---|---|
| F1 | 插槽路由 | `[secondary_model] subagent = "<provider/model>"` + `[subagent] enabled=true` | 派子代理 | stderr 出现插槽装配日志；子代理走插槽模型 |
| F2 | AutoCompactor | `[context] auto_compactor=true` | 造长会话逼近水位 | 静默紧缩发生，会话不中断；summarizer 失败只熔断不崩 |
| F3 | image-offload | `[context] image_offload=true` | 多图长会话 | 最早图片被占位符替换，结构完整 |
| F4 | vis 令牌轮转 | `BI_VIS_TOKEN_ROTATE=1 bi vis` | 打开 web 页面 | 轮转令牌可访问、旧令牌宽限期内有效 |

## G. 安全面（贯穿）

- 工作区外路径读写必须被拒（path-escape / PathJail）。
- `api_key_env` 未设置时报错指向 `bi doctor`，不泄露 key。
- 会话 JSONL 中 grep 不到明文 key。

## 已知边界（非缺陷，遇到不算失败）

0. **无头工具面总门**：headless 会话工具面整体受 `[ptc] enabled` 门控，缺省关=模型无工具。此时让它"执行命令"会得到编造的文本输出（非真实执行）——**无头跑任务务必开 [ptc]**。（改进候选：无工具时对疑似工具调用文本给出 stderr 提示。）


1. opencode Go 免费端点：>10 分钟长会话可能断流/限流——生产请配稳定 provider。
2. LSP/Skill/swarm 依赖外部资源（server/目录/subagent 使能），未配置时结构化降级是**正确行为**。
3. `--max-rounds` 缺省 8，复杂工单用 `--max-rounds 100`。
4. vis 完整浏览器验证需要 Chromium（挂账中）。

## 结果记录

跑完把失败项记成 `bi bug: <现象+复现命令>` 清单交回，进修复队列。
