# 修复工单 FIX-B：交互面收尾 + 文档实况对齐（bi 仓库，写模式）

你是 bi 仓库（/home/yupeng/bi）的修复工程师。FIX-A（装配面四项）已由主控验收合并。本单四项，逐项修复配测试，**不 commit 不 push**。

## 统一纪律
- 不碰 docs/dispatch/**、DEVLOG.md、packages/worktree|a2a|plugins|workflow/**、packages/core/src/session/**、packages/core/src/cron/**（FIX-A 已验收面）
- 改行为必须配测试；README 只许改与本单相关行；严禁顺手重构
- 修完自跑 `bun test`（全绿）+ `bun run typecheck`（零错）
- 最终输出结论清单（每项：文件/思路/测试名），格式从简不复述过程

## F5 /diff 审查门接真实交互确认（P0-1）
现状：REPL `/diff` 恒判拒绝——`packages/tui/src/diff-view.ts:459` `if (!options.confirm) return reject('未注册审查回调')`；bin/bi.ts:130 备案"confirm 端口未注册"。
修复：bin/bi.ts REPL 装配处给 diff-gate 注入交互式 confirm 回调（渲染 diff → y/n 提示）。**先勘察 REPL 输入缝**（InputLoop/KeyStream 在命令执行期是否可用）：
- (a) 若命令执行期可读键 → 真交互 y/n（Esc/n=拒）；
- (b) 若不可行 → 退而实现 `/diff approve` / `/diff reject` 显式子命令形态（先 `/diff` 看差异，再显式裁决——同样是真实功能，不算虚账），并在 README 写明用法。
两形态都须：拒绝/批准均有测试钉死；用户看到的是真实差异内容。

## F6 [tui] 分区处置（P0-3）
现状：`tui.theme/mouse_mode/notifications/show_thoughts` 四键零消费者（README:166 宣传与实现漂移）。
修复：
1. `tui.mouse_mode` **真接线**：bin/bi.ts 现硬写 MOUSE_ENABLE/DISABLE——改为按 `config.tui.mouse_mode`（schema 缺省 true）决定是否启用鼠标语义；测试钉两态。
2. `theme`/`notifications`/`show_thoughts`：本版本无主题系统/通知面/thinking 上屏——README 该行如实标注「预留未接线（本版本无消费者）」，schema 注释同步；**不删键**（向后兼容）。
判据：README 宣传面=实现实况，不再有死键宣传。

## F7 README 文实漂移修正（P1-10/P1-11 相关文档面）
逐项核对并修正：
1. README:309 附近 devplan 称「117 卡 SSOT」→ 实数 109 卡（先 `grep -c` 实测卡号数再改；若 devplan 文件本体缺状态列，只在 README 描述里如实说明状态追踪散布处，不去改 devplan 本体）
2. README:26 附近「三包 tsc」→ 与实况对齐：先查 `.github/workflows/ci.yml` 实际 typecheck 范围与各包是否有独立 tsconfig；**若给五包补 tsc 是 S 级改动则扩 CI**（让现实配得上宣传），否则改 README 措辞就实况
3. README:292 附近「双 tsconfig 类型门」→ 按实况改（package.json:12 是单条 `tsc --noEmit -p tsconfig.json`）
4. README 安装节（289-293 附近）补真实可用安装路径：`npm i -g @bpfio/bi`（0.3.0 已在 registry）与版本要求

## F8 LSP 挂载警告去重（外观瑕疵备案处置）
现状：headless 路径两次构建工具集（main.ts subagentBaseTools + runHeadless tools），`LSP_MOUNT_SKIPPED_WARNING` 打印两次。
修复：main.ts 的 warn 出口加同文本去重（Set 记已告警文本，进程内一次）；测试钉"只告一次"。

## 交付判据
`bun test` 全绿 + `bun run typecheck` 零错 + 每项给出测试名。
