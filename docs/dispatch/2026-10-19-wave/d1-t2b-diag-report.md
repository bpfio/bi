# D1 诊断报告 / BI-30.2b:伪端点 openai 模式 CI 失败(含主控验收与证伪)

- 派发:2026-10-19,codebuddy hy3,`--tools "Read,Grep,Glob,Bash"`,只读诊断,零修改(git 核验干净)
- 简报:`docs/dispatch/2026-10-19-wave/d1-t2b-diag-brief.txt`;原始输出:`/tmp/d1-t2b-diag.log`(6238B)
- 工时:约 7 分钟,全程免费模型

## D1 原始结论(摘要,全文见 /tmp/d1-t2b-diag.log)

D1 判定根因为"openai 用例在父 bun test 进程内用 globalThis.fetch 直连同进程伪端点,继承 CI 代理环境变量(HTTP_PROXY 等)致回环请求被误路由;anthropic 用例因 Bun.spawn 剥离 env 而规避"。附 10 项环境假设清单、排除项、修复 diff 草案(中和代理 env)、本地代理探针实测,置信度自评"高"。

## 主控验收:过程优秀,结论证伪

**过程质量:高**。交付格式完全遵约;代码证据到 file:line;主动做了本地代理探针实验(仅写 /tmp,合规);排除项论证扎实;诚实披露"未实测 CI"残余风险;工作树零改动。

**结论判定:证伪**。主控调取 CI run 39196682014 原始日志,真实失败签名为:

```
(pass) anthropic 模式 [409.84ms]
error: Cannot find package 'smol-toml' from '.../packages/core/src/config/config-service.ts'
(fail) openai 模式 [2.12ms]     ← import 解析期即挂,未达任何网络层
```

同 run 中 buildBin e2e 亦因 `smol-toml`/`picomatch` 无法解析挂——与代理路由假设(网络层、需秒级超时)不相容。D1 的代理假设对本失败不成立;其"环境假设清单"方法论与备选 spawn 方案仍具参考价值。

**失误归属**:D1 简报继承了 t2b 原简报的"禁止联网实测 CI"约束,使其无法接触直接证据——约束由主控设定,责任在主控策划,不在执行 agent。

## 真根因(主控实锤,证据链四环)

1. `.github/workflows/ci.yml` **无 `bun install` 步骤**,checkout 后直接 `bun test`,进入 bun auto-install 模式;
2. auto-install 对 **workspace 嵌套包内文件的 in-process import** 解析不到仅声明在子包 package.json 的依赖(`smol-toml`/`picomatch` 已正确声明于 packages/core 且 bun.lock 同步——依赖声明无罪);
3. 本地干净 worktree 复现(b4a96af,无 node_modules):anthropic 过(子进程完整 auto-install)/openai 挂(父进程内 import)/报错逐字一致;
4. 同 worktree 补 `bun install --frozen-lockfile` 后 2/2 全绿。

DeepSeekAdapter 线索(C2 遗留)为红鲱鱼:失败发生在适配器选择链之前的模块解析期。

## 处置

CI 增加安装步骤(最小修复):`bun install --frozen-lockfile`,于 `bun test` 前。已派 D3(codebuddy hy3 写模式)执行,主控终验后闭卡。CI 转绿由 workflow_dispatch 实跑确认。
