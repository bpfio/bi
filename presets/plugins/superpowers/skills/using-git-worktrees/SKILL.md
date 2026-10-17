---
name: using-git-worktrees
description: 沙箱隔离规范。当需要同时推进多个任务、尝试实验性或不确定能否成功的改动、执行高风险操作（批量重构、依赖升级、数据迁移脚本）时，必须在开工前用 git worktree 建立隔离现场。触发条件：并行任务、实验分支、风险操作、主工作区被占用、需要保留当前现场对照时。
---

# Using Git Worktrees：现场隔离规范

核心原则：**一个工作区同一时刻只承载一件事**。主工作区（main checkout）是"稳定
基线"，任何可能污染它的活动都必须搬进 worktree 隔离现场。

## 1. 何时必须开 worktree（强制清单）

满足任一条即必须开，无豁免：

- [ ] **多任务并行**：同时接到 ≥2 个互不相干的任务，或上一任务现场未收尾就来新任务
- [ ] **实验性改动**：不确定方案能否成功（试新库、验证猜想、PoC、性能试验）
- [ ] **风险操作**：批量重构、大规模重命名、依赖大版本升级、数据迁移脚本、
      删除/移动大量文件、改共享基础设施代码
- [ ] **现场对照**：需要一边跑旧版本一边改新版本（对比行为、复现差异）
- [ ] **长任务让位**：当前工作区有未提交改动，而新任务是紧急插入的

不需要开的情况（唯一例外）：单任务、小改动、当前工作区干净且无并行压力。
拿不准时，选择开——隔离的成本是几分钟，污染主区的成本是几小时。

## 2. 操作序列（标准流程）

### 2.1 创建

```bash
# Step 1: 确认当前现场干净（脏现场先处理：stash 或先提交到临时分支）
git status --porcelain          # 有输出 = 有未提交内容，先处理
git -C /path/to/repo worktree add /path/to/wt-<slug> -b <branch-name>

# 带 base 指定（从特定起点开叉，而不是当前 HEAD）
git worktree add ../wt-auth-refactor -b feature/auth-refactor origin/main
```

### 2.2 环境重建（隔离现场不是免费的，必须补齐）

worktree 只共享 `.git`，**不共享** node_modules / venv / build 产物 / 本地配置：

```bash
cd /path/to/wt-<slug>
npm install          # 或 pip install -e . / cargo build 等按栈选择
cp /path/to/main/.env.local .env.local   # 按需复制本地非版本化配置
# 验证可构建：跑一次最小构建/测试，确认现场可用再开工
```

### 2.3 在隔离现场内正常工作

所有 commit 都落在 worktree 的分支上。主工作区在此期间保持不动，
可随时切过去处理紧急事务或对照基线行为。

## 3. 分支与目录命名

- 分支名：`<type>/<slug>`，type ∈ {feat, fix, exp, spike, chore}，
  slug 用短横线小写英文，如 `exp/vector-cache-test`、`fix/lease-race`
- worktree 目录名：`wt-<slug>`，与分支 slug 一致，放在仓库同级目录
  （如仓库在 `~/bi`，worktree 放 `~/wt-bi-<slug>` 或 `~/bi-wt/<slug>`）
- 实验性分支必须以 `exp/` 或 `spike/` 开头，明示"随时可弃"

## 4. 清理纪律（隔离现场用完必须拆）

```bash
# 分支已合并或已弃：
git worktree remove /path/to/wt-<slug>          # 正常移除
git worktree remove --force /path/to/wt-<slug>  # 有未提交改动且确认不要了
git branch -d <branch-name>                     # 已合并；实验分支用 -D
git worktree prune                              # 清理失效记录（目录被手动删掉后）

# 自检：列表里不该有超过 3 个存活 worktree
git worktree list
```

清理触发时机：

- [ ] 分支已合入主线 → 当场移除 worktree + 删分支
- [ ] 实验结论已记录（无论成败）→ 移除现场，把结论写进文档/手记，代码可弃
- [ ] 任务中止超过 3 天未回来 → 移除现场，需要时按记录重建（重建成本 << 僵尸现场成本）

## 5. 检查清单（开工前 60 秒自查）

1. [ ] 本次改动类型属于第 1 节强制清单中的哪一条？（都不属于才可不开）
2. [ ] 主工作区当前状态是否干净？脏内容归属哪个任务？
3. [ ] worktree 目录名与分支名是否符合命名规范？
4. [ ] 环境重建完成并能通过最小构建验证？
5. [ ] 我知道这个现场什么时候、以什么条件被清理吗？

## 6. 反模式

- **僵尸现场**：开了一堆 worktree 从不清理，两周后没人记得哪个是活的
- **隔离了却不隔离**：在 worktree 里改着改着，又跑回主工作区提交，两边互相踩
- **实验代码直接写在主分支**："先随便试试"的代码 90% 会留下来变成债务
- **把 stash 当 worktree 用**：stash 无处可跑测试、无分支可见、极易被 pop 错位；
  stash 只适合 5 分钟内的临时腾挪，长于一个会话的现场一律用 worktree
