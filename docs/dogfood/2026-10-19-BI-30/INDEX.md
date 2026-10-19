# BI-30 dogfood 运行记录索引(2026-10-19)

bi 修 bi 生产标冲刺的实例结论文档(主控验收记录见 DEVLOG.md 第十三节)。

| 文件 | 内容 | 状态 |
|---|---|---|
| instance-A-BI-30.1-report.md | 斜杠命令执行面 {prompt} 契约(断点续作;tui 520/0) | 主控复验通过 |
| instance-B-BI-30.3-report.md | --output-format 实装(args+headless 31/0) | 主控复验通过 |
| instance-C1-BI-30.2a-report.md | bwrap/buildBin 门控 | 跑动中 |
| instance-C2-BI-30.2b-report.md | 伪端点 openai e2e 根因诊断 | 跑动中 |

运行环境:合成 HOME(密钥仅经 BI_MIMO_API_KEY 环境注入,配置零明文),mimo-v2.6-flash messages 协议;
主控脚手架:--max-rounds 旗标(dogfood 发现 #1,回合上限 8 不可调)。
