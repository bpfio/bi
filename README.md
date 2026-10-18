# bi

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**bi** 是一个用 Bun + TypeScript 构建的终端 CLI Agent（monorepo）。它不是任何现有 Agent
CLI 的 fork：产品代码全部在本仓库逐卡新写，设计上以「五标杆技术大典 + 双基线」方法吸收
既有经验——功能与架构基线取 zcode，CLI/TUI 壳层与装配序基线取 kimi code CLI，其余标杆
仅作工程参考（见 [`devplan.md`](./devplan.md) 与
[`docs/FIVE_AGENTS_FULL_SPECTRUM_ANALYSIS.md`](./docs/FIVE_AGENTS_FULL_SPECTRUM_ANALYSIS.md)）。

> 身份说明：本仓库 git 历史承自早期的 zcode-cli fork，现产品树（bi）为独立重写，
> 不回跟任何参考树上游（RULE-BI-08）。GitHub 侧的 fork 关联标记由仓库所有者另行脱离。

## 当前状态

- 开发计划（`devplan.md`，117 卡 SSOT）全部闭环后进入装配期；行走骨架已点火（BI-23.1）：
  bin 入口 → headless 主分发 → JSONL 会话 → hooks 真实子进程 → 权限门 → AgentLoop →
  真实文件工具 → stream-json 输出，端到端 e2e 全绿。
- 装配进行中：TUI 挂载（BI-23.2）、真实模型端到端点火（BI-23.3）；
  `init/session/fork/export/transfer/acp/upgrade/doctor` 子命令尚未接线
  （调用返回结构化「装配未接线」exit 4）。
- 质量门：`bun test` 全绿（211 个测试文件），双 tsconfig `tsc --noEmit` 0 错误。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `packages/core` | 会话（JSONL）、AgentLoop 状态机、权限门、hooks、config、headless 驱动 |
| `packages/tui` | 终端界面（装配挂载中） |
| `packages/{mcp,a2a,plugins,workflow,worktree}` | BI-01 骨架包，按卡填充 |
| `bin/bi.ts` | 可执行入口 shim |
| `scripts/build-bin.ts` | Bun Compile 单文件二进制构建（`--embed` 资产嵌入预留） |
| `devplan.md` | 开发计划唯一事实源（SSOT） |
| `DEVLOG.md` | 排障手记与验收台账导出 |

## 开发

```bash
bun install
bun test            # 全部测试
bun run typecheck   # 双 tsconfig 类型门
bun run build:bin   # 单文件二进制构建
```

## 文档

- [`devplan.md`](./devplan.md) — 117 卡开发计划（SSOT）
- [`DEVLOG.md`](./DEVLOG.md) — 排障手记与验收记录
- [`docs/RESEARCH.md`](./docs/RESEARCH.md) — 架构全景调研与设计蓝图
- [`docs/FIVE_AGENTS_FULL_SPECTRUM_ANALYSIS.md`](./docs/FIVE_AGENTS_FULL_SPECTRUM_ANALYSIS.md) — 五标杆技术大典
- [`docs/E2E_DRILL_REPORT.md`](./docs/E2E_DRILL_REPORT.md) — 终局验收矩阵演练报告
- [`docs/UPSTREAM_ANCHORS.md`](./docs/UPSTREAM_ANCHORS.md) — 上游锚点基线（不回跟追踪）

## License

bi 原生代码以 MIT 发布（见 [LICENSE](./LICENSE)）。
[`LICENSES/`](./LICENSES/README.md) 保留继承自上游 ZCode 的 Apache-2.0 授权文本与
第三方声明，作为仓库历史继承内容的归属记录。
