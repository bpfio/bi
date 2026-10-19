# D4 修复报告 / CI-GREEN-1:CI 第二层三项环境假设缺陷

- 派发:2026-10-19,codebuddy hy3 写模式(`-y`),cd /home/yupeng/bi;原始输出:`/tmp/d4-ci-onion.log`(3050B)
- 简报:`d4-ci-onion-brief.txt`;工时:约 8 分钟,免费模型

## 修复内容(主控亲验 diff + 复跑)

1. **D5 沙箱探针 errorKind 字面量漂移**:根因=测试白名单硬编码了探针从不产出的 `binary-not-found`/`bwrap-not-functional`,漏掉真实产出的 `binary-missing`/`userns-unsupported`/`workspace-root-missing`(双源漂移)。处置=os-sandbox.ts 导出唯一事实源常量 `SANDBOX_PROBE_ERROR_KINDS`(6 值,注明 probe-failed 仅类型层),测试改引用常量。
2. **BI-21 链4/链5**:根因=gen_drill_xlsx.py 与 xlsx_audit.py 需第三方 openpyxl,CI 无 pip 步骤→SystemExit(2);链5 纯连带。处置=ci.yml setup-python 后增 `python -m pip install openpyxl`。

改动:3 文件 +23/-5(ci.yml +2、os-sandbox.ts +15、e2e-drill-d-sandbox.test.ts ±5)。

## 值得记录的行为样例

D4 发现主控简报里的**文件路径笔误**(白名单实际在 e2e-drill-d-sandbox.test.ts:181,非简报所写 os-sandbox.test.ts:181)——它核实后判定属同一缺陷面,做了正确修复并**显式申报偏差+提供替代方案**,而非静默越界或中止。此为写模式派工的理想行为样本,已记入 dispatch skill 无需新增条款(策划三问第 2 条"验收手段先定"已覆盖:主控以 git diff 亲验为准)。

## 验证

- 主控亲验:本机 `BI_PTY_E2E=1 bun test` 三套件 **38 pass / 0 fail**(240 expect);
- D4 自验:本机 38/0 + worktree 模拟 CI 38/0(并诚实标注 worktree 内 pip 受 PEP 668 限制、openpyxl 本机预装的等价性说明);
- 终验=CI 实跑(workflow 触发),见本报告附录。

**附录(2026-10-19 补)**:CI run 39220601240(commit 429562c)**全绿**(gates 1m0s success)——近期首条全绿 CI,CI-GREEN-1 闭环。
