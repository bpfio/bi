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
