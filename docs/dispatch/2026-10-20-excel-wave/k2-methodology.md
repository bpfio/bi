> 【归档说明】kimi(minimax) session_950eb9cc 产出；stdout 三段流截断，本文档由主控拼接第 775-868 行 + 952-1230 行两次输出并修复 3 处流式粘连；主控抽样核实 7/7（fake-endpoint.ts/ignition-real-model.ts/npm-pack.ts/version-sync.test.ts/BI_PTY_E2E 门控/typecheck/build:bin 键均实存，PATH bi=0.2.1 属实）。
# bi agent「后续验证与升级」开发方法论

> 基线：`@bpfio/bi` 0.3.0 · Bun 1.3.14 · `packages/{core,tui,worktree,mcp,a2a,plugins,workflow}`
> 适用范围：bi 仓库一切变更（代码、config 键面、发布流程本身）
> 标注约定：`✔` 现存可执行 · `✎` 本方法论新增（需实现并入 CI）
> 版本校正：本机 PATH 上的 `bi` 为 0.2.1（11 子命令），与 0.3.0（16 子命令）不符 —— 任何验收前先跑 `bi --version`，版本不符即视为环境不可信

## 0. 两条不变量（一切门禁的地基）

**不变量 A：提交面 = 门禁面。**
门禁跑过的文件集合必须等于本次提交的文件集合，禁止「改了 A 测了 B」。
落地检查：commit 后 `git status --porcelain` 必须为空；变更文件清单逐条映射到至少一条断言，无映射即视为覆盖缺失。

**不变量 B：零网络零密钥可回归。**
除 L3 真机效用层外，全部自动化门禁须在「无凭据 + 无外网」下自足通过。
伪端点套件子进程 env **只传** `PATH` / `HOME` / `BI_FAKE_KEY` 三项，结构性杜绝宿主真实凭据透传 —— 这是既有 e2e 纪律，不得放宽。

伪端点契约（现读事实，新测试须对齐）：
- `scripts/fake-endpoint.ts` 导出 `startFakeEndpoint({ text?, echo?, port? })` → `{ url, port, requests, close() }`
- anthropic 模式路径以 `/anthropic/v1/messages` 结尾，openai 模式以 `/chat/completions` 结尾
- `echo: true` 回显请求内最后一条 user 消息并加前缀 `ECHO:`
- 任何响应至少含一个 `text_delta`，否则适配器按 protocol 错处理

---

## 1. 验证金字塔

六层，成本递增、覆盖递减。原则：**下层能判定的绝不升层**；升层须写明理由。

| 层 | 名称 | 定位 | 成本 | 覆盖目标 | 通过判定 |
|---|---|---|---|---|---|
| L0 | 单测 | 纯函数/状态机/序列化契约 | ~40s | core 行覆盖 ≥80% | 全绿 |
| L1 | 集成 | 多包协作 core↔tui↔mcp | ~2min | 核心链路分支全覆盖 | 全绿 + tsc 零错 |
| L2 | 伪端点 bin 级 e2e | 零网络零密钥全 CLI 回环 | ~20s | 170 功能台账 / 46 检查点 | 全绿 |
| L3 | 真机效用探针 | 真实模型端到端 S1–S5 | 5–10min | 配置键真实生效 | S1–S5 全过 |
| L4 | dogfood 自食 | bi 修 bi、slash 执行面实测 | 1–2h | 真实交互可用性 | 主控判定可用 |
| L5 | 双评审评测 | 被测自评 + 独立评审交叉 | ~30min | 主观质量/一致性 | 一致性 ≥6/7 |

### L0 单测 ✔
```
bun test                                   # 全量：约 4930 用例 / 274 文件
bun test packages/core/src/xxx.test.ts # 单文件迭代
```
判定：退出码 0，且 `skip/todo` 计数较上次基线**不得上升**。新增文件无对应测试 = 违反不变量 A。

### L1 集成 ✔
```
bun test
bun run typecheck       # tsc --noEmit -p tsconfig.json
bun run build:bin       # bun scripts/build-bin.ts
```
判定：三包 `tsc` 零错 + `build:bin` 产物可执行 + 集成用例全绿。三者缺一不可 —— 类型通过不代表 bin 入口能跑。

### L2 伪端点 bin 级 e2e ✔（最关键增量）
```
BI_PTY_E2E=1 bun test scripts/fake-endpoint-e2e.test.ts
```
该套件默认跳过（`BI_PTY_E2E` 门控），**发布前必须显式置 1 跑一次**。新增端到端能力的标准写法：

1. `startFakeEndpoint({ port: 0, echo: true })` 起伪端点 —— **用随机端口 0，禁止 fixed port 常驻**，避免与他人调试实例抢占；
2. `mkdtemp` 建临时 HOME，写 `.bi/config.toml`：
   ```toml
   [providers.entries.fake]
   api_key_env = "BI_FAKE_KEY"
   base_url = "http://127.0.0.1:<port>"
   kind = "anthropic"
   models = ["fake-echo"]
   ```
3. 起子进程，`env = { PATH, HOME, BI_FAKE_KEY: "dummy" }`，断言 `stream-json` 流中出现 `ECHO:<原文>`。

判定：新增功能必须留下一条 L2 断言，且该断言在**无网络环境**下可复现通过。
「170 功能台账 / 46 检查点」为当前基线；每次新增功能须同步更新台账行数（台账 = 功能的可检索清单，不是文档摆设）。

### L3 真机效用探针 ✔
```
bun scripts/ignition-real-model.ts        # 需真实端点 + 真实密钥
```
S1–S5 覆盖：配置键写入 → 持久化读取 → 真实请求生效 → 多模态/流式回环 → 异常路径。
判定：S1–S5 全过（当前基线 5/5）。**关键区分**：config 键「写进去了」不等于「生效了」——`bi config get` 只能验持久化，生效必须由 S3–S5 的真实回环证明。

### L4 dogfood 自食
用 bi 自身修 bi / 执行 slash 命令，观察真实交互。
判定：主控明确判定「可用」方可通过；出现卡死、错屏、slash 无响应即红灯，**不得用 L0/L2 全绿来抵消**。

### L5 双评审评测
被测 agent 自评 + 独立评审模型交叉。
判定：一致性 ≥6/7（当前基线 7/7）。不一致条目必须逐条写明归因（主控侧错 / 被测侧错 / 评审侧错），不得只记分数。

### 可跳过规则

| 层 | 可跳过条件 | 跳过须记录 |
|---|---|---|
| L0 | 纯文档变更 | 门禁矩阵中标注 |
| L1 | 仅 `.md` 且无代码引用 | 同上 |
| L2 | 仅文档 / 仅注释 | 同上 |
| L3 | 每提交必跑；但**同一日 ≤3 次提交可合并为一次**，且合并窗口内变更不得触及 config 键面或适配器 | 合并窗口起止时间 + 提交 SHA 列表 |
• （前文接续）

| 层 | 可跳过条件 | 跳过须记录 |
|---|---|---|
| L0 | 纯文档变更 | 门禁矩阵中标注档位 |
| L1 | 仅 `.md` 且无代码引用 | 同上 |
| L2 | 仅文档 / 仅注释 | 同上 |
| L3 | 同一日 ≤3 次提交可合并为一次；合并窗口内变更**不得触及** config 键面或适配器 | 合并窗口起止时间 + 提交 SHA 列表 |
| L4 | 每发版前必跑；日常提交可由派单子代理代做，但**主控须亲手验一次 slash 执行面** | 代做者 + 主控复核点 |
| L5 | 每季度必跑；发版前若模型/提示词有变更则必跑 | 触发原因 |

**升层理由记录格式**（写进台账缺陷/调研卡，三要素）：
```
升层原因：L2 无法断言 X（原因码：TIMEOUT / NONDET / ENV / FIXTURE_GAP）
替代证据：<L3 探针编号 S-n> 输出片段
失效窗口：至 <日期/SHA> 须补 L2 断言
```
常见原因码：`NONDET`（伪端点无法表达该语义）、`ENV`（需真实凭据）、`TIMEOUT`（真实推理时长不可控）。

---

## 2. 变更分级门禁矩阵

按变更类型分六档。档位决定必跑门禁组合与最低通过标准。

| 档 | 变更类型 | 典型范围 | 必跑门禁 | 最低通过标准 |
|---|---|---|---|---|
| **D0** | 纯文档 | `*.md`、注释 | L1 的 typecheck | tsc 零错 + `git status` 干净 |
| **D1** | config 键面 | `bi config` 读写面、provider 条目、新增配置键 | L0 + L1 + **L2** + **L3(S1–S3)** | 配置键真实生效（非仅持久化） |
| **D2** | 单工具 / 单模块 | 单个 tool 实现、单个 util | L0 + L1 + L2 | 单测覆盖该函数全分支 + e2e 有一条断言 |
| **D3** | 核心循环 | agent 主循环、适配器、协议解析、会话状态机 | L0 + L1 + L2 + **L3 全 S1–S5** + L4 | 全绿 + 真实端到端五探针通过 + dogfood 主控判定可用 |
| **D4** | TUI | 渲染、按键、slash 命令执行面 | L0 + L1 + L2 + L4 | 渲染快照/交互用例全绿 + 真机按键实测通过 |
| **D5** | 发布 / 打包 | 版本号、`npm-pack.ts`、三包发布流程 | L0 + L1 + L2 + L3 + L4 + L5 | 全部层级通过 + tarball 内容核对通过 |

**D1 的额外硬门禁（最容易出错的一档）**：
config 键新增/改名后，必须同时验证三条路径，任一失败即红灯：
1. 写入后 `bi config get <key>` 读回一致；
2. 真实请求链路读到该值并改变行为（L3 S3–S5 之一）；
3. 旧配置文件（缺该键）仍可加载 —— 缺键必须回落默认值而非报错。

第 3 条最常被漏：新键必须有缺省语义，否则升级即炸存量用户。

**D5 的额外硬门禁**：
- `bun run version-sync.test.ts`（版本号三方一致：bin / package.json / npm tarball）；
- `bun scripts/npm-pack.ts` 产出 tarball → 解包核对 `bin/bi.ts` 存在、`package.json` 的 `version` 与期望一致、依赖无 `workspace:*` 泄漏；
- 灰度顺序固定：**先发三包 → 再验证 tarball 可安装 → 最后才允许写 DEVLOG 发布章节**。任一步失败即回滚 npm 版本号（`npm unpublish` 仅限 72h 内）。

---

## 3. 升级工作流

### 3.1 标准管线

```
需求 → [planned] → 派单 → [running] → 交付 → [review] → 验收 → 合并 → 发版 → 归档 → [closed]
```

**阶段职责与出口条件**

| 阶段 | 动作 | 出口条件 |
|---|---|---|
| 需求 | 立任务卡：现象/影响/验收标准 三要素写全 | 卡片含可执行验收命令 |
| 派单 | 按文件边界拆批，子代理并发 | 各批次文件集**零交集**（派工前用 `git diff --name-only` 交叉核对） |
| 验收 | 验收四步（见 3.3） | 四步全过，任一步不过退回 `running` |
| 合并 | 主控合主干，跑一次全量门禁 | 合并后 L0+L1+L2 复跑全绿 |
| 发布 | D5 门禁 → 三包 npm 发布 → tarball 安装验证 | 安装后 `bi --version` 等于目标版本 |
| 归档 | 台账卡 `closed` + DEVLOG 章节落盘 | 卡状态为 `closed`，DEVLOG 有对应章节 |

### 3.2 台账卡状态机

四个状态，仅允许下列迁移：

```
planned ──派单──> running ──交付──> review ──验收通过──> closed
 ▲                  │                │
   └────退回──────────┘                └──验收不通过──> running
```

- `planned`：已立项，尚未派单
- `running`：子代理在做，diff 在途
- `review`：diff 已交付，等待主控验收
- `closed`：验收通过且已归档

**非法迁移一律视为事故**：`closed → running`（绕过归档）、`planned → closed`（跳过验收）、`review → planned`（静默撤回）。发现即当场修正并记录。

### 3.3 验收四步铁律（不可协商）

| 步 | 动作 | 命令形态 | 判据 |
|---|---|---|---|
| 1 | **diff 亲验** | `git diff --stat <base>..<head>` + 逐文件读 | 子代理报告的改动与实际 diff逐行对得上；无越界文件、无顺手重构 |
| 2 | **门禁复跑** | `bun test && bun run typecheck && BI_PTY_E2E=1 bun test scripts/fake-endpoint-e2e.test.ts` | 全绿，且测试数 ≥ 基线（4930），无 skip 上升 |
| 3 | **真机冒烟** | `bun scripts/ignition-real-model.ts`（涉 D3/D5 时必跑） | S1–S5 通过 |
| 4 | **只读抽样核实** | 随机抽 2–3 处「子代理声称写了断言」的地方，`grep` 到实际断言行 | 断言真实存在且断言的是被测行为，不是 `expect(true)` 一类空断言 |

第 4 步专治「报告说写了测试、实际没有」。

### 3.4 悬空归零铁律

**每个批次收尾与每次发布前，状态处于 `running` 或 `review` 的卡片数量必须为 0。**

- 检查命令：`logbook` 侧查询 `status IN (running, review)`，计数必须为 0；
- 非零时的处理顺序：① 确认是否有人在做 → ② 无人做则退回 `planned` 或标注 `closed` 并写明原因 → ③ 仍有争议的卡打 `blocked` 标记进 DEVLOG，不允许「静默留着」；
- 发布会话开头与结尾各查一次，两次都为零才允许推 npm。

**这一条是全流程唯一的「硬红线」**：门禁全绿但台账有悬空卡 = 发布禁止。

### 3.5 派工通道与并行

- 通道：主控 + 子代理三通道，双节点（kimi / codebuddy）。**派前确认当日可用通道与免费模型白名单**（当前仅 `hy3`；`step-5-preview` 已禁用，opencode 通道已于 2026-10-19 弃用）——派到禁用通道等同派工失败。
- 拆单原则：按**文件边界**切，不按功能切。每个子代理只碰自己那批文件，零交集。
- 派工过程及时回写 logbook 台账（任务 / 批次 / 缺陷 / 调研 / 排查手记五类卡）。
- 终态文档及时落盘：批次终态即写 DEVLOG 章节，不攒到最后。

---

## 4. 回归与评测节奏

### 4.1 每提交（pre-commit / CI 必跑）

```
bun test && bun run typecheck
```

- 增量反馈层：新增/修改文件对应的测试文件先跑一遍（秒级），再跑全量（提交前）。
- 触达 D1/D3/D4/D5 档位时追加对应门禁（查第 2 章矩阵）。
- **不做**的事：每提交不跑 L3/L5（真机与评审太贵），靠矩阵与周节奏兜底。

### 4.2 每发版（tag 前）

```
bun test                                  # 全量 ≥4930
bun run typecheck && bun run build:bin
BI_PTY_E2E=1 bun test scripts/fake-endpoint-e2e.test.ts   # 必须显式置 1
bun scripts/ignition-real-model.ts        # S1–S5
bun test scripts/version-sync.test.ts
bun scripts/npm-pack.ts && <解包核对>
# L4 dogfood：主控亲手跑一遍 slash 执行面
# L5 双评审：若模型/提示词/适配器有变更则跑
```

判定：全绿 → 悬空卡归零检查 → 才允许 `npm publish`。

### 4.3 每周（固定 60–90 分钟窗口）

| 项 | 命令 / 做法 | 判定 |
|---|---|---|
| 覆盖度抽检 | 随机抽 5 个功能，查170 台账是否有对应 L2 断言 | 抽中缺失 → 当周补齐 |
| 幻觉率探针 | 7 探针三波（身份 / 保密 / 幻觉） | 硬幻觉率必须0/7；≥1 即当周事故 |
| 依赖漂移 | `bun outdated` + `npm view @bpfio/bi versions` | 补丁级自动跟进；次版本需评审；主版本仅观察 |
| 性能基线 | 冷启动 `time bi --version` ×10 取 p50/p95 | p95 相对基线劣化 >20% 即开缺陷卡 |
| 崩溃抽检 | 跑历史崩溃用例集（自杀类单列） | 复现即开卡，不得标「偶发」跳过 |

### 4.4 每季度

| 项 | 做法 | 判定 |
|---|---|---|
| 双评审评测 L5 | 被测自评 + 独立评审交叉 | 一致性 ≥6/7（基线 7/7） |
| 验证金字塔全栈复跑 | L0→L5 逐层 | 每层判定均达标 |
| 风险登记册复审 | 逐条过第 5 章 | 每条风险的对冲手段仍有效，否则重定级 |
| 度量基线刷新 | 重采第 6 章全部指标 | 基线变更须写明「旧值 → 新值 → 原因」 |
| 门禁矩阵复审 | 档位与最低标准是否仍匹配现状 | 不匹配当场改矩阵并落 DEVLOG |

### 4.5 节奏总表

| 节奏 | L0 | L1 | L2 | L3 | L4 | L5 | 覆盖抽检 | 性能 | 依赖 |
|---|---|---|---|---|---|---|---|---|---|
| 每提交 | ✔ | ✔ | 矩阵触发 | — | — | — | — | — | — |
| 每发版 | ✔ | ✔ | ✔ | ✔ | ✔ | 变更触发 | — | — | — |
| 每周 | — | — | 抽检 | — | — | — | ✔(5) | ✔ | ✔ |
| 每季度 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |

---

## 5. 质量风险登记册

CLI agent 特有风险。每条含：触发信号 → 对冲手段 → 责任动作。

### R1 模型漂移（上游模型静默换代）
- **信号**：同探针输出措辞突变、工具调用格式变化、拒答率上升、token 数漂移 >15%。
- **对冲**：L2 用伪端点锁协议契约（不依赖上游行为）；L3/L5 用真实模型跑语义面；prompt/适配器变更有 L5 交叉评审把关。
- **动作**：漂移信号出现即跑当周幻觉率探针；差异归因清楚前不更新基线。

### R2 端点限流 429 / 短时不可用
- **信号**：探针返回 429、5xx、超时。
- **对冲**：L0/L1/L2 全程零网络 → 主干门禁不受影响；L3/L4/L5 遇 429 退避重试（3 次，指数退避）后再判；**禁止**把 429 当失败直接判红灯，须区分「能力失败」与「基础设施失败」。
- **动作**：连续两次 429 → 该轮评审判无效，顺延，不得凑合记分

• Let me continue the document. I need to write section 5 continued, section 6, and finish. Let me be careful with formatting — the user asked for 200-400 lines markdown printed to stdout. I already printed parts 0-2 and 3-4 and start of 5. Let me finish section 5 and write section 6, and a closing.

Wait — I need to consider: the user said "全部产出以 markdown 纯文本直接打印到 stdout". I'm outputting in the chat which renders as markdown. That's the deliverable. Let me finish it.

Let me count roughly the lines. I've produced a fair amount. Let me complete 5 (R3-R9), then 6 metrics table with measurement method and current baseline, then a closing checklist.

Let me make sure baselines are accurate — I should mark baselines that I know from the ticket vs. that need measurement. The ticket gives: 4930 tests/274 files, 170 feature ledger/46 checks, hallucination 0/7, dual-review consistency 7/7. Others (crash rate, token cost, round efficiency) are not given — I should mark them as "待实测填入" with a collection method rather than inventing numbers. That's honest.

Let me write it.

• ### R3 上下文膨胀（长会话 token 失控）
- **信号**：单会话 token 占用持续上升、同一文件反复读取、摘要策略失效。
- **对冲**：每会话 token/回合上限硬阈值；超阈值强制摘要；回归面里保留「长会话不崩不重复」用例。
- **动作**：超阈值即开缺陷卡，修复前禁止仅靠「手动新开会话」绕过。

### R4 幻觉回归（编造文件/接口/命令）
- **信号**：幻觉率探针出现「声称不存在的文件/函数/配置键」。
- **对冲**：7 探针三波每周跑；行为学设计规避「保密拒答」造成的假阴性（要求答话以口令开头，而不是问敏感信息本身）；L2 用伪端点让「声称调用了模型」必须真的产生 HTTP 请求，物理上排除「假装调了」。
- **动作**：硬幻觉率 ≠0 即当周事故，逐条归因到具体改动 SHA。

### R5 子代理失控（越界改文件 / 谎报完成）
- **信号**：diff 出现非本批文件；报告声称有测试但 grep 不到；重复改同一处。
- **对冲**：验收四步（diff 亲验 / 门禁复跑 / 真机冒烟 / 只读抽样核实）；文件边界零交集拆单；子代理不得自行 commit / push / publish。
- **动作**：越界即退回 `running`，并记入子代理档案；两次越界换通道或换模型。

### R6 崩溃类测试自杀（测试把 CLI 打成真崩溃 / 挂死）
- **信号**：测试进程无退出、shell 被占、留下孤儿进程或监听端口。
- **对冲**：崩溃类用例必须在子进程 + 超时内运行（如 `timeout 30`）；伪端点用随机端口 0，禁 fixed port 常驻；每轮结束断言无残留进程（`ps` 查 `bi` 进程数归零）。
- **动作**：出现自杀用例立即隔离到 `known-crash` 标记集，**单独跑、单独判**，不得让它拖垮整轮门禁；但也**不得长期挂着不修**（挂账上限 2 周）。

### R7 发布后 CDN / registry 延迟与同号占用
- **信号**：`npm view` 可见但 CDN 拉取 404；同号 `publish` 报 409。
- **对冲**：发布后**必须**等 CDN 同步（已知 >50 分钟）再做安装验证，禁止刚 publish 就验；版本号占用前先 `npm view <pkg> versions` 查重。
- **动作**：同步期内只报「已发布待同步」，不报「发布失败」；超时未同步开卡并留观。

### R8 门禁与提交面脱节（改了没测 / 测了没改）
- **信号**：新增文件无测试；门禁跑的是旧代码。
- **对冲**：不变量 A +提交后 `git status --porcelain` 必须为空；门禁在**提交后**的工作树上跑，不在脏工作树上跑。
- **动作**：发现即当次提交作废重做，不允许「补个测试就算覆盖」的空断言。

### R9 悬空台账卡（任务失踪）
- **信号**：状态长期停留 `running`/`review`；批次已合并但卡未关。
- **对冲**：3.4 悬空归零铁律，发版前后各查一次。
- **动作**：非零即发布禁止；无人认领的卡退回 `planned` 或标注原因关闭。

---

## 6. 度量指标集

「优秀 CLI agent」的可度量指标。每项给测量方法与当前 bi 基线。

| # | 指标 | 定义 | 测量方法 | 当前基线 | 目标 |
|---|---|---|---|---|---|
| M1 | 硬幻觉率 | 声称不存在的文件/函数/配置键占比 | 7 探针三波中硬幻觉条数 / 7 | **0/7（周）** | 恒为 0 |
| M2 | 任务完成率 | S1–S5 真机探针通过数 / 5 | `bun scripts/ignition-real-model.ts` | **5/5** | 5/5 恒定 |
| M3 | 回合效率 | 达成同一目标的模型回合数中位数 | 探针脚本读 `stream-json` 中 assistant 回合计数，取中位 | 待实测填入（首次采集立卡） | ≤ 基线，劣化即查 |
| M4 | token 成本 | 单次任务总 token（含缓存命中） | `stream-json` 的 usage 字段求和，按次累计 | 待实测填入 | 每版本不劣化 >10% |
| M5 | 崩溃率 | 导致 CLI 非零退出或挂死的运行数 / 总运行数 | L2 套件每轮统计 exit≠0 数 ÷ 总数 | 待实测填入（崩溃用例单独统计） | <1% |
| M6 | 门禁绿率 | 全量门禁一次通过次数 / 总触发次数 | CI 记录 | 待实测填入 | ≥95%，连续3 红即查基础设施 |
| M7 | 伪端点覆盖率 | 有 L2 断言的功能数 / 功能台账总数 | 台账逐行核对断言存在性 | **170 台账 / 46 检查点**（断言映射率待算） | 台账行100% 有断言 |
| M8 | 双评审一致性 | 被测自评与独立评审结论一致条数 / 总条数 | L5 交叉评审 | **7/7（季度）** | ≥6/7 恒定 |
| M9 | 悬空卡数 | `running`+`review` 状态卡片数 | 台账查询 | **0（发布前红线）** | 恒为 0 |
| M10 | 提交面一致率 | 有门禁覆盖的变更文件数 / 变更文件总数 | 逐文件映射断言 | 待实测填入 | 100% |
| M11 | 冷启动 p95 | `bi --version` 耗时 p95 | 10 次 `time` 取 p95 | 待实测填入 | 劣化 >20% 开卡 |
| M12 | 依赖漂移滞后 | 上游补丁版本发布到本仓跟进的天数 | `bun outdated` 与 changelog 对比 | 待实测填入 | ≤7 天 |

**基线采集纪律**：标「待实测填入」的指标，在首个采集值落定前不得用估计值当基线，也不得用「暂无数据」长期挂账 —— 每项须在下次周窗口内采集一次并回填，同时在 DEVLOG 记录「旧值 → 新值 → 原因」。基线只能被显式更新，不能被静默替换。

**指标使用原则**：指标用于发现劣化，不用于排名。M1/M2/M9 是红线（触发即事故）；M3/M4/M5/M11 是趋势线（劣化开卡）；其余是过程指标（改进用）。任一红线指标劣化，优先做根因分析而非加门禁。

---

## 附：发布前一页纸检查单（可直接贴 CI）

```
[ ] bi --version 与目标版本一致（防旧 CLI 验收）
[ ] bun test 全绿，用例数 ≥ 4930，skip 未上升
[ ] bun run typecheck零错
[ ] bun run build:bin 产物可执行
[ ] BI_PTY_E2E=1 bun test scripts/fake-endpoint-e2e.test.ts 全绿
[ ] bun scripts/ignition-real-model.ts S1–S5 全过
[ ] bun test scripts/version-sync.test.ts 全绿
[ ] bun scripts/npm-pack.ts tarball 内容核对通过
[ ] L4 dogfood：主控亲手跑过 slash 执行面
[ ] L5 双评审（若模型/提示词/适配器有变更）
[ ] 悬空台账卡数 = 0（running + review）
[ ] git status --porcelain 为空（提交面 = 门禁面）
[ ] 无残留 bi 进程 / 监听端口（崩溃用例隔离检查）
[ ] npm view查重：目标版本未被占用
[ ] 发布后等 CDN 同步，再做安装验证
```

**触发条件**：本文件在以下三种情况任一发生时必须更新并落 DEVLOG —— 新增一层验证、新增一档变更类型、新增一个红线指标。**这是方法论自身的变更门禁。**
