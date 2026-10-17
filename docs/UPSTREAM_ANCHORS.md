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
