# bi 0.3.0 全功能测试 — B/D/F 组执行矩阵

测试者: 自动执行(CodeBuddy Code) | 仓库: /home/yupeng/bi | 入口: `bun bin/bi.ts`
环境: BI_LONGCAT_API_KEY 已注入(longcat free); 工作目录 /tmp/bi-bvt; 会话根 ~/.bi/sessions(543+ 历史)
纪律: 只测不修; 临时 config 改动均还原; 不触碰主仓。

## 矩阵

| 项 | 结果 | 证据(一句话) |
|---|---|---|
| B1 | PASS | config get/set/restore models.default=longcat→main→longcat 一致; 非法值(ptc.enabled=maybe)与未知键均 exit 2 |
| B2 | PASS | `bi config list` 列出 68 项键(exit 0); 计划判据写 66, 实际 schema 推导为 68, 命令本身正确(详见 FAIL/判据) |
| B3 | PASS | longcat 造会话 01a15971… 成功(exit 0); `bi session` 最新在前且含该会话 |
| B4 | PASS | `bi fork <sid> <node>` 生成新会话 01a15972…(exit 0) |
| B5 | PASS | export markdown(449B)/json(913B, JSON.parse OK)/html(3190B, <!DOCTYPE) 三格式均非空 exit 0 |
| B6 | PASS | `bi copy <sid>` / `-f title` 均 exit 0 且 stdout 降级(剪贴板工具缺失); 见 B6b 缺陷 |
| B7 | PASS | `bi transfer --help` 输出脱敏导出/导入 usage(exit 0) |
| B8 | PASS | `bi upgrade --help` 输出 manifest→sha256→原子换装 usage(exit 0) |
| B9 | PASS | `bi copy --bogus` exit 2 + 提示 `bi copy --help`(未知旗标不再静默) |
| B6b | FAIL | `bi copy <sid> -f last-reply` 输出空(见下详述) |
