# bi 研发台账 DEVLOG (主控编纂版)

> **生成**:2026-10-17 由主控 agent 从 logbook 台账 (project=bi) 与 bpfio/bi 仓库 git 链编纂落盘。
> **口径说明**:logbook `export_markdown` 全量导出为 1861 行(约 280KB),超过服务端大响应序列化上限且 SSH 强制命令通道无法回传服务端文件(见 finding LOGBOOK-EXPORT-1);本文档为可验证数据编纂版——批次纪要全文照录 + 闭环卡台账(逐卡 commit 可回溯) + 裁决/规程/发现索引。全量 175 条手记正本在 logbook,向量检索可达 (devlog_search)。

---

## 一、批次纪要 (methodology_notes 全文照录,批次 BI-DEVPLAN-2026-10-16)

会话演进(2026-10-16,续 #143):1. 台账完整性审计——109/109 对齐,5 处优先级漂移已回写 (Devlog #140);2. RULE-BI-01~06 工程红线入库;3. MCP 超时根因=共享 stdio 连接雪崩,稳态<1s,timeoutMs 已调 180s 重连生效 (Devlog #141);4. 完整性定性:logbook=台账骨架,devplan 文档级细化设计只在仓库 devplan.md;5. 开发就绪定稿=三件套模型(台账调度+devplan 设计+大典定位),每任务 running→施工+bun test→closed+hash 循环,开工顺序 BI-01→BI-01.1→BI-03→BI-02→BI-06→BI-06.1,仓库基线为 zcode 母体 273 文件 (Devlog #143);6. 【已办结】109 条细化设计回填任务 notes——devplan.md v1.1 程序化解析(WBS+映射矩阵,处理 \\| 转义与裸 | 断列),notes 总量 69,269 字符(目标落位/设计验收/上游轮子/复用评估),11 批 bulk 单事务全落库,parent_id 87 项归一、task_type 归一 feat×108+verify×1,优先级对账零分歧(P0×38/P1×69/P2×2),台账自此自洽可独立驱动开发 (Devlog #144);7. 新发现:SSH 通道对 >50KB 大响应必超时(中小响应秒回),重查询需字段投影或按父任务分块,大响应分帧缺陷待 bpfio/logbook 上游修复;devplan.md 映射矩阵 BI-01.2/BI-06.9 两行为误粘 WBS 副本(信息无损,已备案);未办结:export_markdown 不含手记章节(服务端缺口);8. 会话状态总存档 #3 收官 (Devlog #145):台账自洽恢复点+缺陷台账(SSH 大响应/误粘行/export 缺口)+工具资产提示(/tmp/lb_rpc.py、/tmp/bi_backfill.py 为易失临时文件,方法论在记忆文件可重建),开工待命 BI-01。

【第 12 条·会话存档 #4 2026-10-16】审计+基线裁决收官恢复点:114 任务全 planned(P0×38/P1×73/P2×3),六段式 notes+边界声明;发现项 8 条(open:AUDIT-6/8);升级追踪四项布局(同步引擎/大典版本化/RULE-BI-06 增补/母体硬分叉)待用户立项;预算口径 1200万~2200万 tokens 待 BI-01 实测校准;/tmp 审计资产易失方法论已录;开工 BI-01。详见 Devlog #149。

【第 13 条·总体策略定版 2026-10-16】双基线策略入库 RULE-BI-07:功能/架构基线=清华 ZCode(apps/zcode-cli 30 包工作区+19 平台包),CLI/TUI 壳层基线=Kimi Code CLI;kimi 兼任「完整 CLI 产品装配/集成参考」(apps/kimi-code 接线序,仅取结构与接线序,不改各卡轮子归属);kimi 主基线提案经结构核验否决(18 包单应用 vs 49 包平台);zcode-app-cli 维持零代码吸收;BI-01 卡已追加总体策略注记。详见 Devlog #150。

【第 14 条·会话存档 #5 2026-10-17】双基线总体策略四件套定版(RULE-BI-07/BI-01 注记/第 13 条/Devlog #150);#122 误覆盖事故破案并全文恢复((project,task_id) 幂等键,TOOL-1 立案,devlog 写入规程=不带 task_id+分管道串行);114 任务全 planned(P0×38/P1×73/P2×3),findings open×3,零阻塞;升级追踪四项仍待立项;开工待命 BI-01。详见 Devlog #151。

【第 15 条·会话存档 #6 2026-10-17】/tmp 台账底册 57 文件持久化迁移至 /home/yupeng/bi-ledger-ops/(与仓库平级不纳 git,README 速查,防 BI-01 重组误删);git 凭证存储迁 ~/.git-credentials-store 且 ~/.gitconfig 同步验证生效;记忆路径引用全量改址。台账基线不变,开工待命 BI-01。详见 Devlog #152。

【第 16 条·启动前最终审计与升级追踪立项 2026-10-17】用户终检六项全部办结:①双基线覆盖矩阵——zcode 49 包(20 驱动/14 零码/12 定位外)+kimi 18 包(核心 10 全覆盖)功能级无缺卡,残差全为锚点级入 AUDIT-9(19 项增补+待议清单);②五源吸收——5 张回填卡(BI-03.7/06.10/07.15/11.1/19.8)精确补齐前审缺口,pi 残差仅 pi-env,无需新建复刻卡;③冲突排查无阻塞项,5 处集成接缝消歧指令入 AUDIT-10(调度四件套委托/双 plan 统一/双沙盒 substrate/文件历史双轨/ACP+凭据单仓);④升级追踪能力当日落地:BI-00/00.1/00.2 立项,upstream_sync.py v1 实测(record 6/6 树,check 首跑即探测 opencode/dhs/pi 三树 upstream-moved),锚点双落盘+大典卷首版本化(commit 55f6c02),RULE-BI-06 增补/RULE-BI-07 销项/RULE-BI-08 新立(母体硬分叉);⑤台账 114/109 双射零缺失;⑥就绪:Bun 1.3.14/Node 24.18/Python 3.14.4/git 干净。新缺陷 TOOL-2(task_upsert 省略字段置空,规程=全字段回填)。台账 117 任务,BI-00.1 closed,findings open×6,零阻塞,开工待命 BI-01。详见 Devlog #153。

【第 17 条·会话存档 #7 2026-10-17】文档验收落盘与远端同步收官:①仓库文档四件验收通过(大典卷首锚点块/UPSTREAM_ANCHORS.md/upstream_sync.py+anchors.json/README 增补),devplan.md 维持只读正典零改动(diff 8e6f141→55f6c02=0,BI-00×3 依 #146 先例台账直立项);②RULE-BI-09 文档检索分级铁律入库(三级检索,禁常规全量复读,全局规则 15 条);③推送 bpfio/bi:8e6f141..55f6c02,origin/main 对齐;④媲美性评估留痕:功能机制对等高信心/打磨对等需 2~3 迭代周期/BI 垂直与智谱生态超出;⑤记忆链延至 #154。台账终态 117 任务+findings open×6+规则 15 条,恢复点就绪,待命 BI-01 开工。详见 Devlog #154。

【18. 开工执行与三工位定型 2026-10-17】/goal 接管开发:六卡闭环 (BI-00.2/01/03/02/03.2/01.1) 五 commit 推送 (55f6c02→eb26543);三工位模型定型 (租约互斥+目录级独立提交+TOOL-2 全字段+主控复跑验收);AUDIT-11 A2A 协议对齐落地 (用户裁决,协议面 @a2a-js/sdk/传输面自定义 binding);复杂度复议定调全量对等不砍;SSH 通道规程沉淀 (大查询禁用+本地底册三源恢复);恢复点:BI-06 在途验收→BI-06.8 派发→03.4/03.5/06.1/06.5/06.6 队列。详见 Devlog #162/#163。

---

## 二、闭环卡台账 (14 卡,commit 全部推送 origin/main)

| 卡 | 标题 | commit | 验收证据 |
|---|---|---|---|
| BI-00.1 | 上游锚点引擎 v1 (升级追踪) | 55f6c02 | record/check 双命令,T0 六树首记 |
| BI-00.2 | 升级追踪首周期 (元数据相位) | a4931dc | UPSTREAM_ANCHORS.md +47/-0,三树 T1 观测+AUDIT-9 增补表+AUDIT-6 裁定 |
| BI-01 | Bun Monorepo 骨架 | e555591 | 7 包+presets,12 pass,旧壳 289 文件退役 (tag bi-legacy-scaffold-55f6c02) |
| BI-03 | Append-only JSONL 会话引擎 | d46a219 | 1718 行,UUIDv7 单调树+掉电恢复+双索引等价,30 pass |
| BI-02 | 智谱双轨认证引擎 | ddd1c9c | PKCE 七状态机+AES-256-GCM 凭据仓+ICredentialStore 单一端口,67 pass |
| BI-03.2 | 写前 Blob 快照与文件历史 | bfe0148 | 内容寻址去重+字节级还原+引用计数 prune,session 61 pass |
| BI-01.1 | 三级 TOML 配置引擎 | eb26543 | 17 分区 schema+注释保留回写+redact+热重载,70 pass |
| BI-06 | 受控 Bash 执行器 (PGID 看门狗) | 619e9bd | 22 真实进程测试,整组击杀+cwd 标记帧 |
| BI-03.4 | 级联撤销状态机与参与者总线 | 4b5848a | computeUndoCut+零删除游标+错误隔离总线,88 pass |
| BI-06.6 | 规范化文件写互斥队列 | 8b04ff2 | realpath 键+软链归一+失败隔离,39 pass |
| BI-06.5 | 三态权限门禁 | 2c9214a | picomatch 匹配+防提权模式权威源裁定,75 pass |
| BI-12 | Git Worktree 沙箱引擎 | 11569c0 | create/mergeBack 审查门冲突零污染三重断言,31 pass |
| BI-02.1 | Ultra 专线网关与指纹标头 | 1bcc1af | URL 重写+防伪造标头优先级+失败四分类,46 pass |
| BI-14.2 | Plan 模式与审批门禁 | 5a5858d | 只读降权状态机+审批器必填注入,46 pass |

**质量汇总**:全仓 bun test 351 pass / 0 fail(29 文件),tsc 零错误,零返工纪录;每卡 closed 均含 commit_hash+proof_link 四全回显。

## 三、在途工位 (8)

| 工位 | 卡 | 域 | 状态 |
|---|---|---|---|
| 1 | BI-06.8 Shell 词法扫描器 (P0,最大单卡) | core/sandbox | 施工中,主控探询已发 |
| 2 | BI-03.5 双边界收件箱与门铃协调器 (P0) | core/session | 施工中,主控探询已发 |
| 3 | BI-08 64KB 有界截断与媒体门禁 (P0) | core/context | 施工中 |
| 4 | BI-13 MCP 客户端 Stdio+SSE (P0) | packages/mcp | 施工中(文件已落盘) |
| 5 | BI-15.3 A2A 三级鉴权 (P0) | packages/a2a | 施工中 |
| 6 | BI-12.1+12.2 族包:存储修剪器+Tower 协议 (P1) | packages/worktree | 族包施工中(运行模型 v2 首用) |
| 7 | BI-02.2+02.3+02.4 族包:额度/错峰/福利 (P1) | core/gateway+auth | 族包施工中 |
| 8 | BI-14.5 durable 崩溃自愈调度器 (P0) | workflow/durable | 施工中 |

## 四、关键裁决索引 (本会话)

1. **A2A 协议对齐** (用户裁决"执行"):协议面=业界 A2A v1.0 经 @a2a-js/sdk;传输面=邮件/WSS/GitHub 降级为自定义 binding;五卡 notes 重对齐,AUDIT-11 fixed (#160/#161)。
2. **范围裁决两次确认**:全量对等路线维持,双基线收缩方案否决 (省 29% 不值,#165);归属层判据=可砍判据。
3. **并发上限 3→8** (用户指令,#167):台账单点收口+域互斥租约+目录级提交为前提。
4. **运行模型 v2:同族合并派工+复用型工单** (用户采纳,#171):分族地图 SSOT 在 #171,单包 ≤5 卡。
5. **BI-00.2 元数据相位裁定** (#156):大典仍锚 T0,T1 观测备案不锚定,增量吸收待 BI-03.6。
6. **母体测试在禁读范围的法理** (#对话备案):bright-line 可执行性+合约充分性教义;缺口走 finding→受控窗口→大典增量。
7. **安全裁定沉淀**:权限模式权威源在 gate 防请求侧提权 (BI-06.5);Plan 审批器必填无危险缺省 (BI-14.2);TowerMerge 信件门禁 (BI-12.2 施工中)。

## 五、规程沉淀

- **TOOL-1**:devlog 不带 task_id,多条分管道串行;**TOOL-2**:task_upsert 全字段回填,更新前先取现值。
- **SSH 通道**:大查询禁用(>50KB 必挂),卡注恢复走本地底册三源快照(baseline_patch2→audit_fixes→bi_tasks_backfill);P0 卡注快照 /tmp/p0_cards.json。
- **验收门**:主控独立复跑测试→目录级 git add 逐卡提交→closed 全字段→租约释放→办结手记。
- **零数据外泄**:测试全 mock;工位 BI-02.1 主动披露一次触网未遂并根因修复(正面样本)。

## 六、发现项状态 (findings)

- **open×5**:TOOL-1(devlog 幂等覆盖)、TOOL-2(upsert 破坏性字段)、AUDIT-8(大典外残差)、AUDIT-10(五接缝消歧,施工持续执行中)、LOGBOOK-EXPORT-1(导出通道缺陷,本次新立)。
- **fixed×9**:AUDIT-6/9/11 + TOOL 无关的施工类全部闭环。

## 七、本会话 devlog 明细 (#155~#175)

#155 开工/#156 BI-00.2 首周期/#157 BI-01/#158 BI-03/#159 BI-02/#160 A2A 撞车发现/#161 五卡协议对齐/#162(编号由 #164 占用,见下)/#163 会话存档 #8/#164 BI-01.1 办结/#165 范围裁决二次确认/#166 BI-03.4 办结/#167 并发 3→8/#168~#169 BI-06.6+06.5 办结/#170 备用/#171 运行模型 v2/#172 BI-12 办结/#173 BI-02.1 办结/#174 BI-14.2 办结/#175 LOGBOOK-EXPORT-1 关联。(注:服务端按到达序分配编号,个别相邻条目序号互换,内容为准。)

---

*本文档由主控编纂,数据源=logbook (project=bi) + bpfio/bi git 链;再生成命令见 bi-ledger-ops/lb_rpc.py。*
