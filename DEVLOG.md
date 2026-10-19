# bi 研发台账 DEVLOG (主控编纂版 v5.4 · CLI 生态接线)

> **生成**:2026-10-19 BI-25 族全闭存档。**closed 117/117+BI-23/24/25 三族(128/128)**,代码前沿 ee77698。
> 全仓 **4170 测试用例 / 217 文件 / 双 tsc 0 错 / 零返工**;devlog 链 #155~#257。
> 终局验收:**全功能矩阵 11 域(A-K)全 PASS、0 DEGRADED**(44 演练测试/575 断言,docs/E2E_DRILL_REPORT.md)。
> 当前阶段:**装配增强与发布面达成**——`npm i -g @bpfio/bi` 即装即用(原生二进制),bin 两路径挂默认工具集(mimo 真实工具回合实测),acp 可接真会话,REPL 有历史/补全/多行,见第八·九节。

---

## 一、闭环卡验收台账 (104 卡,域分组)

### 基建与发布 (5)
| 卡 | 标题 | commit |
|---|---|---|
| BI-00.1 | 上游锚点引擎 v1 | 55f6c02 |
| BI-00.2 | 升级追踪首周期 | a4931dc |
| BI-01 | Monorepo 骨架 | e555591 |
| BI-01.1 | 三级 TOML 配置引擎 | eb26543 |
| BI-22 | Bun Compile 二进制构建 | 732ba01 |

### 会话与凭据 (9)
| 卡 | 标题 | commit |
|---|---|---|
| BI-03 | JSONL 会话引擎 | d46a219 |
| BI-03.2 | 写前 Blob 快照 | bfe0148 |
| BI-03.4 | 级联撤销状态机 | 4b5848a |
| BI-03.5 | 双边界收件箱与门铃协调器 | db96942 |
| BI-02 | 智谱双轨认证 | ddd1c9c |
| BI-02.1 | Ultra 专线网关 | 1bcc1af |
| BI-02.2 | 额度看门狗 | dc9eec6 |
| BI-02.3 | 闲时错峰调度 | 15276eb |
| BI-02.4 | 赠送申领与抽卡 | 27358df |

### 工具执行与安全 (12)
| 卡 | 标题 | commit |
|---|---|---|
| BI-06 | 受控 Bash 执行器 (PGID) | 619e9bd |
| BI-06.5 | 三态权限门禁 | 2c9214a |
| BI-06.6 | 文件写互斥队列 | 8b04ff2 |
| BI-06.8 | Shell 词法扫描器 (2443 行) | e6d6d82 |
| BI-06.1 | Path Jail | 62177e7 |
| BI-06.2 | 嵌入式搜索加速器 | 62177e7 |
| BI-06.3 | 协作式超时看门狗 | 95ac0ee |
| BI-06.9 | 资源采样器与信任门 | 2e2d336 |
| BI-06.4 | 生命周期钩子系统 | fe1e3bc |
| BI-06.7 | 持久化 PTY Shell | (含于 51c3e12) |
| BI-06.10 | OS 级沙箱 (Landlock 实测) | 81d4b06 |
| BI-21.1 | 完工自验看门狗 | 235551c |

### 上下文纵深防御 (10)
| 卡 | 标题 | commit |
|---|---|---|
| BI-08 | 64KB 有界截断 | 4d23c95 |
| BI-10.2 | 工具配对门禁 | a87016e |
| BI-08.1 | 中间修剪与 Spill | a87016e |
| BI-09 | 历史脱水 | a87016e |
| BI-10 | 高水位紧缩器 | a87016e |
| BI-05.4 | 时钟上下文 | a87016e |
| BI-10.1 | 恢复指针 | cefebd8 |
| BI-10.3 | 缓存连续性 | cefebd8 |
| BI-10.4 | 历史规整 | cefebd8 |
| BI-10.5 | 中断自愈 | cefebd8 |

### MCP 与 A2A (8)
| 卡 | 标题 | commit |
|---|---|---|
| BI-13 | MCP 客户端 (Stdio+SSE) | 7a2f289 |
| BI-13.1 | Tool-on-Demand | 2405875 |
| BI-13.2 | LSP 导航 | 8135957 |
| BI-13.3 | 名录压缩器 (主控亲建) | 3952a75 |
| BI-15.3 | A2A 三级鉴权 | a97bdef |
| BI-15 | A2A 总线与黑板 | 40abb58 |
| BI-15.1 | 邮件信令网关 (双层白名单) | 4eb5c74 |
| BI-15.4 | WSS 中继 | 4b0a0ff |
| BI-15.2 | GitHub 任务中枢 | (含于 51c3e12) |

### Worktree 与工作流 (10)
| 卡 | 标题 | commit |
|---|---|---|
| BI-12 | Worktree 沙箱引擎 | 11569c0 |
| BI-12.1 | 存储修剪器 | 85b6c1d |
| BI-12.2 | Tower 协议 | bdfa966 |
| BI-14.2 | Plan 模式与审批门 | 5a5858d |
| BI-14.5 | durable 调度器 | 3e2c20b |
| BI-14 | DAG 工作流引擎 | adf2b37 |
| BI-14.1 | 因果拓扑与污点 | 689a386 |
| BI-14.3 | Todo 防漂移 | b99034a |
| BI-14.4 | 模式互斥协调器 | cf2dcc8 |
| BI-21.2 | 交付追踪器 | 48b5e26 |

### 记忆与终端 (6)
| 卡 | 标题 | commit |
|---|---|---|
| BI-05 | BI.md 注入 | ffcb5af |
| BI-05.1 | Dream Cycle | ffcb5af |
| BI-05.2 | init 自省生成器 | ffcb5af |
| BI-05.3 | 嵌套规则探测器 | ffcb5af |
| BI-19 | Pi-TUI 双缓冲差分终端 | 0be5704 |
| BI-19.1 | 四层同构投影 | 591daef |

### 模型驱动与导出 (6)
| 卡 | 标题 | commit |
|---|---|---|
| BI-04.1 | 黄金排布与容错解析 | (含于 51c3e12) |
| BI-04.2 | DeepSeek 原生适配器 | 3e2d7db |
| BI-04.3 | 缓存保活与账单 | 39e9a3f |
| BI-04.4 | 4 级断点分配器 | 8b42adb |
| BI-11 | Token HUD | 204cfaf |
| BI-20.3 | HTML 会话导出 | fc30d5f |

### 蜂群与多模态 (5)
| 卡 | 标题 | commit |
|---|---|---|
| BI-07.3 | 子代理视窗沙箱 | (Pack2) |
| BI-07.4 | 双向信令与镜像总线 | (Pack2) |
| BI-07.6 | /btw 旁路问答 | (Pack2) |
| BI-07.9 | 声明式技能工具 | (Pack2) |
| BI-08.2 | 图像渐进卸载 | (51c3e12) |
| BI-08.3 | ReadMediaFile | (51c3e12) |

### 并发与控制 (5)
| 卡 | 标题 | commit |
|---|---|---|
| BI-07 | Agent 循环 + RWLock + 二段取消 | 081cac6 |
| BI-07.1 | 8 级弹性匹配引擎 | (Pack1) |
| BI-07.2 | Read-Before-Write 门禁 | (Pack1) |
| BI-07.13 | 工具排重+三阶打断门 | (Pack1) |
| BI-07.11 | 后台任务运行时 | (0ac46a9) |

### 渲染与安全工具 (5)
| 卡 | 标题 | commit |
|---|---|---|
| BI-19.6 | Mermaid 字符画渲染 | (ed85adc) |
| BI-19.7 | RFC 6902 Delta 追踪器 | (ed85adc) |
| BI-19.8 | LaTeX 渲染 | (ed85adc) |
| BI-17 | 插件双协议加载器 | (10ab65f) |
| BI-07.12 | HTML→Markdown 引擎 | (51c3e12) |

---

## 二、终局增量 (13 卡,v3 快照后闭环,含 2 张父卡 rollup)

| 卡 | 标题 | commit |
|---|---|---|
| BI-07.12 | 流式 HTML→Markdown 引擎+web-extractor(SAX 词法机/块级栈渲染/110 实体表/5MiB 预算,63 测试) | ba8fa3c |
| BI-18.1 | superpowers SOP 技能集(四技能+总纲,472 行) | d709163 |
| BI-19.4 | 剪贴板图文互通(跨平台矩阵/SHA-256 内容寻址去重//copy,54 测试) | 738e358 |
| BI-16.2 | PTC 模式(tool-compiler 双形态+ptc-runner 沙箱单轮执行,43 测试) | 91a60eb |
| BI-20 | Diff 审查门+/doctor 体检(53 测试) | 4ebb049 |
| BI-18.2 | 视觉核验判定器(端口化状态机,27 测试) | e7cdcb2 |
| BI-18.3 | 公文转译+PDF 管线(结构类型零跨插件耦合/优雅降级,30 测试) | 464edde |
| BI-18 | 研报插件资产(xlsx 勾稽引擎+双栏抽取 Python 骨架,冒烟验证) | 474277f |
| BI-07.15 | Web 抓取与搜索工具链(56 测试) | 6f12da7 |
| BI-11.1 | 可观测性底座(OTLP 缺省零出网,45 测试) | 42d891a |
| BI-00 | 父卡 rollup(锚点引擎+运行循环+硬分叉裁定,子卡全闭环) | a4931dc |
| BI-04 | 父卡 rollup(SSE 驱动与插槽路由,adapters 域承载) | 591daef |
| BI-21 | **终局全功能验收矩阵**(11 域 A-K 全 PASS,44 测试/575 断言) | 3d212ee+4610bc0 |

## 二·补遗、域包子卡补列 (22 卡,v3 编纂漏列,台账 commit 核对补齐)

| 卡 | 标题 | commit |
|---|---|---|
| BI-01.2 | Custom slash command 引擎与 shell 参数展开 | 591daef |
| BI-03.1 | 会话时光倒流与物理文件差分回滚 | 2585ebb |
| BI-03.3 | 会话状态空间正规化与不变量防竞态矩阵 | 2585ebb |
| BI-03.6 | 离线阴影会话回放与回归验证引擎 | c51e162 |
| BI-03.7 | 会话语料检索引擎(过滤编译) | c51e162 |
| BI-07.5 | 重复工具调用守卫与目标自动续行 | d97fb13 |
| BI-07.7 | 会话内 Cron 定时任务调度器 | c51e162 |
| BI-07.8 | 蜂群并行子代理调度与模板扇出 | 1440778 |
| BI-07.10 | 交互式用户提问门与计时挂起恢复 | 81f5345 |
| BI-07.14 | 跨时区全周期调度与持久化重放中枢 | d7a3ec7 |
| BI-16 | Python 沙箱运行即验与 Traceback 自愈 | c7b1631 |
| BI-16.1 | JS/TS 零依赖内存精算沙箱(CodeMode) | 854a910 |
| BI-19.2 | 流式缓动输出缓冲与帧率自适应节流 | 622dae2 |
| BI-19.3 | 桌面原生通知与终端蜂鸣催促看门狗 | 7633148 |
| BI-19.5 | 外部编辑器唤醒与长提示词桥 | 6438175 |
| BI-20.1 | 四协作模式切换器(Plan/Edit/Build) | 4e8be45 |
| BI-20.2 | CLI 子命令生态与参数矩阵 | 4fa7ad0 |
| BI-20.4 | 会话全拓扑脱敏导出导入与匿名归档 | 48b5e26 |
| BI-20.5 | 本地 Web 会话可视化服务器与令牌轮转 | 736369d |
| BI-20.6 | ACP 协议子命令与 IDE 桥接器 | 5e7f5d5 |
| BI-20.7 | 原子分阶段自升级与原生二进制交换 | 711a7f6 |
| BI-21.3 | 确定性无头 Agent 评测套件与基准打分 | aee8e67 |

> 一 + 二·补遗 + 二 = 117 卡全列;每行 commit 均与台账 task commit_hash 核对一致。

## 三、终局验收矩阵摘要 (docs/E2E_DRILL_REPORT.md)

A 宏观政策数据审计(0 误差) · B 会话生命周期 · C 凭据/OAuth 七态 · D 沙箱(landlock+bwrap 本机实探) · E 上下文防御链 · F 双代理编排 · G MCP/A2A 回环 · H 工作流 DAG/plan-mode · I TUI 双缓冲同构 · J 命令钩子(20 事件钉死) · K 网关+原子换装。演练修复缺陷 2:xlsx_audit %.4g 科学计数法;installLock.release 异步 unlink 竞态→unlinkSync。

## 四、质量与安全
- 全仓 **4087 pass / 0 fail(210 文件,49726 expect)** / 双 tsc 0 错 / 零返工
- **台账 117/117 = 100% 全清(P0 全含)**
- 安全裁定:权限模式权威源(06.5) / Plan 审批必填(14.2) / TowerMerge reviewer 签名(12.2) / verifier 白名单冻结(21.1) / 钩子双层语义(06.4) / recover 走合法转移边(14.5) / 邮件双层白名单(15.1) / WSS 零入站端口(15.4) / OTLP 缺省零出网(11.1) / 升级面 rename 唯一原子面(17 系)
- 规程:TOOL-1/TOOL-2 / Step-0+时间锚(#175/#177) / 族包逐卡分段+复用型工单(#171/#240) / 派工原子性(OPS-DISPATCH-1→RULE-BI-10) / 三败主控亲建 / 探询 10min 零落盘即停 / picomatch 段语义(RULE-BI-11)

## 五、发现项与维护态裁决 (2026-10-18,用户按建议组合定案)
- **fixed×2**:HOOK-EVENT-MAP(commit 711f9e9:config 事件面扩为 runner 20 事件 snake_case 镜像+pre_tool/post_tool 别名,prompt_submitted 移出;新增 hooks-adapter 装载适配+runner matcher 过滤,13 新用例) / OPS-DISPATCH-1(升格 RULE-BI-10 派工三步锁,纯流程零代码)
- **wontfix×2(转备案)**:AUDIT-10(五处集成接缝消歧指令已全部兑现,转架构 SSOT) / AUDIT-8(大典外残差五项不立项,另需时再立新卡)
- **维持 open×3(上游 logbook 工具缺陷,规程规避中)**:TOOL-1(devlog 带 task_id 静默覆盖,规避=默认不带) / TOOL-2(task_upsert 字段破坏性置空,规避=全量回填) / LOGBOOK-EXPORT-1(大导出通道不可达,规避=SSH 直发)——根治归 bpfio/logbook 上游,另立项目再议
- 规则入库:**RULE-BI-10**(派工三步锁:登记-对账-探测) / **RULE-BI-11**(picomatch 段语义,deny 深路径须 `/**`)
- 观察项(演练备案,非缺陷,维持):workflow 包 barrel stub(对外 API 收口归组装层,待有外部消费者) / picomatch 段语义(已升格 RULE-BI-11) / MCP `server.tool` 前缀路由与 A2A `allowFrom` 必填显式面(fail-closed 架构事实)

## 六、组装点火增量 (BI-ASM-2026-10-18 批次,进行中)

复盘定案:分叉策略正确;真实弯路=WBS 未先行行走骨架 → **RULE-BI-12「行走骨架先行」入库**(第一张卡必须可运行最小整机,器官卡挂骨架保持常绿)。装配序沿 devlog #150 定版的 kimi 装配参考(main.ts→cli→tui→agent-core→oauth/acp/minidb)。

| 卡 | 标题 | commit | 状态 |
|---|---|---|---|
| BI-23.1 | 走骨架点火:bin 真入口+kimi 序 main 分发+无头端到端装配体 | 75c466f | **closed**(主控亲建) |
| BI-23.2 | TUI 挂载与事件流:双缓冲投影/审批 ask 回路/取消键位 | b678fb6 | **closed**(主控亲建) |
| BI-23.3 | 真实模型端到端点火:SSE 驱动+凭据门+真实会话验收 | 73b5d29 | **closed**(主控亲建) |

**BI-23.1 验收证据**:`bun bin/bi.ts --version` → `bi 0.1.0`;main 分发退出码语义 0(会话 ok)/2(参数与未知子命令)/3(无模型端口)/4(已识别未接线);e2e 5 用例断言全链路——真实工具执行(fs 读回真实内容)/钩子真实子进程触发(SessionStart+PreToolUse ran+决策 allow/block)/权限门审计轨迹(manual 模式 ask 结构化拒绝回喂,不假冒放行)/JSONL 会话 5 条目链(user→assistant(tool_use)→tool_call→tool_result→assistant,toolCallId/toolName 配对)/stream-json 线合约(StreamEvent 透传+session_done 汇总)。build-bin.ts 按 NOTE(BI-20.2) 钩子替换 VERSION 占位为 runBi 真入口(编译产物双冒烟:--version exit 0/裸跑 usage exit 2)。

**首轮走骨架真抓 3 个跨器官接线缺陷并修复**:①会话根条目 id 未回填→第二条 append 成第二个根违例;②状态机契约撞线:executeTools 落定后已在 thinking,beginTurn 只该 idle 态调;③测试桩捕获 messages 活引用未快照。均为 117 卡单器官测试无法暴露的合约对撞——RULE-BI-12 价值首轮实证。

**新增件**:bin/bi.ts、packages/core/src/cli/{headless,main}.ts(+e2e test)。骨架期显式降级(不伪造能力):权限 ask 无头结构化拒绝(审批 UI 归 23.2)/信任门缺省 trusted(真实信任门归后续装配卡)/未接线子命令结构化上报。

**BI-23.3 真实点火(2026-10-19,commit 73b5d29,closed)**:真实 ModelPort 落地——`cli/model-port.ts` 两件套:`createAdapterModelPort`(BI-04.2 双模态适配器→ModelPort 直连包装)+ `resolveModelPort`(BiConfig 选择链 models.default→entries 首个回退→provider 引用链→kind→WireMode(openai/anthropic,google 结构化无驱动)→**BI-02 凭据门**(api_key_env 间接引用,key 只经环境变量,永不落盘)+ thinking 档位映射 minimal→off/low→low/medium→high/high→max);`main.ts` 未注入 ModelPort 时走配置装配(ConfigService 三级 TOML+env),凭据/配置失败结构化退出码 3(带修复指引)。门控实弹 e2e `scripts/ignition-real-model.ts`:默认零外呼(BI_IGNITION 门),无 key DEGRADED 备案(沿 BI-21 纪律,不伪造 PASS)。

**真实点火验收(PASS,双模态)**:用户提供真实凭据(mimo-v2.6-flash,OpenAI 兼容+Anthropic 兼容双端点),key 仅存运行进程环境(~/.bi-ignition-key 0600,仓库外,git grep 0 泄漏)。两模态各一次完整真实会话:SSE 流→模型自主调用 read_file→工具回环→finalText 含魔数→JSONL 落盘(user→assistant(tool_use)→tool_call→tool_result→assistant 链)→stream-json 终帧,exit 0。anthropic-messages({origin}/anthropic/v1/messages)与 openai-completions({origin}/v1/chat/completions)双 PASS——BI-04.2 对第三方 Anthropic 兼容端点的兼容性首次实测成立。**至此 bi 首次真实模型端到端贯通:(1+1)+(1+1+1)≥5 不等式的第一个实证数据点。**

**点火排障三则(devlog #252)**:①单测桩建好 fetch 却忘传给端口,差点真实外呼——门控纪律教训(测试零外呼必须结构性保证,非约定俗成);②点火断言读错 BI-03 JSONL 记录层级(.type vs .entry.type)误报工具未回环;③resolveModelPort 漏传 temperature(单测当场抓获)。

**BI-23.2 TUI 挂载(2026-10-19,commit b678fb6,closed)**:`packages/tui/src/mount/agent-tui.ts`——AgentTuiSession 把 BI-23.1 对话驱动器挂上 BI-19/20 器官(器官零改动):**双缓冲投影**(TranscriptProjection L1→L3 + TuiApp/DiffRenderer begin/end 差分帧,onFrame 注入渲染面探针);**审批 ask 回路**(manual 门 ask→栈顶 ApprovalOverlay y/n/Esc,deny 结构化 permission-denied 回喂模型——无头降级的假冒面就此消除);**Esc 二段取消**(对齐 BI-07 迁移表:thinking→paused+模型流 abort,窗口内二段→exit,pre-beginTurn 竞态 noop 兜底,paused 续提交经 resume)。ToolCallAssembler 自 headless 导出复用,挂载面入 @bi/tui index。验收:注入渲染面 6 用例(帧序列/工具回环+tool_result 回喂/ask→放行/ask→拒绝/一段 cancelled/二段 exit+续提交报错)全绿。边界:行编辑器 REPL 接线归后续装配卡;钩子 runner 暂为无头专属。排障三则(devlog #253):Esc 与 beginTurn 竞态(根条目 fs 落盘窗口 noop 无取消→流永挂)→noop+idle 兜底;轮询错对象;浮层行集单一来源化。

**BI-23 父卡 rollup(closed)**:三子卡证据链齐备——23.1 走骨架(75c466f,5 e2e,抓 3 跨器官缺陷)/23.2 TUI 挂载(b678fb6,6 帧序列用例,抓 3 装配竞态)/23.3 真实点火(73b5d29,mimo 双模态 PASS)。RULE-BI-12 行走骨架先行铁律首个工程完赛:骨架常绿 4111 测试,器官卡全数挂上,未接线子命令(init/session/fork/export/transfer/acp/upgrade/doctor)逐个挂分发归后续装配卡。

## 七、CLI 生态接线增量 (BI-ASM-2026-10-19 批次,双 agent 并发,父卡 rollup closed)

**并发派工模型(首个双 agent 工程)**:文件所有权切分零冲突——Agent-A 独占 packages/tui/**(BI-24.2),Agent-B 独占 packages/core/src/cli/**(BI-24.1),主控持文件租约收口 bin/bi.ts;提交权与台账收口在主控。

| 卡 | 标题 | commit | 状态 |
|---|---|---|---|
| BI-24.1 | 八子命令分发接线(init/session/fork/export/transfer/acp/upgrade/doctor) | 28b6486 | **closed**(Agent-B) |
| BI-24.2 | 行编辑器 REPL 接线(交互主回路) | 28b6486 | **closed**(Agent-A) |
| BI-24 | 父卡 rollup | — | **closed** |

**BI-24.1 落位**:commands/dispatch.ts 查表派发(findSubcommandIndex 在全局旗标后切 argv,子命令旗标不误报 unknown-flag);init=v1 脚手架(.bi/local.toml 幂等不覆盖)/session/fork/export/transfer=接 BI-03 库面/acp=v1 最小握手帧(Content-Length JSON-RPC,注入 IO)/upgrade=v1 锚点循环门(探测 upstream_sync.py,check 不 pull,缺脚本 exit 4)/doctor=接 src/doctor.ts 器官。17 条注入式用例(每命令 happy+边界)。诚实边界:acp 只握手面、init 不含 BI.md 草稿面、upgrade 不含 manifest 自升级链路。

**BI-24.2 落位**:mount/repl.ts——LineEditor(插入/删除/光标移动单行编辑)+ KeyStream(单消费键流,end()=eof 信号)+ PromptView + runRepl 主回路(按键按会话态路由:审批浮层全键 dispatchKey/running 态 Esc→二段取消/idle 编辑);agent-tui.ts 唯一许可扩展(TuiSessionOptions.writer 透传 stdout)。13 条注入键流用例。诚实边界:历史翻页/tab 补全/多行输入归后续卡;REPL v1 纯对话(工具注册表面归后续装配卡)。

**主控收口**:bin/bi.ts 无参=REPL 主路径(配置装配→凭据门→AgentTuiSession(writer=stdout)→InputLoop→KeyStream 真实桥,stdin EOF 经生成器 finally 显式 KeyStream.end(),raw-mode 尽力而为);带参=runBi 分发。**三连真实冒烟 PASS**:①--prompt 无头回归(mimo 答 OK);②管道 REPL 贯通(stdin 逐字符提示行→提交→真实回合→[user]/[assistant] 帧→Ctrl-D eof);③bi session 列出真实会话。装配期接线宣告收尾:**bi 是一台可交互、可持久化、全命令面贯通的整机**。

## 八、npm 发布面 (BI-25.4,2026-10-19 closed)

**BI-25 族立项(批次 BI-ASM-2026-10-19-02)**:BI-25 父卡 + 25.1 工具注册表面(P1)/25.2 acp 完整桥接(P1)/25.3 REPL 增强(P2)三件**立项待开工**(用户指令"全部立项"),25.4 npm 发布面(用户供 token)**直接开工当日闭环**。

**BI-25.4 交付(closed)**:`scripts/npm-pack.ts` 入库(纯拼装,零凭据)——esbuild/turbo 同款平台二进制模式:`@bpfio-yp/bi` 元包(bin/bi.js shim 按平台 spawn)+ `@bpfio-yp/bi-linux-x64`、`@bpfio-yp/bi-darwin-arm64` 平台包(optionalDependencies 自动选装,构建失败整包剔除并进 warnings);LICENSE/README 随包。**发布回执**:三包 `+ @bpfio-yp/bi(-linux-x64/-darwin-arm64)@0.1.0` 全部上 registry。**冷安装冒烟 PASS**:全新 prefix `npm install @bpfio-yp/bi` → added 2 packages(元包+平台包自动选装)→ `.bin/bi --version` → `bi 0.1.0` exit 0 → `.bin/bi session` 真实列出会话。**运行期用户零 Node/Bun 依赖**。token 纪律:`~/.bi-npm-token`(0600,仓库外),发布经环境注入,git grep 零泄漏。

**排障三则(devlog #255)**:①BuildReport 成功态无 ok 字段且为多行 pretty JSON——按行截 `{` 解析必炸,改判据=退出码+失败标志正则;②`npm org create` CLI 不可用(EUSAGE)——@bpfio org 须网页创建,v1 落用户 scope `@bpfio-yp/bi`,建 org 后可迁移;③注册表传播延迟(发布回执≠立即可见),冷安装须轮询等待。

**BI-25 剩余**:25.1/25.2/25.3 三卡 planned 待口令(工具注册表面/acp 桥接/REPL 增强)。

## 九、装配增强批次 (BI-ASM-2026-10-19-02,双 agent,父卡 rollup closed)

npm 迁移(BI-25.4 增补,commit 5ffb2ba):用户网页建 bpfio org → SCOPE @bpfio-yp→@bpfio 重发三包(@bpfio/bi@0.1.0+两平台包),@bpfio/bi 冷安装冒烟 PASS,旧 @bpfio-yp/* 三包 deprecate 指引迁移(Devlog #256)。

| 卡 | 标题 | commit | 状态 |
|---|---|---|---|
| BI-25.1 | 工具注册表面(bin 层 tools 挂载) | ee77698 | **closed**(Agent-D) |
| BI-25.2 | acp 完整桥接(session/new+prompt) | ee77698 | **closed**(Agent-C) |
| BI-25.3 | REPL 增强(历史/tab/多行) | ee77698 | **closed**(Agent-D) |
| BI-25.4 | npm 发布面(@bpfio/bi) | 24c01af→5ffb2ba | **closed** |
| BI-25 | 父卡 rollup | — | **closed** |

**BI-25.1 落位**:cli/toolset.ts buildDefaultToolset(cwd)=read_file(段级 cwd 逃逸守卫)+web_fetch(BI-07.15 器官)+web_search(env 密钥门+TTL 缓存+令牌桶),全 readOnly;bash/写类不挂(沙箱面归后续卡)。主控接线:bin 两路径(--prompt/REPL)挂 buildDefaultToolset。**真实冒烟 PASS:mimo 自主调用 read_file→真实执行→魔数 77 回填作答(rounds=2)——bin 层首次全 agentic 回路**。11 用例。

**BI-25.2 落位**:commands/acp-session.ts AcpSessionConnection——Content-Length JSON-RPC 上 session/new(UUIDv7 落 JSONL)/session/prompt(agent_message_chunk 增量+终帧,链式续聊)/session/end;错误面 -32003/-32004(单飞忙)/-32005(端口)/-32006;stdout 帧纯净。主控接线:runBi 默认惰性 memo buildModelPort(凭据门,homeDir 可注入);端口未注入用例重锚定空 homeDir(修真实 ~/.bi 误读+潜在真实外呼风险)。8 用例。边界:取消/多会话/thinking 帧归后续卡。

**BI-25.3 落位**:repl.ts——PromptHistory(up/down+草稿暂存+越界还原)/tab 补全(ReplOptions.completions 可注入,缺省历史前缀,共同前缀不劈代理对)/多行语义(Ctrl+E 外编回填保换行整体提交,粘贴摊平为边界)。23 用例(13 既有+10 新增,唯一语义变更=外编回填改原样提交)。相邻一行修复:回合收束提示行同步当前草稿。

**排障(devlog #257)**:acp 端口未注入用例原断言依赖真实 ~/.bi——重锚定空 homeDir 凭据门,消除环境依赖与潜在真实外呼。

**门禁:4170 pass/0 fail(217 文件),双 tsc 0。诚实边界汇总**:acp 取消语义/多会话并行、bash 写类工具、REPL 粘贴多行、windows 平台、--embed 资产嵌入、@bi/mcp AcpBridge 跨包合流归后续卡。

## 十、发布修复批次 (BI-REL-2026-10-20,真机面两连修,2026-10-20)

用户真机验收连环揪出两个发布/渲染缺陷,当日双修双发版。两卡均带 pty 真终端探针证据(探针脚本暂驻 /tmp,转正归 BI-27.6/BI-26.4)。

| 卡 | 标题 | commit | 版本 | 状态 |
|---|---|---|---|---|
| BI-25.5 | 发布物编译入口修复(bin/bi.ts 进二进制) | 0391e38 | 0.1.1 | **closed**(F-REL-01 fixed) |
| BI-24.3 | REPL 真机布局修复(行分离+真实尺寸) | 7c9189a | 0.1.2 | **closed** |

**BI-25.5 落位(Devlog #259)**:0.1.0 发布二进制裸跑=USAGE exit 2,无参 REPL 主入口从未进过编译产物——build-bin 编译入口自 BI-23.1 钉在 core cli main(当时仅无头面,选择正确),BI-24.2 为 bin/bi.ts 接 REPL 后无人回头改编译管线,而 npm README 已宣称 `bi # 交互 REPL`。修:临时 entry 改 bin/bi.ts 副作用导入(全相对导入可打包;embed 资产表挂载先于动态导入),build-bin e2e 断言改锁新语义(空 HOME 裸跑→exit 3 凭据门=REPL 装配路径,非 USAGE 分支)。教训:**入口面变更必须同步核对编译管线入口;版本号双源(根 package.json+core VERSION 常量)须同卡同升**。npm 接线经验:publish 经临时 userconfig(0600 用后即焚,token 零落盘);registry 传播延迟轮询消化;装机 --prefer-online 破本机 packument 缓存。本机可用性接线:npm i -g @bpfio/bi + ~/.bashrc 密钥注入块(export BI_MIMO_API_KEY="$(cat ~/.bi-ignition-key)";非交互 shell 触发交互守卫不注入)。

**BI-24.3 落位(Devlog #260)**:用户报告"界面非常简陋、无法完成输入"。pty 探针(40×100 真窗口)复现定位两叠加缺陷:①TranscriptView 状态行与 PromptView 提示行同写虚拟终端最底行——"❯ "(2 格)盖掉"[manual]"前两格,草稿增长逐格吞状态文本(`❯ anual] 就绪`→`❯ hello` 渐进);②终端尺寸硬编码 24×80(TuiSessionOptions 缺省且 bin 未传),提示符钉第 24 行、转录画第 1 行,与真实视口脱节。按键字节流全程正常(UTF-8/回车/回合启动均通)——纯渲染层问题。修:状态条独占 rows-2(kimi 式布局,转录窗收缩 rows-2)、TranscriptView 改读 session.rows 单一来源、新增 AgentTuiSession.resize(rows,cols)(TuiApp/DiffRenderer resize 已有)、bin 注入 process.stdout.rows/columns+SIGWINCH 跟随。备案:投影折行宽仍为构造期 cols(已渲染行不重排)。教训:**挂载层测试全用注入渲染面(onFrame 行集),虚拟终端布局缺陷只有 pty 真机才显形——真人 TTY 面回归必须常态化**。

**终验(装机版 0.1.2)**:40×100 pty 下状态行 `[manual] 就绪` 独占第 39 行、提示行 `❯ hello` 逐键干净渲染第 40 行、零叠写;无头真模型回合 session_done exit=ok。**门禁:4170 pass/0 fail(217 文件),双 tsc 0。**

**策略评估备案(本会话对话产出,未立项)**:①测试充分性=结构层充分(4170/217 文件,每卡带测试,注入式零外呼)/成品层部分充分(BI-21 演练矩阵止步 104 卡时代,23/24/25 三族未入阵;真实点火一次性不可回归;真人 TTY/崩溃恢复/darwin 真机/acp 真客户端/agent 质量评估缺位)→ **BI-26 测试深化族 5 卡方案已提案待口令**;②TUI 生态未向 kimi 对齐(RULE-BI-07 壳层基线欠账盘点:流式渲染/光标可视化/markdown 高亮/样式/候选菜单/多行粘贴/视口工程/spinner/pty 回归九项)→ **BI-27 对齐族 6 卡方案已提案待口令**(轮子首选 kimi pi-tui,备选 DiffRenderer 自研增强);③scripts/ 母体遗产混淆测试面(smoke-tui-*.ts 等引用 vendor/zcode.cjs)→ 归 BI-26 清理卡;④doctor 仍探母体凭据面(open.bigmodel.cn)→ 归 BI-24 族后续卡。

## 十一、生产冲刺批次 (BI-PROD-2026-10-20,第一波,2026-10-20)

用户口令"距离生产还有哪些任务?我们一次性处理完"→ 23 项一次立项(BI-26 测试深化 6/BI-27 TUI 对齐 5/BI-28 执行面 5/BI-29 运维收口 2/BI-30 dogfood 1+三父卡),双 agent 并发+主控线,commit 2a04a9f,版本 0.2.0。

| 卡 | 标题 | 执行方 | 状态 |
|---|---|---|---|
| BI-27.1 | 输入补齐(光标▏/多行粘贴/翻页) | Agent-A | **closed** |
| BI-27.2 | 流式渲染(StreamView+秒数) | Agent-A | **closed** |
| BI-28.1 | bash 工具挂载 | Agent-B | **closed** |
| BI-28.2 | edit/write 工具 | Agent-B | **closed** |
| BI-26.2 | 本地伪端点 bin e2e | 主控 | **closed** |
| BI-26.4 | pty 真人面回归入库 | 主控 | **closed** |
| BI-26.5 | 母体遗产清理(36 脚本+3 workflow) | 主控 | **closed** |
| BI-26.6 | 版本双源同步门 | 主控 | **closed** |

**落位要点**:①执行面上线——buildDefaultToolset 现挂 bash(超时杀/100KB 尾截断/shell-scan dangerous|opaque 标注/spawnImpl 注入)+edit(唯一命中/$& 字面)+write(atomicWriteFile+PathJail 第二层),manual 模式全 ask(实义确认:ask 走三态默认,与 readOnly 无关);②壳层对齐——光标条/粘贴保换行整稿提交/翻页跳页/StreamView 流式预览(80ms 节流可注入时钟)/运行中秒数;③测试深化——本地伪端点(双模态 SSE,echo 回环)驱动 bin 级零网络 e2e + pty 40×100 真人面回归(BI_PTY_E2E 门控,CI 置位);④清理——36 个母体死脚本(引用已不存在的 vendor/zcode.cjs、packages/zcode-tui、../test 等)+3 个母体 workflow 删除,ci.yml 重写为 bi 最小门禁;⑤版本双源同步测试(package.json===core VERSION,漂移即红)。

**排障两条(devlog #262)**:pty 断言 `"anual]"` 是 `"manual]"` 子串必误报,缺陷特征须锚定 ❯;execFileSync 阻塞事件循环会饿死同进程 Bun.serve 伪端点(子进程 fetch 永挂),须异步化。

**门禁:4205 pass/0 fail(220 文件,含门控套件),双 tsc 0,origin=2a04a9f。F-LEASE-28(lease 工具只认 agy 身份)wontfix 备案。诚实边界**:沙箱包装/命令词级裁决归 28.4;余 11 项 planned(26.1/26.3、27.3/27.4/27.5、28.3/28.4/28.5、29.1/29.2、30)。

## 十二、生产冲刺批次 (BI-PROD-2026-10-20,第二波收官,2026-10-19)

用户口令"第二波 开跑"→ 余 10 卡 running(26.1/26.3、27.3/27.4/27.5、28.3/28.4/28.5、29.1/29.2),双 agent 并发(A=tui/B=执行面)+主控线。**事故与恢复**:首批双 Agent 死于 10-18 15:21 会话中断(僵尸记录,TaskStop 报 startedAt.getTime=F-HARNESS-29 wontfix);主控盘点断点遗产后派 A2/B2 续跑,零返工。三段提交:13884f4(主线四卡)→3525fca(B 侧执行面)→本提交(A 侧 TUI+集成接线)。

| 卡 | 标题 | 执行方 | 落点 |
|---|---|---|---|
| BI-29.1 | doctor 去母体化(五检查项) | 主控 | 13884f4 |
| BI-29.2 | upgrade 自升级真链(BI-20.7 上妆) | 主控 | 13884f4 |
| BI-26.3 | 崩溃恢复演练(e2e-drill-m 6 用例) | 主控 | 13884f4 |
| BI-28.3 | 权限模式产品化(/permissions+控制器) | Agent-B2 | 3525fca |
| BI-28.4 | 执行面真实任务演练(exec-drill) | Agent-B2 | 3525fca |
| BI-28.5 | grep/glob 工具(rg 语义) | Agent-B2 | 3525fca |
| BI-27.3 | 富文本转录(markdown+styled) | Agent-A2 | 本提交 |
| BI-27.4 | 候选与命令菜单(candidate-menu) | Agent-A2 | 本提交 |
| BI-27.5 | 视口裁定+resize 折行宽+滚轮历史 | Agent-A2 | 本提交 |
| BI-26.1 | 演练矩阵 L 域(e2e-drill-l 9 用例) | 主控 | 本提交 |

**落位要点**:①运维面——doctor 五检查项(配置装载/凭据门 resolveModelPort 同链/所配 provider base_url 网络/OsSandbox 真探/工具注册面),open.bigmodel.cn+ZHIPU 面+pandas 遗产退役;upgrade 走 manifest→sha256→native-swap 真链(--manifest-url>BI_UPGRADE_MANIFEST_URL>exit 4),python3 upstream_sync.py 替身退役;②权限面——PermissionSessionController+`/permissions`(show/mode/grant/deny/revoke/clear),config [permission] mode→门禁三态(default/plan→manual)+规则表灌入(ask 缺省语义剔除),switchMode 不清会话授权(显式裁决强于三态),bin/main/headless 三处 gate 注入缝,REPL `/` 行拦截走本地命令面(不入模型回合不落 JSONL);③壳层面——markdown 富文本进转录(StyledTranscript 双消费 L1,latex/mermaid 围栏透传)、斜杠候选菜单(内置+~/.bi/commands+<cwd>/.bi/commands 发现,Tab/↑↓/Enter/Esc)、视口裁定=inline REPL(RULE-BI-07 kimi 基线 ADR)、resize 折行宽双侧跟随(BI-24.3 备案限制消除)、SGR 滚轮历史(±3 行,归零实时锚底);④演练面——e2e-drill-l 五链(toolset 真面/model-port 装配/agent-tui 挂载/acp 桥全生命周期/八子命令)+e2e-drill-m 四链(JSONL 撕裂痊愈/meta 残缺拒载/双 manager 并发/kill -9 真子进程)。

**演练抓真缺陷三则**:28.4 演练暴露 bash 输出泵在子进程管道突闭(嵌套 bun test 复现)时 releaseLock 抛 TypeError 杀死结果管线(已修);28.5 grep include 改 rg 语义(无斜杠按 basename);27.3 修 markdown.ts JSDoc 内 `*/` 致命解析断点+transcript-styled 多行溢格。

**技术裁决**:acp 演练输入流必须 pull 式 ReadableStream 按真实协议顺序供帧(write 回调反压注入僵死读泵);prompt 回执只含 stopReason(文本走 session/update);fake-endpoint 双协议按 URL 路径自适应无 mode 选项;worktree 验证提交态前必须 bun install。

**门禁:4310 pass/0 fail(228 文件,50953 expect,含 BI_PTY_E2E=1)+root tsc 0,origin=本提交。诚实边界**:自定义斜杠命令执行面未接线(候选可补全,提交回"执行面归后续卡"应答);B2 备案 headless permissionMode 仍可经注入面覆盖;BI-30(dogfood 用 bi 修 bi)为下一波开工卡。

## 十三、BI-30 dogfood 生产标冲刺 (2026-10-19,进行中)

用户口令"BI-30 dogfood 打生产标开工,另关闭 github bi 项目 ci 任务"。执行形态:**bi 本体修 bi**——bin/bi.ts 无头真模型(mimo-v2.6-flash,messages 协议)驱动,合成 HOME=/tmp/bi-dogfood(config yolo,密钥仅经 BI_MIMO_API_KEY 环境注入),三张真实工单分三实例,文件分区并发。

**前置**:①GitHub CI 已关(`gh workflow disable` → disabled_manually;关停原因留档:ubuntu-latest 上 24 fail/19 errors 全为环境依赖测试——bwrap 探针套件/buildBin 真实构建 e2e/伪端点 openai 模式 e2e,5 连败 ~40s);②`bi doctor` 本机 5/5(凭据门/网络级联语义实证);③无头冒烟 finalText="就绪" 全链路通。

**dogfood 发现 #1(主控即时修)**:无头回合上限恒 8 且 CLI 不可调,真实工单两轮撞墙("模型回合超过上限 8/24")→ 补 `--max-rounds` 全局旗标(args.ts 正整数校验 + main.ts CLI 优先于 deps 透传 + 6 测试用例)。

| 卡 | 工单 | 实例 | 状态(实例自报,主控复验中) |
|---|---|---|---|
| BI-30.1 | 自定义斜杠命令执行面(agent-tui `{prompt}` 契约+bin 注册表+expandCommand 接线) | A(断点续作,前任两轮撞回合上限留树 +254 行) | 完成:tui 520/0(新增 3 用例:prompt 入回合/string 本地回归/!ok 展开失败),双 tsc 0;custom-commands 只消费未改 |
| BI-30.3 | --output-format 真消费(白名单 +["text"],headless emit 形态门控,main 接线) | B | 完成:args 19/0、headless 12/0(新增 5)、bin e2e 2/0、core tsc 0;text 形态 out 恰为 finalText 一段 |
| BI-30.2 | 测试可移植性门控(bwrap/buildBin/伪端点 openai e2e 三簇) | C | 后台进行中 |

**并发风险留痕**:A 为自证 4 条失败属环境既有(os-sandbox landlock/bwrap、e2e-drill xlsx 链),在共享树做过 stash→纯净 HEAD 复跑→pop,窗口期与 B 写 args.ts 相撞,pop 中止后 A 依 /tmp/bi30-backup/ 备份恢复并集(A/B 双报告互证);主控全门禁复验安排在 C 完场后,含泄漏扫描。

**台账通道**:SSH task_query 四连超时(NAS 雪崩,历史自愈),BI-30 卡面字段未取到前不做破坏性 upsert(TOOL-2);devlog_record 待通道恢复即补。

### 十三·终态(BI-30 dogfood 关账,2026-10-19)

三实例+主控脚手架全部落盘,origin 推送至 94cc84b。**BI-30.1/30.3/30.2a 完成,BI-30.2b 断点留档**。

| 卡 | 终态 | 证据 |
|---|---|---|
| BI-30.1 斜杠命令执行面 | **closed** | agent-tui `{prompt}` 契约(string=本地 system 行不变;{prompt}=入模型回合)+bin 完整注册表+expandCommand 接线;tui 520/0;hy3 评审契约逐条符合 |
| BI-30.3 --output-format | **closed** | 白名单 ["stream-json","text"];headless emit 形态门控(text 只落 finalText);main 接线;args+headless 31/0 |
| BI-30.2a bwrap/buildBin 门控 | **closed** | `Bun.which("bwrap")`+`Bun.resolveSync` 能力探测,test.skipIf/describe.skipIf 门控;四场景矩阵(本机全绿 50/0;模拟缺失→结构化 skip 不误报);**buildBin 根因=ci.yml 无 bun install → bundler 解析缺 smol-toml/picomatch**(测试门控绕开,CI 已关故不再追) |
| BI-30.2b 伪端点 openai e2e | **断点** | C2 三轮被超时/关账截停,零编辑;诊断线索:失败路径疑似 DeepSeekAdapter(openai kind 适配器选择链);简报/日志全量入仓 docs/dogfood/2026-10-19-BI-30/ |

**门禁终态:4320 pass/0 fail(228 文件,BI_PTY_E2E=1),双 tsc 0。提交链:d833f1f(docs)→c5b28dd/a028072/04c7671(语料)→94cc84b(代码,10 文件 +502/-48)。**

**dogfood 方法论沉淀**:①bi 本体修 bi 可行且高效——三工单实改 502 行,主控只出简报+验收;②无头回合上限须可调(--max-rounds),真实工单 8 回合必撞墙;③并发实例共树,互踩 stash 是真实风险(A 曾为自证 stash→pop 撞上 B 写 args.ts,靠备份恢复并集);④codebuddy 免费模型(hy3/step-5-preview)接评审/分析类子任务,--allowedTools/--disallowedTools 静默失效 bug 只用 --tools;⑤台账通道故障时,结论+简报+转录+日志全量先落仓(docs/dogfood/),台账恢复后补记。

## 十四、codebuddy 派工批次:CI 转绿 + TUI 三快赢 (2026-10-19,当日第三波)

用户口令"派发2-4个agent解决TUI对齐与BI-30批次"→"只通过codebuddy派发,不用opencode"→"下批开工:继续派codebuddy"。执行形态:**主控(ZCode)只做策划与验收,7 单全派 codebuddy hy3 免费模型**;纪律 SSOT=~/.agents/skills/dispatch/SKILL.md(私有仓 bpfio/dispatch,同日三次实战升级)。opencode 两连 429 僵尸(glm/deepseek 免费档大简报开局 Rate limit exceeded 不重试空转 40min)后被用户裁定弃用,存档教训(若解禁:--pure 剥插件系统提示+3 分钟看门狗+session 按 --dir 隔离)已入 skill。

### 十四·一 CI 转绿链(BI-30.2b + CI-GREEN-1,closed)

**BI-30.2b 真根因(十三节断点的反转)**:非 DeepSeekAdapter——**ci.yml 无 `bun install` 步骤**,裸跑 `bun test` 进 auto-install,解析不了仅声明于子包的 workspace 嵌套依赖(smol-toml/picomatch);失败发生在 import 解析期(openai 用例 2.12ms,父进程内 import;anthropic 用例走子进程 spawn 的完整 auto-install 故过)。修复 +2 行(D3)。**第一层修复揭出第二层洋葱 3 项**(D4 修):①D5 沙箱探针 errorKind 双源漂移(CI 实报 binary-missing 不在测试硬编码白名单)→ os-sandbox.ts 导出 SANDBOX_PROBE_ERROR_KINDS 常量、测试改引用,单一事实源;②③BI-21 链4/5 根因 openpyxl 缺件(gen_drill_xlsx.py/xlsx_audit.py)→ ci.yml +pip install openpyxl,链5 纯连带。

**CI 实跑验收**:重开 workflow(disabled_manually→enabled)后 run 39220601240 全绿(伪端点 openai 模式 pass 21.90ms 近期首次)→ TUI 批次推送后 run 39230194421 再绿。诊断手法沉淀:**worktree 离线复现法**(`git worktree add --detach /tmp/sim <commit>` 得无 node_modules 干净树,复现 CI 条件→定位→同树验修复→丢弃);**决定性证据源不可禁**(D1 简报继承"禁联网"约束致代理假设被 CI 日志证伪——好过程错结论,责任在主控策划)。

### 十四·二 TUI 三快赢(TUI-ALIGN-1 差距分析 + TUI-ALIGN-2 实现,皆 closed)

D2c 差距分析(7 维矩阵双侧 file:line):**转录投影层已同构对齐**,"简陋"集中在交互输入面,主因 top3=无转录搜索/无文件@补全/编辑器弱。三单实现(编排:A/B 文件面不相交并行;C 与 B 同碰 repl.ts 串行):

| 单 | 落点 | 要点 | 测试 |
|---|---|---|---|
| D5 转录搜索 | mount/transcript-search.ts(新,192 行)+agent-tui(+85) | ANSI 剥离语料+正则命中+增量缓存(吸收 alt-screen-search 机制);Ctrl+F 开/Enter 下一/Ctrl+G 上一/Esc 复原,wrap-around | 新 11/0,包 531/0 |
| D6 文件/路径/@补全 | mount/file-completion.ts(新,311 行)+candidate-menu(+75)+repl(+71) | readdir 降级+fuzzy 评分移植+Tab 裁决(唯一整稿/多候选公共前缀/无候选回退历史,不抢原交互) | 新 20/0,包 551/0 |
| D7 编辑器强化 | repl(+217/-31)+cjk-width(+101)+mount/editor-history.ts(新)+agent-tui(+5) | Intl.Segmenter 字素光标+Emacs 键位(KillRing/UndoStack,ctrl-a/b/k/u/w/y/z)+长行横滚 layoutPromptLine+ctrl-f 转发 agent-tui.handleKey(经 searchActive getter) | 新 23/0,包 574/0 |

### 十四·三 派工方法论沉淀

①主控策划三问(入 skill):最便宜证据源先摸清(勿一刀切禁网)/只读 vs 改码权限与验收先定/CI-only 先 worktree 复现;②codebuddy print 模式全程缓冲终态一次性输出,运行中 0 字节是正常态,判终态看 exit 标记;③写模式 -y 可控,零实质越界;理想行为样本:D4 抓出主控简报文件路径笔误,核实后正确修复并显式申报偏差;D5 申报跨工单集成缺口(repl→handleKey 转发)折入 D7 简报收口;④并行编排看文件面相交:不相交并行、相交串行,集成缺口显式指派归属;⑤台账闭环:发起即 running(通道/模型/sessionId),完成即 closed+commit_hash+proof_link。

**门禁终态:4374 pass/0 fail(231 文件,51206 expect,BI_PTY_E2E=1)+双 tsc 0(自十三节 4320/228 增 54 测试)。提交链:832da15(D3)→429562c(D4)→8267972(docs)→148ac0e(D5+D6)→edb0eeb(D7);CI 全绿 run 39220601240、39230194421。派工档案:docs/dispatch/{2026-10-19-wave,2026-10-19-tui-align2}/(简报+报告全档)。**

**诚实边界**:ctrl-f 让位搜索(非 readline forward-char,前移用右箭头);D7 申报的"越界"为其自身简报留档(untracked docs),无害保留;TUI 剩余"部分"差距(支柱二子命令面 bi vis/config、渲染布局树)未动;BI-30 里程碑卡仍 planned。

## 十五、TUI-ALIGN-3 第一波:子命令面三单并发 (2026-10-19,当日第四波)

用户口令"下批开工,依然通过dispatch派codebuddy,派出3个并发任务"→完工后"已完工任务验收落盘,文档写入devlog和logbook,推送至bpfio/bi"。执行形态:**主控只做策划与验收,3 单并发全派 codebuddy hy3**(B1/B2 写模式 -y,B3 只读 --tools "Read,Grep,Glob");文件面互斥划界(B1=main/headless/args 面,B2=export 面,B3 零写入),简报互写禁动边界,亲验零互踩。

| 单 | 工单 | 落点 | 要点 | 测试 |
|---|---|---|---|---|
| B1 | BI-20.2b flag 装配消费 | main.ts(+31)/headless.ts(+20)/agent-file-addir.test.ts(新) | --agent-file 读 Markdown 作系统指令前置为首条 {role:"system"};--add-dir 逐项存在性+目录校验(缺失/非目录结构化 exit 2)透传 HeadlessResult;重复 flag 沿用 args 既有 duplicate-flag | 新 6/0(主控复跑) |
| B2 | BI-20.3 export --format html | export.ts + export/html-exporter.ts(重写)+ ansi-to-html.ts(复用)+ dispatch.ts usage | 单文件自含 HTML:内联 CSS+Dark 默认+工具卡 <details>+<pre><code> 纯文本+全量转义(<script> 用例钉死);白名单终态 [markdown,json,html] | cli 侧 +5 例、export 侧 12 例 |
| B3 | BI-20.5a vis 只读侦察 | 报告 docs/dispatch/2026-10-19-subcmd1/b3-vis-recon-report.md | kimi vis=独立 app(Hono 回环+8 tab SPA);bi 数据三栏表(列表/分支树/消息流/工具配对直接可得,耗时/token 账本缺失);v1 提案=列表+分支树+消息流(M)+工具配对(S);**纠正主控前提**:令牌轮转/多网卡属 kimi web 命令不属 vis | 只读零写入 |

**关键发现:fc30d5f 孤儿实现**——BI-20.3 导出库(双主题+tool-renderers)早期已建但 **CLI 从未接线**(推送前 HEAD 的 EXPORT_FORMATS 仅 markdown/json),"库存在≠功能存在,验收要查接线面"。B2 实际动作为重写导出器+补接线,并删除零外部引用的 tool-renderers 死码(全仓 grep 仅旧 html-exporter 自引),历史可溯 fc30d5f。

**方法论三条(本波新增)**:①主控建简报前必须 `git log <目标路径>` 核实 HEAD 现状——本波 B2 简报误写"新文件"实为已存在,B2 临场改判(删死码+复用 ansi-to-html)处置合格,缺口在主控材料;②本机 gh 缺省解析到无关仓库(kingsword09/zcode-cli),查 CI 必须 `gh run list --repo bpfio/bi` 显式指定;③门禁跑在工作树而提交面可能小于门禁面——主控 add 遗漏 export.test.ts 即属此类,提交内容必须等于门禁内容(本波由补提交收口)。

**门禁终态:4370 pass/0 fail(231 文件,51240 expect,BI_PTY_E2E=1)+双 tsc 0(自十四节 4374 净减 4=tool-renderers 死测试删除)。提交链:db0fd75(B1)→9591d37(B2)→test 补提交→docs;代码门 CI run 39237969413 绿。派工档案:docs/dispatch/2026-10-19-subcmd1/(简报×3+侦察报告)。**

**诚实边界**:--add-dir 未进工具访问面(toolset 单根,校验+透传+备案,待后续工单);html 导出 Dark 单主题(fc30d5f 旧库曾双主题,重写收敛,历史可溯);kimi agentFiles 复数 vs bi 单文件契约差异备案;B3 侦察仅提案,BI-20.5b 未开工待派;codebuddy print 模式无 sessionId 回显,续作句柄不可用(以简报重派替代)。

## 十六、TUI-ALIGN-3 第二、三波:子命令面收官 (2026-10-19,当日第五波)

用户口令"继续派单"→"step-5-preview 模型也免费(授权转正)"。执行形态:主控策划+验收,四单派 codebuddy(C1/C2 hy3 并发,C3 step-5-preview 串行续单),验收**新铁律四步**(diff 逐行/门禁复跑+提交面=门禁面/真机冒烟/抽样核实)首次全流程执行,当场抓出两处问题并修复。

| 单 | 工单 | 落点 | 要点 | 验收 |
|---|---|---|---|---|
| C1 | BI-20.5b bi vis v1 | cli/commands/vis.ts(新 656 行)+dispatch.ts 注册 | Bun.serve 会话可视化:列表/消息流/分支树/工具折叠卡;安全矩阵=缺省回环免令牌、0.0.0.0 归非回环强制 BI_VIS_AUTH_TOKEN、401 先于 404 防枚举、decode 后白名单防穿越、前端全 textContent 零 XSS 面 | 真机九路径冒烟(200/404/400/405/拒启 exit1/令牌 401→200) |
| C2 | TUI-ALIGN-4a 键位注册表 | mount/keybindings.ts(新 240 行)+repl/agent-tui 消费+bin 装配 | 16 动作默认表=现硬编码逐条对照(**行为零变化**);~/.bi/keybindings.json 覆盖,规范化(ctrl-/+ 统一)/三类结构化忽略/冲突后到覆盖 | 真文件冒烟:改绑生效+conflicts 报出;pty 回归全绿证零漂移 |
| C3 | TUI-ALIGN-4b 鼠标定位 | mount/mouse-cursor.ts(新 89 行)+diff-renderer SGR 解析+cjk-width 最小扩展 | 左键按下→mouse-click(0 基);字素步进定位(宽字符右半对齐起点);光标条 ▏ 占列扣回;多行摊平映射换行序列起点;滚轮(BI-27.5)原样保留 | 真实 SGR 字节链路冒烟七例全对;**step-5-preview 首单** |

**验收四步实战战果**:①C2 装配路径偏差(cwd 相对→简报要求 ~/.bi 用户级)主控亲修(home 优先+项目兜底);②CI run 39244075154 红屏→定位为**存量 flaky**:uuid7 时钟对齐测试上界未留 RFC 9562 §6.2 单调伪推进容差(10000-id 批量用例同毫秒超 4096 条,内部时钟被推到墙钟前 1ms),加 10ms 容差+机理注释,5 连跑全绿;③**孤儿教训延伸**:C1 发现第二个孤儿 vis-handler.ts(736369d,接了测试未接 CLI)——藏在 src/web/ 而非目标路径 cli/commands/,简报预检只查目标路径不够,**须按功能关键词全仓 grep**。

**门禁终态:4437 pass/0 fail(234 文件,BI_PTY_E2E=1)+双 tsc 0。提交链:32c2ff6(C1)→898cbe1(C2)→1b292a1(deflake)→6e63f94(C3);CI 全绿 run 39244807093(1b292a1)。派工档案:docs/dispatch/2026-10-19-subcmd2/(简报×3+报告×3)。**

**诚实边界**:vis 生产接线 attachSignals:false(默认 SIGINT 终止而非优雅停服,本地只读服务无状态,外观级备案);转录区点击 v1 仅忽略(无选区/跳转);Esc 拒绝审批保留硬编码兜底未入注册表;多行草稿按摊平行换算,不做视觉行↔逻辑行映射;kimi vis 的 8 tab 全家桶明确不做(v1 封顶)。

### 十六·附 终验补遗 (2026-10-19,用户口令"实质性验收后落盘")

C1/C2/C3 已按验收四步闭卡;本轮补最后一层实质验收:**真浏览器渲染测试不可执行**——宿主机无 Chrome/Chromium(browser-use 运行时报 "No installed Chrome or Chromium executable"),bi vis 的 DOM 渲染面验收止步于 HTTP+结构断言级,如实备案为环境边界。可做的补位检验已做:内联 JS 经 bun build 解析与 node --check 双解析器验证通过;实服页面 `src=`/`href=` 计数为 0(零外链声明在实服产物上复核)。REPL 输入面真机冒烟同样受环境限制(无 dogfood 密钥不可真启 REPL),以 pty 套件(BI_PTY_E2E=1 全绿)为证据链。**待环境具备时的两件补测**:装 Chromium 后浏览器实测 vis 渲染交互;配置凭据后真 REPL 手感(键位改绑/鼠标点击/搜索)。

## 十七、ORGAN-WIRE 清账战役:器官装配 W1 (2026-10-19,当日第六波)

用户口令"随便点一个问题就是未装配状态,对照台账全面梳理,全部完成,让 bi 成为可用的 cli agent"。**全面审计定案:12 个器官在库、有测试、零装配**(context 16 文件/subagent 7 文件为首),全部是 BI-05/07/08/11/16/21 族早期批量波的"最后一公里"欠账。处置:9 项装配(4 波,headless 循环面跨波串行防互踩)+ 5 项诚实备案(media 无摄入面/BI-20.1 已被 BI-28.3 覆盖核心语义/login·web 无生态/渲染树 ADR/jobs 无长驻场景),14 卡入台账。

### 十七·一 双节点开通(xhub)

用户指定 xhub=192.168.1.22。实测开通:SSH 免密(ssh_config 别名)、codebuddy 2.169.0 同版、免费模型真跑、bun 1.3.14 对齐(顺带 sudo 装 unzip)、仓库 rsync 镜像+node_modules、远端测试实测通过。**关键发现:免费模型 429 限流按节点计**——本机 hy3 打满(23:13 重置)时 xhub hy3 正常,派工纪律升格"限流即切换节点重派,不是等待";进程探针改 ppid 链+trace mtime(进程标题重写会骗过 grep,当日踩坑两次)。**额度政策(用户裁定):hy3 双节点优先,step-5-preview 对额度消耗大,降为双节点皆 429 时的兜底**。

### 十七·二 W1 三单(工具面/子命令面/循环面)

| 单 | 卡 | 落点 | 要点 | 验收 |
|---|---|---|---|---|
| D2 | BI-05.2+CLI-CONFIG | dispatch.ts+commands/config.ts(新) | bi init 接 rules/init-service(栈检测+BI.md 草稿,已存在不覆盖,检测失败诚实标注);bi config get/set/list——键面=schema 标量叶推导(42 键零漂移),写回复用 writeback 注释保留引擎 | 真机:get 新键/set 环写/未知键结构化列出全键/init 草稿生成 |
| D3 | BI-08.1+11.1+21.1 | headless/main/schema/verifier | 工具输出 64KB 有界截断+端点脱敏+完工自验闸,**config 门控缺省全关,缺省路径逐字节等价**(17 根键回归钉死) | 43 新测试;缺省等价证明(off 原样穿越/凭据原样);真机 config 读新键 |
| D1 | BI-07.1+07.10 | toolset.ts+interaction/**@xhub** | edit 8 级阶梯弹性匹配(1 级精确路径逐字节不变,命中附 matchLevel)+ask_user_question 条件注册(缺省 8 件面零变动)+headless 结构化降级(不悬挂不抛) | 全仓 4515/0×2;exec-drill 全链路真循环绿 |

**D1 两段史**:首派本机 hy3,35 分钟死于 429(残骸 stash×2);换 xhub hy3 重派,同简报同模型一次成型,且方案优于残骸版(条件注册绕开改 exec-drill 期望)。残骸清理教训:**stash 面=污染面**——首撤漏掉 exec-drill.test.ts,导致全量门禁一次假红(与后续真 flaky 叠加混淆)。

### 十七·三 意外渔获:session 并发竞态(数据丢失级,主控手术)

W1 收尾全量门禁间歇红(7/8 绿),捕获定性:**BI-26.3 双 manager 同会话并发 append,一条条目被当"崩溃残留"截掉**——`#appendLine` 的残留截断用本写者过期 cleanLength,误杀并发写者刚落盘的完整条目。修复:截断前重解析全文件,解析成功则以新净边界为准(保留并发数据,只截真撕裂尾巴),解析失败才回退旧口径;+20 轮并发风暴回归。修后全量双连绿。竞态为存量(当日三单均未碰 session 层),属真实数据丢失隐患而非测试问题。

**门禁终态:4515 pass/0 fail(241 文件,BI_PTY_E2E=1)+双 tsc 0,双连跑确认;CI 绿 30814b0。提交链:e401039(D2)→276e847(D3)→f337b70(D1@xhub)→30814b0(session fix)。派工档案:docs/dispatch/2026-10-19-organ-wire/(简报×4+报告×4+diff 存档)。**

**诚实边界**:三开关缺省全关(0.3.0 再议默认值策略);spill 落盘未接线(无 logDir 面);回注模型的 tool_result 错误文本不脱敏;verify 失败复用退出码 1;ask overlay/TUI 面归 W2-D4;cli/sub/init.ts 平行未接线实现待清理;本机 hy3 额度 23:13 重置前单节点运转。

## 十八、ORGAN-WIRE 战役收官:九器官全装配 (2026-10-19 深夜,W2 后半+W3+W4)

用户裁定"step-5-preview 额度消耗大,降兜底"后,余下五单全走 hy3 双节点轮转。本段跨夜间额度窗口:本机 hy3 两次 429、xhub hy3 一次 429,靠"限流即换节点+定时探针自动重派"清完。

| 单 | 卡 | 落点 | 要点 | 验收 |
|---|---|---|---|---|
| D7 | BI-05.3 | headless/main/schema+context 消费 | **context 家族分级**:4 轻接入(time-context 时间注入/date-change-sensor 跨日披露/tool-result-pruner 二级修剪/window-manager 条数裁剪)+**10 重逐条归档**(compactor 需 summarizer 端口/window-manager 完整体需 token 水位等,一句话理由备案);[context] 挂载分区缺省全关 | 25 新测试;xhub 2 失败本机复验=openpyxl 环境项;全仓 4601/0 |
| D8 | BI-16.2+07.7 | toolset/main/schema/bin | run_ptc_script(只读五件白名单,PtcRunner knownTools+executor **双重拒绝**,30s/64 次有界)+cron_schedule/list/remove(触发归 host 诚实备案);[ptc]/[cron] 挂载分区缺省关 | 16 新测试;**主控抓语义漂移**:runBi `h.tools??[]` 被改成 `??全量默认工具集`,收紧回仅 ptc enabled 才构建 |
| D9 | BI-05.1 | headless/main/schema+memory 消费 | Dream 记忆:会话收尾沉淀(.consolidate-lock 原子锁+append-only BI.dream.md)+启动注入(systemInstruction,与 --agent-file 共存顺序 indexOf 钉死);[memory] 两开关缺省关 | 23 新测试;xhub 2 失败 stash 实证=openpyxl 环境项;全仓 4621/0 |

**派工通道演化(本段新沉淀)**:xhub 的 nohup 后台姿势神秘失效(sleep 可活但 runner 不启),换**本地后台+前台 ssh 持久通道**(进程树根植本机,完成自动通知,产出直落本机)——从此远端派工不再依赖远端后台语义。

**战役总记分**:14 卡全闭(9 装配+5 备案);12 单派工(hy3×10+step-5-preview×1+429 重派×1)+主控手术 4 台(session 竞态/uuid7 deflake/D6 剪贴板管道/D8 语义漂移收紧);门禁 4621 pass/0 fail(253 文件)+双 tsc 0;提交链 1ffe666→6f65667→7102599→783c870→91dae53+W1/W2 前段,CI 全绿贯穿。

**诚实边界(全战役)**:所有新行为 config 显式开启才生效(缺省逐字节等价,九单一致);[context]/[verify]/[subagent]/[ptc]/[cron]/[memory] 六个挂载式分区不进 bi config 42 键面(手工 TOML 才能开,bi config 结构化键面增强归后续);PTC 定时触发/cron 触发/ask overlay/bi dream 手动触发/doctor 健康面/Spill 落盘等宿主环能力归后续卡;context 十重器官归档件各附建议卡。
