# 工单 PROD-4：发布面定型——0.2.0 重发布工程（版本对齐+pack+冷安装冒烟）

## 背景

bi（/home/yupeng/bi）的 npm 发布通道已存在且成熟：`@bpfio/bi` 元包（bin shim 按平台 spawn）
+ `@bpfio/bi-linux-x64` / `@bpfio/bi-darwin-arm64` 平台包（optionalDependencies 自动选装，
esbuild 同款模式），拼装器 `scripts/npm-pack.ts`，单文件二进制通道 `scripts/build-bin.ts`
（Bun Compile，linux-x64/darwin-arm64+sha256）。历史发布 0.1.0/0.1.1 两轮均冷安装冒烟通过。

**差距**：主线已推进到 0.2.0（大量 feat），但未重新发布——npm 装机用户停留在 0.1.1；
版本源漂移：根 package.json=0.2.0、`@bi/core` package.json=0.1.0、`@bi/tui` package.json=0.1.0
（`bi --version` 读 core 的 VERSION 常量，实测输出 0.2.0——先核实 VERSION 常量在哪、与谁同步）。

## 硬约束

1. **不许 `npm publish`**（外发动作由主控验收后执行）；你做到"发布就绪"为止。
2. 不许 git commit / git push。
3. npm token 在 `~/.bi-npm-token`（0600）——你不需要也不许读它。

## 任务清单

1. **版本三源对齐**：核实 `bi --version` 的取值链（grep VERSION 常量定义处）；
   把 `packages/core/package.json`、`packages/tui/package.json` 版本与根对齐 0.2.0；
   若存在"双源须同卡同升"的脆弱性（DEVLOG 记载过教训），加一个轻量一致性测试
   （根/core package.json 与 VERSION 常量三处相等），防再漂移。
2. **build:bin 实测**：`bun run build:bin` 构建 linux-x64 产物，`--check` 校验 sha256，
   产物裸跑 `--version` 输出 0.2.0、空 HOME 裸跑 exit 3 凭据门（REPL 装配路径锁语义，
   上轮 0.1.1 同款断言）。
3. **npm-pack 0.2.0 拼装**：跑 `scripts/npm-pack.ts`（读脚本用法），产出三包 tarball；
   平台包构建失败自动剔除并进 warnings 的行为保持。
4. **冷安装冒烟（本地 tarball，不触 registry）**：全新 prefix 目录
   `npm install <@bpfio/bi 元包 tarball 绝对路径>` → `.bin/bi --version` = `bi 0.2.0`
   → `.bin/bi session`（真实列出会话或结构化空态）→ 平台包自动选装确认（added 2 packages）。
5. **发布清单**：报告里给出主控执行 publish 的精确命令序列（含 --prefer-online 装机
   验证步骤），以及 registry 传播延迟的轮询注意事项。

## 验收门（自跑，全过才算完工）

- `BI_PTY_E2E=1 bun test` 全绿（含新增版本一致性测试）；双 tsc 0。
- build:bin 产物 + sha256 check 通过；三包 tarball 落盘；冷安装冒烟全链输出留存。

## 报告

写 `docs/dispatch/2026-10-20-prod-ready/p4-report.md`：版本链核实结论（VERSION 常量位置、
三源对齐前后对照）、build/pack/冷安装实测输出摘录、给主控的 publish 命令序列、门禁数字。
