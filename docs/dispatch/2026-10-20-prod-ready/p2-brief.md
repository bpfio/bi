# 工单 PROD-2：11 子命令 usage/help 面 + 缺 key 错误指向 doctor（CLI 帮助面）

## 背景

bi（/home/yupeng/bi，Bun + TypeScript monorepo CLI Agent）主 help（`bi --help`）正常，
但生产 CLI 标配的「每子命令独立帮助」完全缺失：`bi config --help`、`bi upgrade --help`
等全部退回主 help 且 exit 0——用户无法发现各子命令的用法与选项。

## 硬约束（违反即废工）

1. 不改任何子命令的既有行为语义与退出码（只加帮助面）；缺省路径零回归。
2. 不许 git commit / git push。
3. 每个子命令的 usage 文案必须与该子命令真实参数面一致（先读各 handler 的参数解析代码再写，
   不许臆造选项）。

## 任务清单

1. **锚点**：`packages/core/src/cli/main.ts`（主分发 + 主 help 文本）、
   `packages/core/src/cli/commands/*.ts`（11 个子命令 handler 与各自参数解析）、
   `packages/core/src/cli/commands/args.ts`（参数解析底座）。
2. **11 个子命令**（init/session/fork/export/transfer/acp/upgrade/doctor/vis/config/copy）
   各支持 `--help` / `-h`：输出该子命令的用法行、参数说明、选项、2~3 个真实示例，
   exit 0。各子命令已有的 flag 解析里 `--help` 若会撞既有语义，按「帮助优先于用法校验」处理。
3. **未知用法**：各子命令在参数解析失败时保持既有结构化错误 + exit 2 形态
   （参考 `bi copy` 用法错误的现有实现 `packages/core/src/cli/commands/copy.ts`），
   错误尾部追加一行 `运行 bi <subcommand> --help 查看用法`。
4. **主 help 增强**：主 help 的子命令清单从单行名单扩为「子命令 + 一句话摘要」对齐列表
   （kimi/zcode 帮助排版风格，纯文本对齐）。
5. **缺 key 错误指向 doctor**：定位裸跑缺密钥报错的构造点
   （`grep -rn "api_key_env" packages/core/src | grep -v test` 找文案出处），
   报错文案尾部追加指引：`运行 bi doctor 可体检定位配置问题`。
   同样检查配置解析失败路径是否也值得挂此指引（不要过度，只在缺配置/缺凭据类错误挂）。
6. **测试**：为每个子命令的 `--help` 契约加测试（exit 0 + 输出含 usage 关键词），
   放各命令现有 .test.ts 旁；主 help 增强加断言。

## 验收门（自跑，全过才算完工）

- `BI_PTY_E2E=1 bun test` 全绿。
- `cd packages/core && bunx tsc --noEmit` 0 错误；`cd packages/tui && bunx tsc --noEmit` 0 错误。
- 11 个子命令逐个实测 `bun bin/bi.ts <sub> --help` 正常输出且 exit 0，留输出摘录。

## 报告

写 `docs/dispatch/2026-10-20-prod-ready/p2-report.md`：改动文件清单、11 子命令 help
实测输出（每个截前 5 行）、门禁数字、你定位到的缺 key 报错构造点文件:行号。
