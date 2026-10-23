# EVAL-0 简报：bi 任务级评测语料设计（只读设计单）

角色：bi 项目评测设计顾问。本单为只读设计单。

## 铁律
- 只读：/home/yupeng/bi 仓库源码只许读，禁止修改任何既有文件；禁止 git commit / git push。
- 唯一可写产出：docs/dispatch/2026-10-21-campaigns/eval0-design.md（目录已存在，直接写入）。
- **格式从简，先落盘后润色**：设计文档一次成型直接写入文件，不要在格式自省上循环；写完后 stdout 只打印「结论清单」（≤40 行：交付物路径 / 语料条数 / 领域分布 / 首批 10 条编号 / 未核实项清单）。
- 未核实的推断必须标注「未核实」；引用代码一律给 file:line。
- 预计 20-30 分钟。

## 背景
- bi = Bun/TypeScript monorepo CLI Agent（npm @bpfio/bi）。Headless 形态：`bun bin/bi.ts --prompt "<任务>" --output-format stream-json`。
- 差距评估结论：「测的是器官，没测任务」——4979 个单测全绿，但零任务级评测，无法回答「这周比上周好吗」。
- 现状锚点：packages/core/src/evals/eval-harness.ts 是完整评测框架但全仓零 EvalCase 语料；evals/ 目录只有 e2e-drill 集成测试。
- 目标：设计 20-30 条任务级评测语料 + 可执行判据体系，成为 bi 的回归基线（真模型轨每周窗口跑，不进每提交 CI；零网络伪端点轨可日常跑）。

## 必读（只读）
1. packages/core/src/evals/eval-harness.ts —— 框架 API：EvalCase 形态、执行与评分缝
2. packages/core/src/cli/headless.ts —— runner 将经 headless 驱动；stream-json 事件面（session_done / usage 字段）
3. scripts/fake-endpoint.ts —— 零网络轨回环基建（startFakeEndpoint 契约）
4. docs/dispatch/2026-10-20-excel-wave/k2-methodology.md 第 6 章 —— 度量指标 M3 回合效率 / M4 token 的定义与基线纪律

## 产出：eval0-design.md 结构
1. **语料总盘表**：20-30 条，列 = 编号 / 领域（bug 修复 / 特性小改 / 重构 / 调研问答 / 工具面 / 安全面）/ 难度(S/M/L) / 判据类型 / 轨道（伪端点轨 | 真模型轨 | 双轨）
2. **每条任务**：--prompt 原文（可直接当命令行参数用）/ 成功判据（shell 可判定：文件存在 + 内容断言 / 命令退出码 / 测试通过）/ 补丁正确性判定法 / 预计回合数
3. 其中 **≥8 条以 bi 自仓为靶**（dogfood：如「给某工具加某参数并让对应测试通过」）；其余用临时小仓库夹具场景（判据必须能在夹具上机器判定）
4. **eval-harness 对接缝分析**：现有 API 缺什么（语料 schema / 判据执行器 / 补丁提取 / 计分），逐条列「需新增」——只设计，不实现
5. **首批落地建议**：先做哪 10 条，每条一句理由
6. **诚实边界**：哪些判据无法自动化、哪些必须真模型轨、已知判据漏洞（例如模型把期望内容 cat 出来而不是真的改文件）

## 完成标准
- eval0-design.md 已写入上述路径
- stdout 已打印结论清单
