# 工单：bi 0.3.0 全功能测试执行（B/D/F 三组矩阵）

仓库 /home/yupeng/bi。测试计划：docs/test-plan-0.3.0.md（先通读）。你负责执行 **B 组（CLI 子命令面）、D 组（会话与状态）、F 组（新器官装配面）**，A/C/E/G 组由他人负责不要碰。

## 环境与执行纪律
- 仓库版入口：`bun bin/bi.ts`（下称 bi）；涉及真实模型会话时先 `export BI_LONGCAT_API_KEY="$(cat ~/.bi-longcat-key)"`（默认模型 longcat，走 opencode Go，偶发断流重试一次即可，连续两次失败记 SKIP-EXTERNAL 不要硬刷）
- 测试工作目录：`mkdir -p /tmp/bi-bvt && cd /tmp/bi-bvt`（B 组 export/fork 等会造会话数据，别污染主仓）
- **只测不修**：发现 FAIL 只记录（现象+复现命令+预期 vs 实际），绝不改产品代码
- 每项跑完立刻把一行结论追加进 /tmp/test-results.md（格式：`| B3 | PASS | 证据一句话 |`），防中途断掉丢记录

## 各组执行要点
- **B 组**（B1-B9）：B3 session 需先造一条会话（跑一次最小 `bi --prompt "hi"`，longcat 短会话）；B4 fork/B5 export/B6 copy 用造出的 sessionId 逐个跑；B7/B8 只验 usage 不真跑；B9 验未知旗标拒绝
- **D 组**（D1-D4）：D1 多轮=同会话两轮（用 `-c` 续会话或 headless 两连跑+session 上下文——按 bi 实际能力面设计，能验证"后轮记得前轮信息"即可）；D2 崩溃恢复=起一个会话进程 sleep 期间 kill -9 再 `bi session` 看最后一条完整；D3 中断恢复=长任务 Ctrl-C 模拟（timeout 发 SIGINT）后用 `bi -c` 续问；D4 权限门=config [permission] mode=manual 临时写入 ~/.bi/config.toml 测完**必须还原**
- **F 组**（F1-F4 装配面验证）：F1=临时 config 加 secondary_model.subagent 指向真实可用条目+subagent.enabled=true，跑子代理任务看 stderr 插槽日志，测完还原；F2/F3=两开关临时开启+模拟长会话（可注入脚本化验证，不必真造十万 token——验证开关链路通即可），测完还原；F4=`BI_VIS_TOKEN_ROTATE=1 bun bin/bi.ts vis` 起服务 curl 令牌校验面（后台起、验完 kill），测完还原
- **所有临时 config 改动测完必须还原**，还原后 `git -C /home/yupeng/bi status --short` 确认仓库无残留（~/.bi/config.toml 不在 git 内，但要复原内容）

## 完成报告
- /tmp/test-results.md 完整矩阵表 + 末尾汇总行（PASS/FAIL/SKIP-EXTERNAL 各几项）
- FAIL 项单独详述：复现命令、预期、实际、初步定性（产品缺陷/环境/计划判据问题）
