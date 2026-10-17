# 上游锚点基线 (Upstream Anchors / 大典版本化)

> **建立时间**：2026-10-17 (BI-00.1 落地,RULE-BI-08 母体硬分叉与上游锚点追踪铁律)
> **执行引擎**：`/home/yupeng/bi-ledger-ops/upstream_sync.py` v1 — `record` 采集锚点 / `check` 对比锚点 vs 本地 HEAD vs 远程 HEAD (`git ls-remote`)。
> **铁律约束**：仅使用 git 元数据判定上游演进,**零源码内容扫描** (RULE-BI-06);bi 对全部参考树为**硬分叉**,不回跟任何母体版本,上游增量仅经 BI-00.2 受控循环吸收 (RULE-BI-08)。

## 锚点首记 (2026-10-17,T0 基线)

| 参考树 | 锚点 commit | 提交时间 | HEAD 提交主题 | 状态 |
|---|---|---|---|---|
| zcode (清华 ZCode) | `aac4755666d09fdcd70272fcf063c077a639015f` | 2026-10-10 | feat: update to v3.15.1 | T0 基线 |
| kimi-code (清华系 Kimi CLI) | `18c6d64272952503baccf706bff455bb6a2c488e` | 2026-10-16 | feat: notify the agent of external changes after /reload (#4019) | T0 基线 |
| opencode | `32b41bab136f02b17d285825d36b213798f67cb6` | 2026-10-16 | test(cli): simplify service env test (#55952) | T0 基线;T0 当日探测到上游已前移 |
| deepseek-harness (DHS) | `86a402200d95fecef4529d969836f1fe13c6cb0d` | 2026-10-15 | Merge PR #6301 → release-dsh-0.2.1-alpha.4 | T0 基线;上游已前移 |
| pi | `4954d760504c11df9b2cbdc040346107b6a8153d` | 2026-10-15 | feat: check the model catalog against the latest release before publishing (#11007) | T0 基线;上游已前移 |
| deepcode (第 6 棵树,AUDIT-6 备案) | `03c7ebbfa1b7129628c30a3abbcbb776aa04ac1a` | 2026-10-15 | feat(docs): add DeepCode Plus section to README files | T0 基线 |

> 机器可读快照:`/home/yupeng/bi-ledger-ops/upstream_anchors.json` (本文件的权威数据源,双落盘)。

## 运行协议 (BI-00.2 升级追踪循环)

```
upstream_sync.py check 命中 upstream-moved / local-drift
  → 1. git pull 对应参考树 (只读树,禁止反向合并进 bi)
  → 2. 锚点差分:仅 git log/diff --stat 元数据,判定演进波及哪些大典章节 (严禁内容级扫描)
  → 3. 大典增量:更新 docs/FIVE_AGENTS_FULL_SPECTRUM_ANALYSIS.md 受影响小节 + 重录锚点 (record)
  → 4. 卡片重对齐:受影响 BI-* 卡 notes 复核,轮子锚点漂移则以 finding/任务备案
  → 5. Shadow Replay (BI-03.6) 非回归门通过后,增量方可进入施工
```

- T0 当日 `check` 实测:opencode / deepseek-harness / pi 三树上游已前移(远程 HEAD 分别为 `1cb7bcadb` / `1517a4dbc` / `8efd314fa`),**未拉取**——冻结大典基线穿越启动窗口,三树位移移交 BI-00.2 首个同步周期处置。
- zcode-app-cli (bpfio/zcode-cli fork) 不参与锚点追踪:母体硬分叉裁定为不回跟,仅作只读工程参考 (RULE-BI-07 / BI-01 审计边界声明)。

## T1 上游观测 (2026-10-17 · BI-00.2 首周期)

> 本周期为**元数据差分观测与备案周期**:先以 `upstream_sync.py check --no-net` 确认本地基线 (local-drift=0,六树本地 HEAD 均与 T0 锚点一致);随后对三棵已知位移树执行 fetch,仅以 rev-parse / log --oneline / diff --stat / diff --dirstat / ls-remote 完成差分,零源码内容扫描 (RULE-BI-06)。三树 fetch 全部成功,无 unreachable 项。

| 参考树 | T0 锚点 | 本地 HEAD | 远端 HEAD | 状态 | 提交数 | 变更顶层分布一句话摘要 |
|---|---|---|---|---|---|---|
| zcode | `aac4755666d` | `aac4755666d` | `aac4755666d` (ls-remote HEAD) | in-sync | 0 | 无变化 |
| kimi-code | `18c6d6427` | `18c6d6427` | `18c6d6427` (ls-remote HEAD) | in-sync | 0 | 无变化 |
| opencode | `32b41bab1` | `32b41bab1` | `bc5fa1ccf3` (origin/dev) | upstream-moved | 40 | tui 组件层 (10.0%) 与 core/src (4.7%) 为主力;packages/ai、app、client、protocol、schema、server 全线波及;189 files +4350/-1496 |
| deepseek-harness (DHS) | `86a402200` | `86a402200` | `1517a4dbca` (origin/master) | upstream-moved | 36 | packages/client (10.9%)、experimental (8.0%)、snapshots/session (13.1%),session/util/tools 波及;586 files +3129/-1117 |
| pi | `4954d7605` | `4954d7605` | `8efd314fa` (origin/main) | upstream-moved | 14 | packages/ai/test (31.6%) 与 durable/src/harness (10.0%) 为主力,ai/src/api (5.0%)、coding-agent compaction 波及;60 files +1120/-351 |
| deepcode | `03c7ebbfa` | `03c7ebbfa` | `03c7ebbfa` (ls-remote HEAD) | in-sync | 0 | 无变化 |

- opencode 备注:T0 当日探测值 `1cb7bcadb` 已被新 HEAD `bc5fa1ccf3` 包含 (T0 至其为 38 提交,其上再增 2 提交:4a53028 fix(ai): tolerate unknown and untyped stream events / bc5fa1c feat(plugin): expose session list);origin/HEAD 指向 origin/dev。
- DHS 备注:本 fetch 带回 release tag `dsh-v0.2.1-alpha.5` (新 HEAD 即该 release 的 merge 提交),主题面为 account 通知层叠、web model label slot、PTC prompt 组合式重构与 pinned-clock 测试加固。
- pi 备注:主题集中于 models.json 参考文档自动生成、NVIDIA 默认切至 Nemotron 3.5 Super VL、durable compaction.modelOverrides 与 ToolControl.terminate 类型修正、AI gateway 重试加固。

处置裁定：大典内容仍锚定 T0，旧锚点继续有效（RULE-BI-06）；T1 大典增量吸收延后至 BI-03.6 Shadow Replay 就绪后的受控窗口执行，吸收后经 upstream_sync.py record 重录锚点。本周期不 pull 合并、不重录 upstream_anchors.json。

## 卡片锚点增补表 (AUDIT-9 · 19 项 · 2026-10-17)

下轮卡片重对齐已由本表承载，施工时按表内备选锚点扩展引用，不新增卡：

1. zcode debug → BI-11.1（trace/context-usage 视图）
2. zcode rpc → BI-20.6（ChunkStream IPC 备选）
3. zcode client web-relay → BI-15.4 备选
4. kimi kosong → BI-04 备选
5. kimi oauth → BI-02 备选
6. kimi telemetry → BI-11.1 备选
7. pi-ai model catalog → BI-04 备选
8. pi-mcp OAuth → BI-13 备选
9. DHS attachment 图像准入梯子 → BI-08 备选
10. DHS session-format 版本迁移 → BI-03 备选
11. DHS hook-protocol → BI-06.4 备选
12. DHS acp → BI-20.6 备选
13. DHS tool-worktree → BI-12 备选
14. DHS agent-preset → BI-07.3 备选
15. DHS util atomic-write → BI-01 共享件（注：BI-01 骨架施工已同步落地 packages/core/src/utils/atomic-write.ts）
16. opencode http-recorder cassettes → BI-03.6 / BI-21.3 备选
17. opencode cli 自打包 → BI-22 备选
18. opencode plugin loader → BI-17 备选
19. opencode session-ui/theme → BI-20.5 备选

## deepcode 大典外收录裁定 (AUDIT-6 · 2026-10-17)

裁定：deepcode 不做全包大典补录。理由：其为六树中引用面最小的参考——仅 BI-04 / BI-04.2 引用其 packages/core/src/session.ts（R1 思考流分离）一处能力，全量补录的 token 成本与收益不成比例。处置：引用锚点以本节备案为大典外标注，两卡施工时按锚点引用；AUDIT-6 以本节为证据由主控关闭。
