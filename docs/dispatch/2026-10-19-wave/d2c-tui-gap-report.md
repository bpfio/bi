# D2c 差距分析报告 / TUI-ALIGN-1:bi TUI vs Kimi Code CLI

- 派发:2026-10-19,codebuddy hy3,`--tools "Read,Grep,Glob"`,cwd /home/yupeng(覆盖 bi+references 双树),零修改(git 亲验双树干净),零联网
- 简报:`d2-tui-gap-brief.txt`(opencode 两连 429 僵尸后按用户裁定改走 codebuddy);原始输出:`/tmp/d2c-tui-gap.log`(7044B)
- 工时:约 9 分钟,免费模型

## ① 差距矩阵(7 维,kimi file:line vs bi file:line)

| 维度 | kimi-code | bi 现状 | 判定 |
|---|---|---|---|
| 输入编辑器 | input.ts 字素级光标/长行横滚/括号粘贴/鼠标定位/undo | repl.ts LineEditor UTF-16 码元光标(自承非字素感知)、仅基础键 | 部分 |
| 自动补全 | autocomplete.ts 斜杠+@附件 fd 模糊+路径+光标数学 | candidate-menu.ts 仅斜杠菜单,无文件/路径/@、无模糊排名 | 部分 |
| 快捷键/kill-ring | keybindings.ts 30+ 可配置注册表 + KillRing + Emacs 键 | 硬编码 ctrl-c/d/e,无 kill-ring/undo/可配置 | 缺失(kill-ring)/部分 |
| 历史搜索 | alt-screen-search.ts Ctrl+Shift+F 全转录查找 | 仅滚轮滚动,无查找 | **缺失** |
| 渲染引擎 | layout.ts 布局树/ScrollView/Kitty 图/OSC133 | virtual-terminal+diff-renderer 双缓冲差分(ADR BI-27.5 刻意 inline) | 部分 |
| 转录视图 | transcript/ 四层同构投影 | TranscriptProjection+StyledTranscript,**结构同构已对齐**(BI-27.3) | 对齐 |
| 子命令面 | export/fork/session/vis/acp/config/web/login/… | 8 个(init/session/fork/export/transfer/acp/upgrade/doctor),缺 vis 等 | 部分 |

## ② 主因 top3(按用户可感知度)

1. 无转录内搜索——长会话定位历史结论只能滚轮;
2. 无文件/路径/@ 补全——引用文件零候选,落差最直接;
3. 编辑器弱——CJK/emoji 光标错位、长行无横滚、无 kill/undo,CJK 场景尤痛。

## ③ Top-3 快赢提案(详见 /tmp/d2c-tui-gap.log 全文)

- **A 转录内搜索(M)**:移植 alt-screen-search 的语料构建+正则匹配+增量缓存;agent-tui.ts 加 SearchOverlay;新增 mount/transcript-search.ts;纯函数零 TTY 可测。→ 建议立项 BI-19.1-search
- **B 文件/路径/@ 补全(L)**:candidate-menu.ts 扩 provider,repl.ts Tab 路由,fuzzyFilter 排名;Node readdir 降级路径 kimi 已趟平。→ 建议立项 BI-19.8
- **C 编辑器体感(L)**:Intl.Segmenter 字素光标+长行横滚+KillRing/UndoStack。→ BI-19.1 延伸

## 主控验收:通过

矩阵双侧证据齐、主因排序合理、提案可实施且全部落在 bi 侧不动参考树;意外收获:确认转录投影层已同构对齐,"简陋"集中在交互输入面。实现单(D5 批次)按本轮 2-4 agent 预算不派,三提案登记为下批工单。

**报告全文原始输出:/tmp/d2c-tui-gap.log(2026-10-19 收纳)**
