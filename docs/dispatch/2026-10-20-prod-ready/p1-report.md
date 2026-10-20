# PROD-1 完工报告：README 生产化重写 + example 配置纠偏（文档面）

日期：2026-10-20 ・ 工单：`docs/dispatch/2026-10-20-prod-ready/p1-brief.md`
边界：仅动 `README.md`（重写）、`setting.example.json` / `provider.example.json`（删除）；
零 .ts 改动；未 commit / 未 push（`git status` 留交主控验收）。

## 一、改动清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `README.md` | 重写 | 见下 |
| `setting.example.json` | 删除（工作树 `rm`，未 `git rm`） | zcode JSON 遗留形状，与 bi TOML 体系不符 |
| `provider.example.json` | 删除（工作树 `rm`，未 `git rm`） | 同上 |

README 具体变更：

1. **「当前状态」段重写**：删「init/session/fork/export/transfer/acp/upgrade/doctor
   子命令尚未接线（exit 4）」「TUI 装配中」「211 个测试文件」三条过时断言，改为
   实测现状：11 子命令全部经 `runBi` 查表派发真实接线；两种会话形态（`--prompt`
   无头 / 无参 REPL）；三级 TOML + env 覆盖 + `api_key_env` 间接引用；质量门实数
   （253 测试文件 / 4621 用例）。
2. **新增「快速上手」节（四步）**：`bun install` → `bun bin/bi.ts init`（产物
   `.bi/local.toml` + `BI.md` 草稿，均已存在不覆盖）→ 配置 provider（三级 TOML
   路径表 + `api_key_env` 间接引用 + 最小 TOML 示例 + `bi doctor` 验证）→ 首单
   跑通（`MY_PROVIDER_API_KEY=... bun bin/bi.ts --prompt "..."` 无头 + 无参 REPL）。
3. **新增「子命令一览」节**：11 个子命令 + 一句话职责表，顺序与
   `bun bin/bi.ts --help` 输出逐字一致；附统一退出码语义（0/1/2/3/4）。
4. **新增「配置参考」节**：42 键按 16 分组列表（`bi config list` 实测导出）；
   六个挂载式分区（`[verify]`/`[subagent]`/`[ptc]`/`[cron]`/`[context]`/`[memory]`）
   config-gated 缺省关说明；10 个 env 覆盖变量。**按现状 42 键写，未臆造在途工单
   将补的六分区键。**
5. **「开发」段**：保留四条命令（全部复跑通过）。
6. **「仓库结构」表**：`packages/tui` 行由「装配挂载中」更新为 REPL 主路径现状；
   `bin/bi.ts` 行补「无参 = REPL；带参 = runBi 分发」。

## 二、每条示例实测输出摘录

> 环境：仓库根 `/home/yupeng/bi`，bun v1.3.14 (0d9b296a)。
> 无头/REPL/doctor/config 全链路回环用 `scripts/fake-endpoint.ts` 本地伪端点
> （127.0.0.1 随机端口，零网络零真实密钥，与 BI-26.2 e2e 同驱动器）驱动，
> 临时 HOME 写最小 config.toml（`api_key_env = "BI_DEMO_API_KEY"`，kind=anthropic）。

### 1. `bun install`

```
bun install v1.3.14 (0d9b296a)
Checked 16 installs across 15 packages (no changes) [30.00ms]
```
exit=0；`git status` 无新增改动（工作树仅剩本单三文件变动）。

### 2. `bun bin/bi.ts init`（在 /tmp 空目录实测，避免污染共享工作树）

```
bi init: 已写入工作区模板 /tmp/bi-init-demo/.bi/local.toml
bi init: 已生成 BI.md 草稿 /tmp/bi-init-demo/BI.md（待人工审查，确认后生效）
```
exit=0。`.bi/local.toml` 内容 = 工作区模板（三级拓扑注释 + `[workspace]`
additional_dir / respect_gitignore）。空目录无栈清单 → stderr 结构化提示
「未检测到支持的栈清单…」，BI.md 标注「未检测到」，不假冒检测结果。
二次执行（幂等）：「已存在，不覆盖」×2，exit=0。
含 package.json 的目录实测：BI.md 正确识别 `语言：javascript / 清单文件：package.json /
构建命令：tsc`。

### 3. 配置装载验证 —— `bun bin/bi.ts doctor`

最小 TOML（与 README 示例同构，临时 HOME）全绿：

```
BI Doctor 体检报告
──────────────────
✓ 配置装载 — config.toml 已装载: 1 provider / 1 model,默认模型 main(provider demo,messages 协议)
✓ 凭据门 — provider "demo" 凭据已解析(api_key_env=BI_DEMO_API_KEY 已在位)
✓ 所配 provider 网络 — 127.0.0.1 (127.0.0.1:41353) DNS/TCP 可达
✓ 沙箱探针 — 沙箱后端可用: landlock (abi=5 (mask-bisect))
✓ 工具注册面 — 8 个工具注册: read_file, web_fetch, web_search, glob, grep, bash, edit, write
汇总: 5/5 通过 — 全部健康
```
exit=0。真实 HOME（有 ~/.bi/config.toml、未导出密钥）复跑：配置装载 ✓（2 provider /
1 model）、凭据门 ✗ 携带修复指引（`BI_MIMO_API_KEY 未设置`）、网络级联 ✗、沙箱 ✓、
工具 ✓，exit=1 —— 证明「配置装载可验证、密钥只走环境变量」两项目标均按契约工作。

### 4. `bun bin/bi.ts config get models.default`

```
main
```
exit=0。（真实 HOME 的 `config list` 实测输出 42 行，即「配置参考」节键面来源。）

### 5. 首单·无头 —— `BI_DEMO_API_KEY=dummy bun bin/bi.ts --prompt "用一句话介绍 bi"`

```
# stdout（JSONL 事件流）
{"type":"usage","usage":{"inputTokens":8}}
{"type":"content_delta","delta":"ECHO:用一句话介绍 bi"}
{"type":"usage","usage":{"outputTokens":3}}
{"type":"done","stopReason":"stop"}
{"type":"session_done","sessionId":"01a156da-...","exit":"ok","rounds":1,"finalText":"ECHO:用一句话介绍 bi"}
# stderr（装配面）
bi: 模型已装配 provider=demo mode=messages model=demo-echo
```
exit=0。`--output-format stream-json` 显式形态同样 exit=0。

### 6. 首单·REPL —— `bun bin/bi.ts`（无参）

stderr 出装配行 `bi: 模型已装配 provider=demo mode=messages model=demo-echo`，
stdout 进入 REPL 界面（`[manual] 就绪 ❯ ▏`）；stdin EOF 收束 exit=0。
退出键语义经源码核实（repl.ts:28-29/657-660）：空草稿 Ctrl+C / Ctrl+D 退出，
Esc 二段退会话。

### 7. `bun bin/bi.ts --help`（子命令一览的事实来源）

```
子命令: init / session / fork / export / transfer / acp / upgrade / doctor / vis / config / copy
```
README 表格顺序与此逐字一致。`bun bin/bi.ts --version` → `bi 0.2.0`（exit=0）。

### 8. 其余子命令行为抽查（一句话职责的佐证）

- `bi upgrade --check`（无 manifest 源）→ exit 4 + 结构化提示「未配置 manifest 源…」；
- `bi export` / `bi fork` 缺位置参数 → exit 2 + 用法行；
- `bi nosuch` → 「未知子命令 "nosuch"」+ usage，exit 2；
- `bi copy`（无剪贴板工具）→ 会话 id 打 stdout + 「剪贴板工具缺失，已打印到 stdout」，exit=0；
- `bi session` → JSONL 行 + stderr 汇总「共 3 个会话」；
- `bi vis --port 18321` → 「bi vis: 已启动 → http://127.0.0.1:18321/」，
  `curl /api/sessions` → `[]`，`curl /` → 单文件 HTML；
- `bi config set thinking.effort high`（临时 HOME）→ 写回 `~/.bi/config.toml`
  （注释保留：`# 初始` 仍在，追加 `[thinking] effort = "high"`），
  `config get thinking.effort` → `high`；未知键 → exit 2 并列出 42 个合法键。

## 三、删除两 example 的理由确认

- `setting.example.json`：`storage.dir = "~/.zcode"`、`storage.sessionDbPath =
  "~/.zcode/cli/db/db.sqlite"` 等键全部属于上游 zcode JSON 配置体系；bi 的存储根是
  `~/.bi/sessions`（JSONL 会话），配置体系是三级 TOML（`~/.bi/config.toml` /
  `~/.bi/tui.toml` / `.bi/local.toml`），二者无任何对应关系，留之即误导。
- `provider.example.json`：`providerConfigRules` / `modelConfigRules` /
  `defaultModelSelection` 嵌套 JSON 规则树，是 zcode 的 provider 注册形状；bi 的
  provider 形状是 TOML 的 `[providers.entries.<name>]`（`api_key_env` / `base_url` /
  `kind` / `models`）+ `[models.entries.<id>]`，密钥只经环境变量间接引用。
- 两文件的键面在 bi 代码库中零引用（`Grep providerConfigRules|storage.dir` 无 bi 侧
  消费方；config schema 为 `packages/core/src/config/schema.ts` 的 sObj 树）。
- 真实配置形态已在 README「快速上手」第 3 步讲清（三级 TOML 路径 + api_key_env +
  最小示例 + doctor 验证），删除无信息损失。按工单要求仅工作树 `rm`，未 `git rm`。

## 四、验收门输出（末尾数字）

| 门 | 命令 | 结果 |
| --- | --- | --- |
| 过时断言零命中 | `grep -n "尚未接线\|211 个测试文件" README.md` | 零命中（grep exit=1） |
| 文档链接 | README 全部 11 处相对链接逐条 `-e` 校验 | 11/11 OK（LICENSE、devplan.md、DEVLOG.md、docs/RESEARCH.md、docs/FIVE_AGENTS_FULL_SPECTRUM_ANALYSIS.md、docs/E2E_DRILL_REPORT.md、docs/UPSTREAM_ANCHORS.md、LICENSES/README.md） |
| 命令示例可执行 | 本文第二节 8 组逐条实跑 | 全部按 documented 形态退出（0/1/2/4 均符合各自契约） |
| 测试全绿 | 仓库根 `bun test` | `4618 pass / 3 skip / 0 fail`，`Ran 4621 tests across 253 files. [80.51s]`（3 个 skip 为门控 e2e：BI-26.4 pty、BI-26.2 伪端点 ×2，缺省跳过非本单引入） |
| 根类型门 | `bun run typecheck` | exit=0（`$ tsc --noEmit -p tsconfig.json`） |
| core 类型门 | `cd packages/core && bunx tsc --noEmit` | 0 错误，exit=0 |

## 五、边界与未尽事项

- 未 commit / 未 push；`git status --porcelain` = `M README.md` + `D provider.example.json`
  + `D setting.example.json`，交主控验收后提交。
- `bun bin/bi.ts init` 在 /tmp 空目录实测（同命令同形态）；未在仓库根执行以免产生
  未跟踪的 `BI.md` 污染共享工作树（`.bi/` 已 gitignore，`BI.md` 未 ignore）。
- 「配置参考」按现状 42 键撰写；在途工单将为 config 键面补六分区（挂载式分区键届时
  经 `bi config list` 实测后另行更新 README，本单不预写。
- 门控跳过的 3 个 e2e（BI-26.2/BI-26.4）可用 `BI_PTY_E2E=1 bun test` 打开回归，
  其驱动器（scripts/fake-endpoint.ts）即本单无头实测所用。
