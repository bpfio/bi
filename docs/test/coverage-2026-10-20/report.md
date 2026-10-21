# bi 功能台账全覆盖测试 v2 报告（BI-COVERAGE-2026-10-20）

- **方法**：对照 183 卡台账三波执行——T1-A 主控 CLI 级 20 检查（伪端点零模型）；T1-B/C 派 kimi 执行 26 检查；T2 bi 狗粮 agent 级 6 探针（longcat）。通道严格串行（kimi 与 bi 零并发）。
- **提交**：修复波 33ba1fb（kimi 派工 + 主控四步验收）。

## 覆盖与结果

| 波 | 执行者 | 检查面 | 结果 |
|---|---|---|---|
| T1-A | 主控 | G1-G9：help/16 子命令/version/init 幂等/session list/fork/export 三格式/transfer 脱敏往返+同 HOME 拒/copy/query 表达式+坏参 exit2/config 三面往返/doctor 结构化 | **20/20 PASS** |
| T1-B | kimi | upgrade --check 只读/vis 令牌+SIGINT/acp initialize 帧/worktree 全链/dag 成功+必败+重跑/a2a host+令牌/plugins 三态 | **12 PASS 1 FAIL**→F-EV-03 |
| T1-C | kimi | pty 横幅+/help 指令目录+/exit 退出码 0/headless stream-json+text+json+resume 追加语义 | **13/13 PASS** |
| T2 | bi 狗粮 | 写读闭环/BI.md 注入（inject_enabled=true 一回合凭记忆答中）/64KB 截断/edit 闭环/resume 自我纠错/单行截断修复验证 | **6/6 PASS**（首测 1 处系缺省关设计内） |

## 发现与处置（全部当波闭环）

| ID | 级别 | 摘要 | 处置 |
|---|---|---|---|
| F-EV-03 | **P2 安全** | a2a host HTTP 面零令牌校验（token 配置下无/错 token 全 200；主控复现实锤） | **fixed 33ba1fb**：非空令牌全路由 Bearer/?t= 校验，401 对齐 vis；真机冒烟 401/401/200/200 |
| F-EV-05 | P3 | boundToolText 行稀少输出半预算退化（65536 上限单行只留 32796，尾部零保留；bash 保尾+bound 保头双层复合可见内容非头非尾） | **fixed 33ba1fb**：尾侧空侧预算并入头侧；真机复测保 65535 |
| F-EV-04 | P3 | [vis] 配置分区缺失静默丢弃 | **fixed 33ba1fb**：挂载式 visSchema（enabled/listen/token_env）+MOUNTED_SECTIONS+装配接线，键面 70→73 |
| F-EV-02 | P3 | [loop_control] 四键全仓零消费（库态虚账） | **open** 待裁决（接线 AgentLoop 或文档降级） |

门禁：4898 pass / 0 fail（270 文件，+28 用例）+ 三包 tsc 0（主控亲跑）。kimi 修复自查 4 处偏离均核实合格（含纠正工单错写的令牌 env 名：内建实为 BI_VIS_AUTH_TOKEN）。

## bi Agent 能力终评（2026-10-20 深夜，v3）

- **硬幻觉率 0**（BI-EVAL 7 探针 + 本轮 T2 复验零编造；T2-5 resume 中模型主动重读文件纠正自己上一轮的说法——接地行为标杆）。
- **工具面效用真实**：写/读/edit 闭环、run_js、query、会话族、截断、注入链全部真机有效；失败面（rounds-exceeded）结构化可消费。
- **已知边界**：回合预算缺省 8（可配 [session] max_rounds，建议调研型 16-32）；memory 注入/微器官均为 opt-in 设计（缺省关是特性不是缺陷，但文档应更显眼）；TUI 斜杠菜单吃首 Enter 属既有设计。
- **结论**：bi 处于"功能面全覆盖可用 + 失败诚实 + 零编造"状态；唯一挂账 F-EV-02 为低危配置虚账。
