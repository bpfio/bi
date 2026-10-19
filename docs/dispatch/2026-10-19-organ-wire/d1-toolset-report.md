装配完成，验证通过。结论清单如下。

## 改动文件清单
- `packages/core/src/interaction/ask-user-tool.ts` — `AskUserTool` 新增 `interactive` 选项 + headless 降级分支；`AskUserToolResult` 增加 `{answered:false, reason:"no-interactive"}` 变体。
- `packages/core/src/cli/toolset.ts` — 接入 `matchOldText`(edit 阶梯)、`UserQuestionService`/`AskUserTool`(ask 装配)；`BuildDefaultToolsetOptions` 增 `userQuestionService`/`askUserInteractive`；`buildDefaultToolset` 条件注册 ask；新增 `askUserBinding`。
- 新增 `packages/core/src/cli/tool-staircase.test.ts`（edit 阶梯覆盖）。
- 新增 `packages/core/src/cli/ask-user-tool-degrade.test.ts`（ask 注册门 + 降级 + 校验）。
- **既有测试文件零改动**；边界器官（见下）零触碰。

## 阶梯各级语义（一行表）
| 级 | 语义 |
|---|---|
| 1 exact | 精确子串匹配（走既有逐字节不变路径，结果不含 matchLevel） |
| 2 quote_normalized | 中英弯↔直引号双向归一 |
| 3 line_number_stripped | 剥离行首 `N→`/`N:` 行号前缀 |
| 4 whitespace_normalized | 制表符→4空格 + 剥行尾空白 |
| 5 indentation_flexible | 块级 dedent（相对缩进保留、绝对缩进重锚） |
| 6 line_trimmed | 逐行 trim 后整块比较 |
| 7 block_anchor | 首尾锚行精确 + 中段相似度≥0.8 模糊对齐 |
| 8 context_fallback | 唯一上下文行 ±2 窗口重锚（窗口可能小于 oldText，按锚窗替换） |

命中后照常走既有替换校验（0 命中→`edit-no-match`；歧义且非 replace_all→`edit-ambiguous`）；每级命中结果附 `matchLevel` 备注，不改成功/失败语义；替换仅替换唯一匹配切片，四周字节原样保留。

## ask_user 降级语义
- **条件注册**：仅当注入 `userQuestionService` 才挂 `AskUserQuestion`（缺省 8 件注册表面不变，保住既有注册表测试零改动）。
- **headless 安全**：`interactive=false`（无 TTY/headless）时 `run` 直接结构化返回 `{answered:false, reason:"no-interactive"}`，**不调用 `service.ask`**（block 不会挂起），不悬挂不抛；`service.pending()` 为空（无 IO 回调）。
- **可交互**：非法结构→`ok:false invalid-request`；block→host 注入 `resolve` 落定 `ok:true+answers`。
- 默认不改变其他工具行为。

## 测试数 + tsc
- 新增 2 文件共 **18 用例**（精确/各级降级/全不命中/降级歧义+replace_all；注册门/headless 降级/可交互校验+block 全流程）。
- `bun test ./packages/core/src/`：2776 跑，**仅 2 失败**——均为 `BI-21` e2e 演练（链4 `xlsx_audit.py` 因环境缺 `openpyxl` 退出非 0、链5 级联），与本次装配无关（不使用 edit/ask）。其余全绿，既有 edit/registry/interaction 用例零改动通过。
- `bunx tsc --noEmit`：**0 错**。

## 未尽边界
- **未触碰**：`cli/commands/**`(D2)、`cli/main.ts`、`cli/headless.ts`、`agent.ts`(D3)、subagent/cron/verifier/observability/context 各器官。
- ask 在运行环的真实接线（main/headless/agent 注入 `userQuestionService` + TTY 判定）归并行 D3；本卡完成**构建面装配 + 降级安全**，运行环接线待 D3。
- 降级级歧义 + `replace_all=true` 时按 `onAmbiguous:"first"` 取首处单点替换（较精确 replace_all 全量替换更保守），已在代码注释说明。
- 未 commit 未 push（按约束）。
- 若需全量全绿：环境需装 `python3 -m pip install openpyxl`（BI-21 两失败纯属该缺失依赖）。
D1X_EXIT=0
