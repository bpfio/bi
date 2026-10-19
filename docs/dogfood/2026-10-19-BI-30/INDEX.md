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

## 全量语料(2026-10-19 二次收纳)

- `briefs/` — 六份工单简报(t1 初版/t1 续作/t2 合并版/t2a/t2b/t3);
- `runlogs/*.log.gz` — 七次 bi 无头运行的控制台流日志(含 stream 事件全文);
- `transcripts/*.jsonl` — bi 会话转录(bi 自有会话格式,dogfood 原始凭证;泄漏扫描:仅 api_key_env 变量名,零密钥值)。

测试代码与测试样例本体随工单代码提交入库(agent-tui.test.ts +154、headless.test.ts +145、args.test.ts、sandbox/buildBin e2e 门控),随波推送 bpfio/bi。

## 终态增补(2026-10-19 关账)

- instance-C1-BI-30.2a-report.md — bwrap/buildBin 门控完成(四场景验证矩阵,50/0);
- codebuddy-hy3-review.md — codebuddy hy3 只读评审全记录(通过,零 high/medium);
- BI-30.2b(伪端点 openai e2e 根因)未竟:实例 C2 三轮被超时/终止截停,零编辑;诊断线索——失败路径疑似涉及 DeepSeekAdapter(openai kind 适配器选择链),断点简报 t2b-brief.txt,runlogs/t2b-run2.gz+t2b 终态日志待下会话续查;
- 全门禁终态:4320 pass/0 fail(228 文件)+双 tsc 0;代码提交 94cc84b。
