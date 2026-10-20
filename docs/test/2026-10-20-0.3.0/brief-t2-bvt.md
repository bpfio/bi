# 工单：bi 0.3.0 测试执行接力（D 组会话状态 + F 组新器官装配面）

仓库 /home/yupeng/bi。前序单已完成 A/B/C 组（见 /tmp/test-results.md），你接力 **D 组（D1-D4）与 F 组（F1-F4）**。测试计划：docs/test-plan-0.3.0.md。

## 纪律（同前单）
- 只测不修；每项立刻追加进 /tmp/test-results.md（`| D1 | PASS | 证据 |` 格式，接在 B 组后面）
- 仓库版入口 `bun bin/bi.ts`；真模型会话先 `export BI_LONGCAT_API_KEY="$(cat ~/.bi-longcat-key)"`，opencode Go 偶发断流重试一次，连败两次记 SKIP-EXTERNAL
- 临时 config（~/.bi/config.toml）改动测完**必须还原**（记录原内容再改）
- 测试工作目录 /tmp/bi-bvt

## D 组要点
- D1 多轮：`bun bin/bi.ts -c --prompt "…"` 续上一会话（或 headless 两连跑验证记忆）
- D2 崩溃恢复：后台起会话（sleep 的 prompt 不行——用长任务 prompt），进程树 kill -9，然后 `bi session` 验最后条目完整（JSONL 可解析）
- D3 中断恢复：timeout -s INT 15 bi --prompt "写一篇 2000 字散文"（15 秒后中断），再 `bi -c --prompt "继续"` 验上下文自愈
- D4 权限门：config [permission] mode 改 manual（config set permission.mode manual——**注意 mode 五词面 default/plan/yolo/auto/manual 均合法**），让 bi 写文件应弹 ask→headless 结构化拒绝（permission-ask-unavailable 类错误=正确行为，记 PASS），测完 set 回 auto

## F 组要点（全部为装配面验证，允许最小脚本化）
- F1 插槽路由：config 临时加 `[secondary_model]` subagent 指向现有 provider/model（看 config.toml 现有条目照抄格式）+ `[subagent] enabled=true`，跑子代理任务观察 stderr 是否出现插槽装配日志行（`[slot-…`）；随后还原
- F2 AutoCompactor：`[context] auto_compactor=true` 下跑长输出会话（如"连续输出 500 行编号"）验证会话完成且无异常即可（水位触发靠 headless-context-wiring.test.ts 已验，这里只验开关链路），还原
- F3 image-offload：`[context] image_offload=true` 同上验证开关链路（配置存在且会话正常），还原
- F4 vis 令牌轮转：`BI_VIS_TOKEN_ROTATE=1` 后台起 `bun bin/bi.ts vis`，curl 首页/令牌端点看响应（有令牌校验行为即可），kill 干净

## 完成报告
- /tmp/test-results.md 追加 D/F 全部行+汇总行（三波合计 PASS/FAIL/SKIP 统计）
- FAIL 项详述（复现命令/预期/实际/定性）
