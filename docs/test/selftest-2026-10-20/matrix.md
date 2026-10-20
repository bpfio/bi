# bi 全业务领域自测矩阵（对照 183 卡开发台账）

- 批次：BI-SELFTEST-2026-10-20（logbook）
- 执行者：主控 zcode 真机驱动（仓库版 `bun bin/bi.ts`，非全局 npm 0.3.0）
- 纪律：自测期间 kimi cli 静默（与 bi 自测共用 opencode Go 端点池，防 429）；bi 模型自测用 longcat 短单
- 缺陷流程：即时 `finding_record`（F-ST-xx）+ 本文档记录；**全部自测完成后**统一派工修复
  （本机 codebuddy hy3 / xhub codebuddy hy3 / kimi cli 错峰）

## S0 TUI 指令面审计（用户质疑点）

代码级定案（packages/tui/src/mount/agent-tui.ts + core/src/commands/compact.ts）：

| 指令 | 来源 | 状态 |
| --- | --- | --- |
| /btw | agent-tui 内置旁路 (BI-07.6) | 有 |
| /mode plan\|edit\|build\|yolo | mode-command (BI-20.1) | 有 |
| /compact /rewind /clear | core GATE_REGISTRY (BI-11) | 有 |
| /copy | tui/src/commands/copy.ts (BI-19.4) | 待真机验证 |
| 自定义 *.md | ~/.bi/commands/ 与 .bi/commands/ (BI-01.2) | 有 |
| **/exit** | — | **无（退出=Esc 双段窗口）** |
| **/help** | — | **无（指令清单不可发现）** |
| /quit /sessions /model /doctor | — | 无 |

- F-ST-01（P2）：TUI 无 /exit、无 /help——退出机制存在但零可发现性，新用户无法自助退出。
  台账对照：BI-27.4（候选与命令菜单）只列自定义命令，不列内置指令；TUI-ALIGN-1 差距分析未覆盖此点。

## 域矩阵（10 域 × 台账族 × 检查项）

| 域 | 台账族 | 代表检查 | 结果 |
| --- | --- | --- | --- |
| D-A CLI 生态 | BI-20.2/24.1/29, PROD-2 | --version/--help/usage 面；init；session list/show/export/fork/transfer 往返；config get/set 往返（沙箱 HOME）；doctor；upgrade/acp/vis help 面 | 主控 PASS×全（11 子命令 help/init 幂等/config 五词面往返/doctor exit 契约）；help 未披露裸 bi=REPL（并入 F-ST-01） |
| D-B headless 核心 | BI-23.1/30, BI-20.2b | -p 短单（longcat）；--output-format 三形态；--max-rounds；--resume 续会话；--agent-file；--add-dir | 主控伪端点 8 项：B1/B2/B4/B5(resume 历史重放)/B6(结构化 session-not-found)/B7(agent-file 注入) PASS；B3=json 格式缺失（F-ST-02 P3）；B8 归 D-C |
| D-C 执行工具+权限门 | BI-28.1/.2/.3/.5, BI-06.1/.5, BI-07.2 | [ptc] 开门后 bash/read/write/edit/glob/grep 真机；yolo 直通；manual 审批；path jail 越界拒；read-before-write 拒绝 | C1 yolo bash 真 tool_use PASS；C2 path-escape 结构化拒 PASS；C3 **write 跳读直写成功→F-ST-03 P1 装配虚账**；C4 截断机制在但缺省 0（F-ST-04 P3）；C5 manual→permission-ask-unavailable-in-headless PASS；C6 glob/grep/edit 绑定级 PASS |
| D-D 上下文引擎 | BI-05, BI-08, BI-09, BI-10 | BI.md 注入；时间上下文；64KB 截断；image offload/auto_compactor 配置接线（config 键面） | W1：[context] image_offload/auto_compactor 传递链 PASS；**BI.md 注入链断裂→F-ST-05 P2**（init 产 BI.md、注入读 BI.dream.md 且缺省关）；截断见 C4/F-ST-04 |
| D-E 器官挂载门 | BI-07.4/.8/.9, BI-13.1/.2/.3, DEBT-1.x | config 键开→工具面出现 media/job/lsp/select_tools/swarm/skill/subagent；关→不挂载；lsp 无 server→lsp-unavailable；skill 无目录→no-skills | W1 全 PASS：动态探针 8→22 工具、增量 14 件精确、无移除副作用；lsp-unavailable/no-skills 结构化容错实锤；[ptc] 总门确认 |
| D-F MCP/ACP/插件 | BI-13, BI-17, BI-25.2 | stdio MCP 假 server 连接+工具透传；acp 桥握手；插件双协议加载 | W3 进行中 |
| D-G TUI 真机 pty | BI-27.x, BI-19.x, BI-23.2, BI-26.4, BI-11 | pty 启动横幅；流式上屏；Esc 双段退出；/help 缺失表现；斜杠菜单清单；Ctrl+F 搜索；/mode 切换回执；写工具审批 diff 门 | 主控 pty：/mode 切换 PASS；菜单 5 件（/compact /rewind /clear /diff /copy）漏 /btw /mode /permissions；/help 未知+提示只有 /permissions；退出=Ctrl+C(空)实测 exit=0、Esc 二段为回合级语义；首键 Ctrl+C 吞没（F-ST-06 P3）；可发现性缺陷并入 F-ST-01 P2。W5 深探：G1 一段取消/G3 Ctrl+F/G4 /diff fail-closed 回执/G5 manual 审批浮层+零写盘 全 PASS；G2 双 Esc 退出判 FAIL 系探针 50ms 键间下限不可达 3ms abort 窗口（代码路径静态核实正确）——二段退出建议补单测 |
| D-H 会话引擎深度 | BI-03.x, BI-20.3/20.4, BI-03.7 | 会话树 append；fork 分叉；rewind/undo；export→import 往返+脱敏；query 检索 | W2 全 PASS（H1-H5：list/fork 截断/export 三格式含 html 主题/transfer 脱敏往返+同 HOME 冲突契约/坏参结构化）；H6 **query 引擎无 CLI 入口→F-ST-07 P3** |
| D-I 模型适配与路由 | BI-04.x, BI-02.x, DEBT-1.12 | 三 provider 并存解析；extra_headers（x-opencode-session=auto→UUID）；secondary_model 插槽路由+回退；DeepSeek 双线材 | W3 进行中 |
| D-J worktree/A2A/vis/DAG/沙箱 | BI-12.x, BI-15.x, BI-14.x, BI-16.x, BI-20.5/20.7 | worktree 创建/合并门；a2a 子命令面；vis 服务+令牌；CodeMode/Python 沙箱工具面 | W4 进行中（xhub） |

## 缺陷清单（finding_record 同步）

| ID | 域 | 级别 | 摘要 | 状态 |
| --- | --- | --- | --- | --- |
| F-ST-01 | S0/D-G | P2 | TUI 可发现性：无 /exit /help；菜单漏 /btw /mode /permissions；/help 提示只列 /permissions；横幅零提示 | open |
| F-ST-02 | D-B | P3 | --output-format 无 json 形态（契约=stream-json\|text；集成便利性缺口） | open |
| F-ST-03 | D-C | P1 | BI-07.2 read-before-write 生产装配虚账：headless/agent-tui 双装配位未传 writeGate/fileAccesses，read_file 未 recordRead；真机复现 write 跳读直写 | open |
| F-ST-04 | D-C | P3 | output_limit_bytes 缺省 0=截断关闭（BI-08 承诺 64KB 有界；默认值策略缺口） | open |
| F-ST-05 | D-D | P2 | BI.md→记忆注入链断裂：init/README 承诺 BI.md"审查后生效"，运行期只读 BI.dream.md 且缺省不注入 | open |
| F-ST-06 | D-G | P3 | 启动后首个单键 Ctrl+C/D 吞没（KeyStream 竞态，2/2 复现；先有按键活动则正常） | open |
| F-ST-07 | D-H | P3 | SessionQueryEngine（BI-03.7）无 CLI 入口（仅库 API） | open |

## 派工记录

| 单 | 节点/模型 | 域 | 状态 |
| --- | --- | --- | --- |
| W1 | 本机 codebuddy hy3 | D-E+D-D | closed（验收过，报告 reports/W1.md） |
| W2 | xhub codebuddy hy3 | D-H | closed（验收过，报告 reports/W2.md） |
| W3 | 本机 codebuddy hy3 | D-F+D-I | closed（验收过，报告 reports/W3.md） |
| W4 | xhub codebuddy hy3 | D-J | closed（验收过，报告 reports/W4.md） |
| W5 | 本机 codebuddy hy3 | D-G 深探 | closed（首派死于轮询取消零产出，重派验收过，报告 reports/W5.md） |

## 修复波（自测全域完成后启动，文件边界零交集）

| 单 | 节点/模型 | 修的 finding | 文件边界 | 状态 |
| --- | --- | --- | --- | --- |
| FX-A | 本机 codebuddy hy3 | F-ST-03 (P1) | 仅 toolset.ts+新测试 | running |
| FX-B | xhub codebuddy hy3 | F-ST-01+06 | tui mount+bin/bi.ts | running |
| FX-C | 本机 kimi cli | F-ST-05+07 | headless/schema 注释/dispatch/query.ts/README | running |
| FX-E | 第二波 | F-ST-02+04 | schema/args/headless（等 FX-C 释放文件） | pending |
| FX-F | 第二波 | F-ST-08 | toolset/mcp-mount/main（等 FX-A 释放文件） | pending |
| — | 主控 | F-ST-09/10 | 插件/四大件装配=策略问题，挂 WAIT-FST10 待用户裁定 | open |
