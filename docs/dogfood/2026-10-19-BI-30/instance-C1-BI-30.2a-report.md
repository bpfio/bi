BI-30.2a 完成。两簇测试文件已加能力探测门控,本机能力在→照常全绿,能力缺→结构化跳过(已分别在模拟能力缺失下证实)。

## 簇 a:bwrap 探针/真实执行(`packages/core/src/sandbox/os-sandbox.test.ts`,27 测试)

- **根因**:GitHub ubuntu-latest 未预装 bubblewrap → 产品探针结构化报 `binary-missing`,"bwrap 可用/functional-ok" 与降级真实执行 `kind=ran/backend=bwrap` 的断言无从成立。另发现本 dogfood shell `HOME=/tmp/bi-dogfood` 落在 workspace(tmpdir=/tmp)内,沙箱对"外写被拒"两测合法放行致失败(HOME 前提不成立,非产品缺陷)。
- **门控**:`HAS_BWRAP = Bun.which("bwrap") !== null`(与产品 `defaultDeps.bwrapBinary` 同源的 PATH 存在性口径);`test.skipIf(!HAS_BWRAP)` 门控 bwrap 探针测试、`describe.skipIf(!HAS_BWRAP)` 门控"真实 bwrap 执行"整簇;另加 `HOME_OUTSIDE_WS` 前提探测门控两个"外写被拒"测试。每处附一行跳过原因注释,风格对齐 `scripts/pty-repl.test.ts` 的 `describe.skipIf(...)` 先例。

## 簇 b:buildBin e2e(`scripts/build-bin.test.ts`,23 测试)

- **根因**:ci.yml 无 `bun install` 步骤 → `packages/core/node_modules`(smol-toml/picomatch)缺失;`bun test` 运行期依赖自动安装不覆盖 `bun build --compile` 的 bundler 解析,实测报 `Could not resolve: "picomatch"/"smol-toml". Maybe you need to "bun install"?` → 编译失败。
- **门控**:按 e2e 实际依赖诊断 —— ①宿主三元组 linux-x64(产物需本机执行冒烟);②`Bun.resolveSync` 从各自真实导入方(config-service.ts / permission-matcher.ts)解析 smol-toml、picomatch。`describe.skipIf(!HAS_BUILD_CHAIN)` 门控 e2e 簇,单元矩阵(parseArgs/sha256/manifest 等 22 测)不门控。

## 验证矩阵

| 场景 | 结果 |
|---|---|
| 本机能力在(正常 HOME) | 两文件 **50 pass / 0 fail / 0 skip**(覆盖不减) |
| dogfood shell(HOME 在 workspace 内) | 48 pass / 0 fail,2 skip(HOME 前提,附原因) |
| 模拟 bwrap 缺失(PATH 去 bwrap) | 3 skip(bwrap 探针测 + bwrap 执行簇 2 测),23 pass / 0 fail |
| 模拟构建链缺失(藏 node_modules) | e2e 簇 1 skip,22 pass / 0 fail;恢复后复验通过 |

**改动文件**(仅 2 个测试文件,+63/-5;8 个并行工单脏文件逐一核对未动):`packages/core/src/sandbox/os-sandbox.test.ts`、`scripts/build-bin.test.ts`。产品代码零改动;临时挪动的 `packages/core/node_modules` 已恢复原位。