---
name: superpowers
description: 顶尖 Agent 工程纪律插件总纲。当接手任何写代码、修 Bug、并行多任务、实验性改动、宣布完成、交付审查类任务时，必须先读本总纲确定纪律路径再动手。触发条件：开工任何编码任务前、准备宣布"完成"时、遇到 Bug 需要排查时、需要在多任务或风险改动间隔离现场时、需要对产出做质量审查时。
---

# Superpowers：Agent 工程纪律总纲

本插件不提供任何"能力"，只提供"纪律"。四个子技能对应工程生命周期的四个关口，
每个关口都有强制动作。跳过关口 = 工作无效，无论代码写了多少行。

## 一、四技能索引

| # | 技能 | 路径 | 关口 | 一句话铁律 |
|---|------|------|------|-----------|
| 1 | verification-before-completion | `skills/verification-before-completion/SKILL.md` | 宣布完成前 | 未验证即未完成，禁止口头宣称通过 |
| 2 | using-git-worktrees | `skills/using-git-worktrees/SKILL.md` | 开工动代码前 | 现场不隔离，主分支就是垃圾场 |
| 3 | systematic-debugging | `skills/systematic-debugging/SKILL.md` | 排障时 | 先找根因再动手，禁止无证据乱改 |
| 4 | subagent-driven-development | `skills/subagent-driven-development/SKILL.md` | 交付前 | 写的人不审自己的代码，双阶段审查强制闭环 |

## 二、启用顺序（强制）

纪律按时间轴排列，顺序不可调换：

```
[接到任务]
    │
    ▼
① 开工前 → verification-before-completion 自查
    先读懂 DoD（完成的定义），列出本轮要跑的验证命令清单。
    连"怎么算完成"都没定义就开工，等于盲飞。
    │
    ▼
② 开工时 → using-git-worktrees 隔离
    判断本次改动类型（常规/并行/实验/高危），按规则决定是否开 worktree。
    动第一行代码之前完成隔离决策。
    │
    ▼
③ 排障中 → systematic-debugging
    一旦出现任何非预期行为，立即切换到四阶段排查法，
    复现 → 假设 → 最小验证 → 修复回归。禁止跳阶段。
    │
    ▼
④ 交付前 → subagent-driven-development 双阶段审查
    代码写完 ≠ 任务完成。Implementer 产出后，
    必须经过 Spec Reviewer 与 Quality Reviewer 两道独立审查才能宣布完成。
    │
    ▼
[宣布完成] ← 只有走完 ①②③④ 且各有证据留痕，才允许说出"完成"二字
```

## 三、快速决策表

遇到具体场景，按下表进入对应技能：

- **"这个任务算不算完成？"** → verification-before-completion，查验证清单
- **"我要同时改两个互不相干的东西 / 试一个不确定能成的方案"** → using-git-worktrees，先开隔离现场
- **"跑起来报错了 / 行为不符合预期"** → systematic-debugging，从 Phase 1 复现开始
- **"代码写完了，能不能直接交付？"** → 不能，进 subagent-driven-development
- **"改动很小，能不能跳过流程？"** → 不能。改动小是省时间量级的理由，不是跳纪律的理由

## 四、目录结构与落盘规范

```
presets/plugins/superpowers/
├── SKILL.md                                  ← 本总纲（入口，必读）
└── skills/
    ├── using-git-worktrees/SKILL.md          ← 关口②：现场隔离
    ├── verification-before-completion/SKILL.md ← 关口①：完工自验
    ├── systematic-debugging/SKILL.md         ← 关口③：系化排查
    └── subagent-driven-development/SKILL.md  ← 关口④：双阶段审查
```

- 每个技能是独立资产卡：frontmatter（name/description）+ 可执行正文 + 检查清单
- description 是运行时的触发条件，必须写"何时读"而不是"是什么"
- 技能之间只通过总纲的顺序图衔接，不互相内联复制内容（单一事实源）
- 新增/修改技能时同步更新第一节的索引表与本节的目录树，缺一即视为提交不完整

## 五、插件元数据

- 插件名：`superpowers`
- 类型：纯 Markdown 资产卡（无脚本、无二进制、无网络依赖）
- 兼容：任何支持 skills 目录 + frontmatter（name/description）的 Agent 运行时
- 来源：吸收自开源社区顶尖 Agent SOP 集合，合约级重写为本仓执行规范
- 变更原则：修改本插件任一技能时，必须同步更新本总纲的索引表与顺序图

## 六、反模式（见到即停）

- 只读了一个技能就声称"已吸收 superpowers"——四个技能是一个整体闭环
- 把本插件当参考资料"有空再看"——它是执行规范，开工即生效
- 用"时间紧"作为跳过验证或跳过审查的理由——时间紧更不能返工
- 在总纲里堆砌激励性空话——本插件只有可执行的动作和检查清单
