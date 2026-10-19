完成。两条判据均通过：

- `bun test ./packages/core/src/cli/ ./packages/core/src/rules/` → **330 pass / 0 fail**
- `cd packages/core && bunx tsc --noEmit` → **EXIT 0（0 错）**

---

## 结论清单

### 改动文件清单
| 文件 | 性质 | 内容 |
|---|---|---|
| `packages/core/src/cli/commands/dispatch.ts` | 改 | `bi init` 追加 BI.md 草稿生成；新增 `bi config` 子命令（`SUBCOMMANDS`+`DISPATCH` 查表同步）；更新头注 |
| `packages/core/src/cli/commands/config.ts` | 新 | `bi config` 处理器：`get/set/list`，键面推导、强类型化、schema 校验、writeback 写回 |
| `packages/core/src/cli/init-bi-md.test.ts` | 新 | init BI.md 生成 4 用例 |
| `packages/core/src/cli/config.test.ts` | 新 | config 12 用例（含单元：键面/强类型/渲染） |

未触碰边界文件（`main.ts`/`headless.ts`/`agent.ts`/`toolset.ts`/`tools/`/`interaction/`/`rules/`）。`main.ts` 的 `USAGE` 因引用 `SUBCOMMANDS` 自动包含 `config`，无需改它（亦属勿动面）。**未 commit / 未 push。**

### init 增强语义
- `.bi/local.toml` 脚手架语义**完全不变**（已存在不覆盖、报告路径、退出码不变）。
- 追加：在 `cwd` 写 `BI.md` —— 调 `init-service.detectStack` + `draftBiMd`（projectName=basename(workDir)）。
  - **已存在不覆盖**，报告路径，退出码仍 0；
  - **不支持栈**（无任何已知清单）→ 仍生成如实标注「未检测到」的草稿，并向 `err` 结构化提示，**绝不假冒**检测结果；
  - **检测异常**（defensive try/catch）→ 结构化提示、跳过 BI.md、仅留脚手架，退出码不变。

### config 键值面与写回策略（诚实备案）
- **键值面**：由 `createDefaultConfig()` 默认配置树推导的全部**标量叶子**（`string/number/boolean` + `string[]`），单一事实来源、零硬编码漂移；对象（表/记录）排除，空数组按 `string[]` 纳入（实体表若被设值由 schema 校验拦截）。约 45 个合法键（如 `identity.name`、`workspace.additional_dir`、`telemetry.enabled`、`thinking.effort`、`tools.allow`、`read.max_file_size_kb`）。
- **get**：读合并后生效值（`ConfigService.load()`）；未知键 → 结构化报错 + 列出全部合法键（exit 2）。
- **set**：按目标叶子类型强类型化（`bool` 仅 `true|false`、`number` 有限数、`string[]` 逗号切分）；再经 `validateConfigLayer` 校验捕获**枚举越界/类型/整型**等非法值（exit 2、报 schema 原诊断）。
- **写回策略**：复用既有的 **writeback 引擎**（`planConfigWriteback`）做**注释保留的键级回写**，经 `smol-toml` 语法守卫，原子落盘（`~/.bi/config.toml`）。不硬性保证格式/顺序之外的呈现——保留注释与顺序是引擎附带收益，**非契约**。
- `homeDir` 经 `SubcommandDeps` 注入，与 dispatch 既有模式一致；测试全走临时目录，**绝不触碰真实 `~/.bi`**。

### 测试数 + tsc
- 新增 **16 用例**（init 4 + config 12）；全仓 `cli/`+`rules/` 共 **330 pass / 0 fail**。
- `tsc --noEmit`：**0 错误**。

### 未尽边界（备案）
1. `cli/sub/init.ts` 存在一个**未接线**的 BI-05.2 草稿入口（含 `--yes` 门控），与本卡的 dispatch 路线并存但互不影响；本次只增强 dispatch 路线，未改该未接线文件（属 `rules/` 只读面）。如需统一，建议后续合并到 dispatch 路线。
2. `config` 仅覆盖**标量叶子**键值面；`providers.entries`/`mcp.servers` 等记录表条目、权限规则/hooks 数组等结构化配置不在本低频命令范围（由 `/config` 面板或手写 TOML 管理）。
3. `set` 值以单 token 传入；含空格字符串需 shell 引号（如 `set identity.name "my assistant"`），多位置参数视为用法错误。
4. kimi 对照面**无 `config` 子命令**，本实现为独立设计（已核实该参考目录无 config 子命令）。
5. `docs/dispatch/2026-10-19-organ-wire/` 为未跟踪目录（非本次改动产物，未处理）。
