# PROD-4 完工报告：发布面定型——0.2.0 重发布工程

日期：2026-10-20 ・ 工单：`docs/dispatch/2026-10-20-prod-ready/p4-brief.md`
边界：做到「发布就绪」为止——**未执行 `npm publish`、未 git commit/push、未读取 `~/.bi-npm-token`**（按硬约束）。
产出：版本三源对齐 + 一致性测试、build:bin 实测、npm-pack 三包、本地 tarball 冷安装冒烟。

---

## 一、版本链核实结论

### 1.1 `bi --version` 取值链（已 grep 核实）

```
bin/bi.ts --带参--> runBi(argv)
  └─ packages/core/src/cli/main.ts:82-84  (argv.includes("--version"))
       └─ const { VERSION } = await import("../index");  // 动态导入 @bi/core
            └─ packages/core/src/index.ts:5  export const VERSION = "0.2.0";
       out(`bi ${VERSION}`)   // 实测输出: bi 0.2.0
```

- **VERSION 常量唯一定义处**：`packages/core/src/index.ts:5` → `export const VERSION = "0.2.0";`
- 同文件 `index.ts:7-11` 的 `PACKAGE.version = VERSION`（代码内耦合，与常量同源，非读 package.json）。
- 编译二进制（`dist/bin/bi`）将 core 一并打包，`--version` 读的是常量，**与根/core package.json 版本是两条独立来源**——这正是 BI-25.5 教训「双源须同卡同升」的根因面。

### 1.2 三源对齐前后对照

| 来源 | 字段 | 对齐前 | 对齐后 |
| --- | --- | --- | --- |
| 根 `package.json` | `version` | `0.2.0` | `0.2.0`（未动，已正确） |
| `@bi/core` `packages/core/package.json` | `version` | `0.1.0` ❌ | `0.2.0` ✅ |
| `@bi/tui` `packages/tui/package.json` | `version` | `0.1.0` ❌ | `0.2.0` ✅ |
| `@bi/core` `VERSION` 常量 | `packages/core/src/index.ts:5` | `0.2.0` | `0.2.0`（未动，已正确） |

> 漂移事实：主线进到 0.2.0 后，仅根 package.json 与 VERSION 常量同步升了，`@bi/core`、`@bi/tui` 两个 workspace 包的 `version` 仍停在 0.1.0。npm-pack.ts 直接读根 `version`（0.2.0）打包，所以**装出去的包版本是 0.2.0，但仓库内两个子包声明是 0.1.0**——属于版本声明不一致（发布物版本正确，子包元数据滞后）。本单已把两个子包对齐到 0.2.0。

### 1.3 新增轻量一致性测试（防再漂移）

扩展 `scripts/version-sync.test.ts`（原 BI-26.6 仅校验「根 package.json === VERSION」），新增为**多源同卡同升**约束，覆盖任务要求的「根/core package.json 与 VERSION 常量三处相等」，并顺带把 tui 也纳入：

- 根 `package.json` version === `VERSION`
- `@bi/core` `package.json` version === `VERSION`
- `@bi/tui` `package.json` version === `VERSION`
- 三处 `package.json` 彼此相等

同时把 `packages/core/src/index.test.ts` 的硬编码 `"0.2.0"` 改为从本包 `package.json` 动态读取，避免常量字面量漂移误导。

> 任一处单独升版未同步其他处 → 全仓测试即红，发布不可通过（结构约束固化 BI-25.5 教训）。

---

## 二、build:bin 实测

环境：`bun v1.3.14`（路径 `$HOME/.bun/bin`，仓库 `packageManager` 一致）。

```
$ bun run build:bin
{
  "mode": "build",
  "target": "linux-x64",
  "outPath": "/home/yupeng/bi/dist/bin/bi",
  "bytes": 95770752,
  "sha256": "3e2355977ea51ad4a13d574da21a24fbc4b64190ca712ca4531198f6ede5b2e0",
  "durationMs": 11309,
  "crossCompiled": true,
  "warnings": [
    "cross-compile darwin-arm64 ok: /home/yupeng/bi/dist/bin/bi-darwin-arm64 (64634978 bytes, sha256 ea4037b28c0eac8d591a145706b803b9b0a39c3020936f51a89b7bf07522ebaf)"
  ]
}
```

- 主目标 linux-x64 构建成功（95,770,752 B）；darwin-arm64 交叉编译 best-effort 成功（64,634,978 B），未降级为 warning。
- **sha256 `--check` 校验通过**（读 `dist/bin/bi.sha256` 比对，哈希一致）：

```
$ bun scripts/build-bin.ts --check
{ "mode":"check", "target":"linux-x64", "outPath":"/home/yupeng/bi/dist/bin/bi",
  "bytes":95770752, "sha256":"3e2355977ea51ad4a13d574da21a24fbc4b64190ca712ca4531198f6ede5b2e0",
  "durationMs":1231, "crossCompiled":false, "warnings":[] }
```

- **产物裸跑 `--version`** → `bi 0.2.0`（exit 0）。
- **空 HOME 裸跑（凭据门 exit 3）**：`HOME=/tmp/bi-empty-home ./dist/bin/bi </dev/null` → exit 3，stderr `bi: 未配置对话模型：请在 ~/.bi/config.toml 设置 …`（REPL 装配路径锁语义，与 0.1.1 同款断言一致）。

---

## 三、npm-pack 0.2.0 拼装

脚本用法：`bun scripts/npm-pack.ts [--outdir <dir>]`（默认 `/tmp/bi-npm/pkgs`）。读根 `version` 拼装三包，平台包构建失败自动剔除并进 `warnings`。

```
$ bun scripts/npm-pack.ts --outdir /tmp/bi-npm/pkgs
{
  "ok": true,
  "outdir": "/tmp/bi-npm/pkgs",
  "version": "0.2.0",
  "scope": "@bpfio",
  "packages": [ "@bpfio/bi-linux-x64", "@bpfio/bi-darwin-arm64" ],
  "meta": "@bpfio/bi",
  "warnings": []
}
```

两平台包均构建成功（`warnings: []`，darwin-arm64 交叉编译通过）。随后在三个包目录下 `npm pack` 产出 tarball：

| tarball（绝对路径） | 包 | 版本 |
| --- | --- | --- |
| `/tmp/bi-npm/pkgs/bi/bpfio-bi-0.2.0.tgz` | `@bpfio/bi`（元包，bin shim） | 0.2.0 |
| `/tmp/bi-npm/pkgs/bi-linux-x64/bpfio-bi-linux-x64-0.2.0.tgz` | `@bpfio/bi-linux-x64`（平台包） | 0.2.0 |
| `/tmp/bi-npm/pkgs/bi-darwin-arm64/bpfio-bi-darwin-arm64-0.2.0.tgz` | `@bpfio/bi-darwin-arm64`（平台包） | 0.2.0 |

元包 `optionalDependencies` 自动写入两平台包 `@0.2.0`；`bin: { bi: "./bin/bi.js" }`，shim 按 `process.platform-arch` 选装平台二进制后 `spawnSync`。

---

## 四、冷安装冒烟（本地 tarball，不触 registry）

> 说明：0.2.0 尚未发版，registry 无对应平台包，故**离线**把元包 + linux-x64 平台包 tarball 一并装入全新 prefix——这是「发布后 `npm install @bpfio/bi` 经 optionalDependencies 自动选装平台包」的离线等价验证。发布后用户只需 `npm install -g @bpfio/bi`，npm 自动从 registry 拉平台包（见第六节）。

```
$ rm -rf /tmp/bi-cold && mkdir -p /tmp/bi-cold && cd /tmp/bi-cold
$ npm install --no-audit --no-fund --no-save \
    /tmp/bi-npm/pkgs/bi/bpfio-bi-0.2.0.tgz \
    /tmp/bi-npm/pkgs/bi-linux-x64/bpfio-bi-linux-x64-0.2.0.tgz
→ added 2 packages in 12s
$ ls node_modules/@bpfio/   # → bi  bi-linux-x64
$ ./node_modules/.bin/bi --version   # → bi 0.2.0  (exit 0)
$ ./node_modules/.bin/bi session     # → 真实列出会话（本机 ~/.bi/sessions 99 个，exit 0，结构化 JSONL 流 + 末尾汇总「共 99 个会话」）
```

- **added 2 packages**：元包 + 平台包（linux-x64 当前宿主平台）自动选装确认 ✅
- `.bin/bi --version` == `bi 0.2.0` ✅
- `.bin/bi session` 真实列出会话（空态分支同代码路径，结构化 JSONL 行 + 汇总）✅
- shim 经 `require.resolve("@bpfio/bi-linux-x64/bin/bi")` 命中平台二进制并 spawn，全链贯通 ✅

---

## 五、门禁数字

| 门 | 命令 | 结果 |
| --- | --- | --- |
| 新增版本一致性测试 | `bun test scripts/version-sync.test.ts packages/core/src/index.test.ts` | 6 pass / 0 fail |
| 全量测试（BI_PTY_E2E=1） | `BI_PTY_E2E=1 bun test` | **4653 pass / 2 fail**（2 fail = xlsx 链 4/5，缺 `openpyxl` 环境依赖，见下） |
| 全量测试 + 补齐环境依赖 | `PATH=/tmp/pyvenv/bin:$PATH BI_PTY_E2E=1`（venv 含 openpyxl 3.1.5） | **4655 pass / 0 fail**（含 pty 真机回归 + 伪端点 + xlsx 全链） |
| 根类型门 | `bun run typecheck`（`tsc --noEmit -p tsconfig.json`） | exit 0，0 错误 |
| core 类型门 | `cd packages/core && bunx tsc --noEmit` | exit 0，0 错误 |
| build:bin | `bun run build:bin` + `--check` | linux-x64 产物 + sha256 校验通过 |
| npm-pack | `bun scripts/npm-pack.ts` | 三包 0.2.0，`warnings: []` |
| tarball 落盘 | `npm pack` ×3 | 3 个 .tgz 落盘 |
| 冷安装冒烟 | 全新 prefix 装元包+平台包 | added 2 packages；`.bin/bi --version`=bi 0.2.0；`session` 真实列出 |

**关于 2 个 fail 的说明（与 P4 无关，环境依赖）**：链 4「财报勾稽」/链 5「研报生成」调用 `presets/plugins/spreadsheets/scripts/xlsx_audit.py` 与 `gen_drill_xlsx.py`，二者 `import openpyxl`，本机系统 Python（PEP 668 外部托管）未装该库 → 测试以「环境问题」退出。DEVLOG 多次归档为「xlsx/openpyxl 环境项」（CI 经 `ci.yml` 加 `pip install openpyxl` 闭环）。我创建隔离 venv（`/tmp/pyvenv`，含 openpyxl 3.1.5）并把其 `python3` 置前于 PATH 重跑 `e2e-drill.test.ts` → **6/6 全过**，证明确系纯环境缺件、非 P4 代码改动引入的回归。主控在 CI/装机 host 上 `pip install openpyxl` 即可使其常绿。

约束遵守：未 `npm publish`、未 `git commit/push`、未读取 `~/.bi-npm-token`（仅知其路径与 0600 权限）。

---

## 六、给主控的 publish 命令序列

> 以下由主控在验收后执行（持 `~/.bi-npm-token`，本单不接触）。token 经**临时 userconfig（0600，用后即焚）**注入，零落盘；发布顺序：**平台包先发，元包最后**（保证元包 `optionalDependencies` 已存在）。

```bash
# 0. 前置：仓库根执行，确保 bun 在 PATH（本机 bun 在 ~/.bun/bin）
export PATH="$HOME/.bun/bin:$PATH"
cd /home/yupeng/bi

# 1. 取 token（仓库外 0600，绝不进 git；本单未读取）
TOKEN=$(cat ~/.bi-npm-token)

# 2. 临时 userconfig（用后即焚，token 零落盘）
UMC=$(mktemp -u)
printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN" > "$UMC"
chmod 600 "$UMC"

# 3. 重拼装（若尚未拼装，根 package.json 已是 0.2.0）+ 打三包 tarball
bun scripts/npm-pack.ts --outdir /tmp/bi-npm/pkgs
( cd /tmp/bi-npm/pkgs/bi              && npm pack --userconfig "$UMC" )
( cd /tmp/bi-npm/pkgs/bi-linux-x64   && npm pack --userconfig "$UMC" )
( cd /tmp/bi-npm/pkgs/bi-darwin-arm64 && npm pack --userconfig "$UMC" )

# 4. 发布（顺序：平台包 → 元包；scoped 免费包需 --access public）
npm publish --userconfig "$UMC" /tmp/bi-npm/pkgs/bi-linux-x64/bpfio-bi-linux-x64-0.2.0.tgz   --access public
npm publish --userconfig "$UMC" /tmp/bi-npm/pkgs/bi-darwin-arm64/bpfio-bi-darwin-arm64-0.2.0.tgz --access public
npm publish --userconfig "$UMC" /tmp/bi-npm/pkgs/bi/bpfio-bi-0.2.0.tgz                       --access public

# 5. 装机验证（--prefer-online 破本机 packument 缓存）
npm install -g @bpfio/bi --prefer-online --userconfig "$UMC"
bi --version        # 期望: bi 0.2.0
bi session          # 期望: 结构化列出或空态

# 6. 清理临时凭据
rm -f "$UMC"
```

### registry 传播延迟轮询注意事项

- `npm publish` 回执 ≠ 立即可见：registry 副本/replication 通常有数秒到一分钟延迟；`npm view @bpfio/bi@0.2.0 version` 在发布后可能仍返回 0.1.1/404。
- **轮询确认已上线**再通知装机用户：
  ```bash
  for i in $(seq 1 30); do
    v=$(npm view @bpfio/bi@0.2.0 version 2>/dev/null)
    [ "$v" = "0.2.0" ] && { echo "published: $v"; break; }
    sleep 2
  done
  ```
- 装机侧**务必加 `--prefer-online`**（或先 `npm cache clean --force`），否则本机 stale packument 缓存会仍装到 0.1.1。
- 三包独立发布，平台包先发保证元包 `optionalDependencies` 可解析；若元包先发，装机在传播延迟窗口内可能 `added 1 package`（平台包暂未可达，optional 失败不阻塞，但 shim 运行期 `require.resolve` 会 exit 3）。
- 旧 scope `@bpfio-yp/*` 已在 0.1.0 阶段 deprecate 指引迁移，本次仍发 `@bpfio/*`，无需再动旧包。

---

## 七、本单改动清单（仅 P4 范围）

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `packages/core/package.json` | 版本 0.1.0 → 0.2.0 | 子包版本与根对齐 |
| `packages/tui/package.json` | 版本 0.1.0 → 0.2.0 | 子包版本与根对齐 |
| `scripts/version-sync.test.ts` | 重写扩展 | 多源同卡同升（根/core/tui package.json + VERSION 常量） |
| `packages/core/src/index.test.ts` | 改 VERSION 断言为动态读取 | 防常量字面量漂移误导 |

> 工作树中另有 P1/P2/P3 等并行 dispatch 的未提交改动（README/devlog/config/commands 等），**非本单范围，未触碰、未提交**；本单只动上述四个文件。
