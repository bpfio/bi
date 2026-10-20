# 工单 PROD-2 报告：11 子命令 usage/help 面 + 缺 key 错误指向 doctor

- 日期：2026-10-20
- 仓库：`/home/yupeng/bi`（Bun + TypeScript monorepo CLI Agent）
- 约束遵守：未改任何子命令既有行为语义/退出码（只加帮助面，缺省路径零回归）；未执行 git commit / push；usage 文案严格对照各 handler 真实参数解析（先读源码再写，未臆造选项）。

## 一、改动文件清单

### 核心改动（本工单）
| 文件 | 改动 |
| --- | --- |
| `packages/core/src/cli/commands/dispatch.ts` | 新增 `SUBCOMMAND_SUMMARIES`、`SUBCOMMAND_HELP`（`SUBCOMMAND_HELP_FLAGS`）；`handleSubcommand` 入口拦截 `--help`/`-h`（帮助优先于用法校验，exit 0）；`SubUsageError` catch 追加 `运行 bi <sub> --help 查看用法`（按类名兜底兼容 vis 自带同名 `SubUsageError`，避免跨模块循环依赖）。 |
| `packages/core/src/cli/main.ts` | 主 help `USAGE` 由单行名单升级为对齐「子命令 + 一句话摘要」列表（复用 `SUBCOMMAND_SUMMARIES`）；重构顶层 `--help` 短路逻辑，使 `bi <sub> --help` 不再被主 help 截走、正确路由到子命令 help。 |
| `packages/core/src/config/config-service.ts` | `resolveProviderApiKey` 缺 `api_key_env` 凭据错误（`config-service.ts:206`）尾部追加 `运行 bi doctor 可体检定位配置问题`；配置解析失败错误（`config-service.ts:337`）同理追加（doctor 的「配置装载」检查项直接覆盖此情形）。 |
| `packages/core/src/cli/model-port.ts` | 缺 `api_key_env` 凭据错误（`model-port.ts:70`）尾部追加 `运行 bi doctor 可体检定位配置问题`。 |
| `packages/core/src/cli/commands/vis.ts` | `--port` 非法分支（exit 2）追加 `运行 bi vis --help 查看用法`（help 优先已统一在 dispatch 层处理）。 |
| `packages/core/src/cli/commands/config.ts` | `ConfigUsageError` / `UnknownConfigKeyError`（exit 2）追加 `运行 bi config --help 查看用法`。 |
| `packages/core/src/cli/commands/copy.ts` | `CopyUsageError` / `InvalidFieldError`（exit 2）追加 `运行 bi copy --help 查看用法`。 |

### 测试改动（本工单）
| 文件 | 改动 |
| --- | --- |
| `packages/core/src/cli/subcommands.test.ts` | 新增 PROD-2 块：9 个子命令（`init/session/fork/export/transfer/acp/upgrade/doctor/vis`）`--help`/`-h` → exit 0 + 用法关键词断言；主 `--help` 对齐清单断言。 |
| `packages/core/src/cli/config.test.ts` | 新增 `bi config --help` → exit 0 + 关键词，及用法错误尾部 help 提示断言。 |
| `packages/core/src/cli/commands/copy.test.ts` | 新增 `bi copy --help` → exit 0 + 关键词，及非法字段用法错误尾部 help 提示断言。 |

> 注：工作树中另有与本题无关的预先未提交改动（`headless.ts`、`schema.ts` 等）与未跟踪的新文件（`w4d9-*.test.ts`），均非本工单所动，未触碰。

## 二、缺 key 报错构造点（文件:行号）

裸跑缺密钥报错的两处构造点（通过 `grep -rn "api_key_env" packages/core/src | grep -v test` 定位文案出处）：

1. `packages/core/src/config/config-service.ts:206` — `resolveProviderApiKey` 抛出 `ConfigError`：
   ```
   环境变量 ${envName} 未设置：provider "${providerName}" 通过 api_key_env 间接引用 API 密钥（配置文件中不落明文）。请在 shell 配置…设置 ${envName} 后重试；…\n运行 bi doctor 可体检定位配置问题
   ```
2. `packages/core/src/cli/model-port.ts:70` — `resolveApiKeyFromEnv` 抛出 `ModelPortConfigError`：
   ```
   环境变量 ${envName} 未设置：provider "${providerName}" 通过 api_key_env 间接引用 API 密钥。请导出 ${envName} 后重试；配置文件中永不落明文密钥。\n运行 bi doctor 可体检定位配置问题
   ```

附带挂 doctor 指引的「缺配置」路径（按任务要求「不要过度，只在缺配置/缺凭据类错误挂」）：
- `packages/core/src/config/config-service.ts:337` — TOML 解析失败 `ConfigError` 尾部追加同一指引（doctor 的「配置装载」检查项直接覆盖此失败形态）。

未挂指引的路径（避免过度）：`ConfigError` 的「未知 provider」「CLI 覆盖层校验失败」、writeback 类、`ModelPortConfigError` 的「无 provider/无驱动/模型缺 model」等，不属于「缺配置/缺凭据」语义，保持原样。

## 三、11 子命令 help 实测输出（每个截前 5 行）

> 运行方式：`bun bin/bi.ts <sub> --help`（全部 exit 0）。

```
===== bi init --help =====
bi init [--dir <目录>]

  脚手架当前工作区的 .bi/local.toml 模板与 BI.md 草稿。
  已存在则不覆盖（幂等成功）。

===== bi session --help =====
bi session [--limit <n>]

  列出会话元数据（JSON 行，最新在前），汇总条数走 stderr。

参数:

===== bi fork --help =====
bi fork <sessionId> <nodeId> [--title <标题>]

  从源会话的指定节点分叉出新会话。目标缺失 → 结构化 exit 1。

参数:

===== bi export --help =====
bi export <sessionId> [--format markdown|json|html] [--theme dark|light] [--out <path>]

  导出会话为 markdown / json / html；无 --out 时内容直出 stdout。

===== bi transfer --help =====
bi transfer export --sanitize <sessionId> [--out <path>]
bi transfer import <archive.json>

  脱敏归档导出 / 归档导入（零外呼，脱敏通道）。

===== bi acp --help =====
bi acp

  stdio 会话桥接面（JSON-RPC 帧）：v1 握手 + session/new +
  session/prompt + session/end。不吃任何命令行参数，只吃 stdio 帧。

===== bi upgrade --help =====
bi upgrade [--check] [--manifest-url <url>]

  自升级真链：manifest 源解析 → sha256 门 → 原子换装。
  无 manifest 源 → 结构化 exit 4（不假冒检查成功）。

===== bi doctor --help =====
bi doctor

  全链路体检：配置装载 / 凭据门 / 所配 provider 网络 / 沙箱探针 / 工具注册面。
  exit 按发现项（全部 ok → 0，存在异常 → 1）。

===== bi vis --help =====
bi vis [sessionId] [--port N] [--host H]

  本地 Web 会话可视化（Bun.serve）。缺省绑 127.0.0.1 + 随机端口。
  非回环绑定强制 BI_VIS_AUTH_TOKEN，缺失则拒绝启动（exit 1）。

===== bi config --help =====
bi config get <key> | bi config set <key> <value> | bi config list

  全局 ~/.bi/config.toml 键值面（低频清账）。键面由 schema 默认树推导。

子命令:

===== bi copy --help =====
bi copy [sessionId] [-f field]

  复制会话字段到剪贴板（或 stdout 降级）。缺省复制「最近会话」的 id。
  三平台剪贴板全缺失 → 降级 stdout（exit 0，不假冒）。

参数:
```

主 help 增强示例（`bi --help`，写入 stderr）：
```
bi — CLI Agent（行走骨架）

用法:
  bi --prompt "<text>" [--output-format stream-json]   无头会话（骨架真实路径）
  bi <subcommand> [args]                               子命令（见下）
  bi --version                                         版本
  bi --help                                            本帮助

子命令:
  init      脚手架工作区配置（.bi/local.toml）与 BI.md 草稿
  session   列出会话元数据（JSON 行，最新在前）
  fork      从指定节点分叉新会话
  export    导出会话为 markdown / json / html
  transfer  脱敏归档导出 / 归档导入
  acp       stdio 会话桥接（JSON-RPC 帧）
  upgrade   自升级：manifest → sha256 门 → 原子换装
  doctor    全链路配置 / 凭据 / 网络体检
  vis       本地 Web 会话可视化（Bun.serve）
  config    全局配置键值读写（get / set / list）
  copy      复制会话字段到剪贴板（或 stdout 降级）

运行 bi <subcommand> --help 查看各子命令完整用法。
```

## 四、门禁数字

| 门禁 | 结果 |
| --- | --- |
| `BI_PTY_E2E=1 bun test`（core 全量） | **2959 pass / 3 fail**（见下注） |
| `cd packages/core && bunx tsc --noEmit` | 0 错误 |
| `cd packages/tui && bunx tsc --noEmit` | 0 错误 |
| 11 × `bun bin/bi.ts <sub> --help` | 全部 exit 0 + 命中各自用法关键词 |

> **遗留 3 个失败为预存在（与本工单无关）**：`BI-26.3 链路 4:kill -9 真实子进程`、`BI-21 终局演练 链 4 财报勾稽:xlsx_audit.py`、`BI-21 终局演练 链 5 研报生成`。已验证：将本工单改动 `git stash` 后这三个测试同样失败（环境依赖 python3 / 真实子进程 / worktree，非本次改动引入，且不在本工单约束范围）。本工单自身新增/修改的测试全绿，未引入任何回归。

## 五、验收对照

- ✅ 11 子命令 `--help`/`-h` → 真实用法行 + 参数/选项说明 + 2~3 示例 + exit 0；帮助优先于用法校验（即便 `bi <sub> --help --bogus` 也直接给 help）。
- ✅ 各子命令用法错误保持结构化 + exit 2，尾部追加 `运行 bi <sub> --help 查看用法`（init/session/fork/export/acp/upgrade/doctor/vis 经 dispatch 统一；config/copy 在各自 handler 追加；transfer 的 usage 错误亦含既有 USAGE）。
- ✅ 主 help 单行名单 → 对齐「子命令 + 摘要」列表。
- ✅ 缺 key 报错（config-service.ts:206、model-port.ts:70）尾部追加 `运行 bi doctor 可体检定位配置问题`；配置解析失败（config-service.ts:337）同挂。
- ✅ 每个子命令 `--help` 契约测试已加（置各命令现有 .test.ts 旁）；主 help 增强加断言。
