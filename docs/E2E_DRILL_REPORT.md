# BI-21 工位 H —— 终局端到端全流程演练报告(宏观政策与数据审计)

- 演练套件:`packages/core/src/evals/e2e-drill.test.ts`(bun test 可跑)
- 夹具:`packages/core/src/evals/fixtures/e2e-drill/`(HTML 公报 / 双栏版面 JSON 生成器 / xlsx 生成器 / 单一数字源 drill-data.ts)
- 演练结论:**通过**。演练链 6/6 全绿,93 条断言;全仓门禁三绿(见文末)。
- 隔离纪律:演练产物(研报/探针)只落演练 worktree,主仓库零污染;全程无 git commit,收尾后 `git worktree list` 仅剩主仓、无 `bi-task-*` 分支残留。

## 0. 夹具与单一数字源

真实网络不可保证,按工单以高保真夹具替代外网(内置真实公报结构:红头、文号、指标表);**被测组件全部走真实代码路径**,端口注入仅限 I/O 边界(fetch 执行器 / 视觉 judge / doctor 探测端口)。

单一数字源 `drill-data.ts`(三链共用,任一环节丢字/改数即被逐字断言击穿):

| 项 | 值 |
| --- | --- |
| 公报标题 | 2026年前三季度国民经济运行情况 |
| 文号 | 国统字〔2026〕87 号 |
| GDP | 本期 953680 亿元 / 上期 910000 亿元 / 同比 4.8%(953680 − 910000 = 910000 × 4.8% 整数精确) |
| 社零总额 | 353564 亿元 / 同比 3.2% |
| 工业增加值增速 / 投资增速 | 5.9% / 2.1% |
| 账簿 | 合计:65000 + 25000 = 90000;借贷:∑借 = ∑贷 = 90000;同比表含 65500/62500 = 4.8% |

## 1. 链 1 —— Worktree 隔离(bi-drill 演练分支)

- 组件:`@bi/worktree` 引擎 `WorktreeEngine`(真实 `git worktree add`,gitRunner 走真实 execFile git,零注入)。
- 实测:`create("bi-drill")` → 分支 `bi-task-bi-drill`,worktreePath 落于注入的临时工作树池,baseCommit 为 40 位提交号;`engine.list()` 台账与 git 物理事实一致。
- 隔离证明:探针文件 `DRILL_PROBE.txt` 写入 worktree 后,主仓库根目录不可见(断言双面)。
- 收尾:`afterAll` 中 `discard()` 物理清空 —— 断言 `removed=true, branchDeleted=true, 路径消失`;实测 `git worktree list` 仅 `/home/yupeng/bi`,`git branch --list "bi-task-*"` 为 0 条。

## 2. 链 2 —— 政策获取(web-fetch → htmlToMarkdown)

- 组件:`fetchWebPage`(packages/core/src/tools/web-fetch.ts),注入伪 fetch 返回内置 `gazette.html`(fetch 为允许注入的 I/O 边界,重定向/超时/流截断等引擎逻辑全部真实执行)。
- 实测:`content-type: text/html` → 走 `extractReadable`(镀铬剥离)→ `htmlToMarkdown` 流式引擎。
- 断言证据:
  - `<title>` 抽出 `2026年前三季度国民经济运行情况_国家统计局公报`;
  - 文号 `国统字〔2026〕87 号` 与全部指标字面量(953680 / 353564 / 4.8% / 5.9% / 3.2% / 2.1%)逐字保留;
  - GFM 指标表行 `| 国内生产总值 | 953680 | 4.8 |` 逐字保真;
  - 镀铬剥离生效:nav 的「友情链接」与 footer 的「网站标识码」未进入主内容;
  - 字节计量 1563 字节入账,无截断告警。

## 3. 链 3 —— 双栏公报抽取(pdf_extract.py)

- 组件:`presets/plugins/pdf/scripts/pdf_extract.py`(真实 python3 子进程,`--columns 2 --format json`)。
- 夹具:`gazette-layout.ts` 生成器产出版面 JSON(页宽 840×1188):页眉/页脚/页码噪声 + 通栏(红头大标题/文号/指标导语)+ 左右双栏正文。
- 断言证据(0 误差):
  - 退出码 0,stderr 为空;
  - **阅读序逐行精确比对**:通栏(标题 → 文号 → 指标导语)→ 左栏自上而下(一、总体运行平稳 → 初步核算… → 二、工业生产加快 → …)→ 右栏自上而下(三、市场销售回暖 → … → 四、投资结构优化 → …),与期望序 `expectedReadingOrderLines()` 完全相等;
  - 页眉「国家统计局公报」、页脚「版权所有」、页码「3」全部剥离;
  - 指标数字与文号逐字保真(全部 8 个规范字面量 contains 断言通过)。

## 4. 链 4 —— 财报勾稽(xlsx_audit.py 正反两向)

- 组件:`presets/plugins/spreadsheets/scripts/xlsx_audit.py`(真实 python3 子进程,openpyxl 读账)。
- 夹具:`gen_drill_xlsx.py` 生成三表账簿(合计/借贷/同比);生成器源码内数字字面量与 `drill-data.ts` 逐字同源(夹具自身受 0 误差断言约束)。
- 正向:三张表逐表审计(合计/借贷/同比)全部 `exit=0`、`errors=0`。
- 反向(0 容忍):`--corrupt` 注入一处故意错账(合计 90000 → 90050)→ **exit=1**,JSON findings 精确定位:

```json
{
  "rule": "total_check", "severity": "error", "row": 4,
  "detail": "第 4 行第 2 列合计不符:应为 90000,表载 90050"
}
```

  行号(第 4 行=合计行)与列号(第 2 列=金额列)双双命中注错位置;借贷/同比两规则在合计表上正确降级为 info,不制造噪声。

## 5. 链 5 —— 研报生成(三链产物组装)

- 汇聚链 2/3/4 的真实输出(web markdown / pdf 阅读序文本 / 审计 JSON)组装为研报 Markdown,落盘于**演练 worktree** 的 `docs/DRILL_RESEARCH_REPORT.md`(隔离落盘,主仓库 `docs/` 断言不含该文件)。
- 研报内含:政策获取章节(标题/文号/核心表述)、版面抽取章节(阅读序全文)、勾稽审计章节(三表 exit=0 + 注错定位 detail)、三源 0 误差比对表(GDP 绝对额/同比/社零在 web·pdf·账簿三源逐字一致)与结论。
- 断言:落盘存在性、worktree 隔离、全部规范字面量、注错行号与 `exit=1` 证据均在文中。

## 6. 链 6 —— 核验与体检(交付前置门)

- **visual-judge**(presets/plugins/visualize/visual-judge.ts,注入伪 judge——允许的视觉模型 I/O 边界):
  - 纠偏重跑:首轮判 `clip`(柱体出界)→ retune 按.fixHint 加高 400→520 → 二轮 pass;断言 `status=passed、rounds=2、history=[fail, pass]、params.height=520、render 调用序列 [400, 520]`。
  - 反向:judge 持续 fail 且超限 → 升级 `failed` 且 issues 原样带出(核验门不放过坏图)。
- **runDoctor**(packages/core/src/doctor.ts,四端口全注入,零真实 IO):
  - 健康态:网络可达/凭据有效期/Python 环境/工作区完整性四项全 ok,`allOk=true`,检查名与 `DOCTOR_CHECK_NAMES` 精确一致;
  - 劣化态:网络探测端口不通 → `allOk=false` 且该检查项携带修复建议(体检门拦下带病交付)。

## 7. 演练暴露的缺陷与修复(最小改动面)

| # | 缺陷 | 位置 | 修复 |
| --- | --- | --- | --- |
| 1 | 审计明细金额以 `%.4g` 格式化,90000 输出为 `9e+04`,财务审计场景可读性不可接受(行/列定位本身正确) | `presets/plugins/spreadsheets/scripts/xlsx_audit.py` | 新增 `_fmt()`(定点去尾零),替换 3 处 `.4g`:total_check 应为/表载、debit_credit 借贷两和与差额、yoy_mom 分母为 0 提示。修复后明细:`应为 90000,表载 90050`。属小缺陷,按健康协议直接修复并在此备案 |

除上表外,各链组件(web-fetch/htmlToMarkdown、pdf_extract.py、WorktreeEngine、visual-judge、runDoctor)在演练中行为与合约一致,未发现其他缺陷。修复后全仓回归三绿。

## 8. 全仓门禁(三绿)

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 全仓测试 | 仓库根 `bun test` | **4036 pass / 0 fail**,199 文件,49201 expect,含本演练 6 例 |
| core 类型 | `cd packages/core && bunx tsc --noEmit` | exit 0 |
| tui 类型 | `cd packages/tui && bunx tsc --noEmit` | exit 0 |

## 9. 演练清单复核

- [x] 链 1 worktree 隔离(bi-drill 分支,真实 git,收尾零残留)
- [x] 链 2 政策获取(伪 fetch 注入,htmlToMarkdown 主内容,标题/文号/指标逐字)
- [x] 链 3 双栏抽取(真实 python3,阅读序逐行 0 误差,噪声剥离)
- [x] 链 4 财报勾稽(xlsx 三表 exit=0;注错 exit=1 且定位第 4 行第 2 列)
- [x] 链 5 研报生成(worktree docs/ 落盘,三源 0 误差比对)
- [x] 链 6 核验体检(visual-judge 纠偏重跑 + failed 升级;runDoctor 注入端口正反两向)
- [x] 全仓门禁三绿
- [x] 纪律:未读 references/ 母体源码;未 git commit;改动面仅 packages/core/src/evals/ 新增 + xlsx_audit.py 最小修复 + 本报告
