# 工单 H：bi 模型插槽路由器（BI-04 缺件补齐，新模块+装配）

仓库 /home/yupeng/bi。虚账清偿波次 2，**本单是缺件新开发**（BI-04 的插槽路由器在 git 全历史中从未存在）。`secondary_model` schema 已有三键（subagent/background/summarize，模型条目引用形式见 schema.ts 的 SecondaryModelSection），长期无消费方——本单交付消费面。

## 任务

### 1. 新模块 packages/core/src/cli/model-router.ts
- 职责（钉死，最小可用版）：`ModelRouter` 持有主端口+可选插槽端口映射（fast/reasoner/auditor 语义暂不引入——以 secondary_model 现有三键为准：subagent/background/summarize），暴露 `route(slot)`：slot 有配置且装配成功→返回插槽端口；否则回退主端口（**永不因插槽缺失失败**，回退是默认语义）。
- 装配函数 `assembleModelRouter(config, resolvePort)`：resolvePort(providerName, modelName) 由调用方注入（复用 resolveModelPort 的装配逻辑）；config.secondary_model 三键逐个尝试装配，失败（provider/model 缺失或凭据门失败）→ 该插槽置空并结构化日志（stderr 一行，不阻断）。
- thinking/extra_headers 等端口参数与主端口装配同构（resolveModelPort 已处理，route 只做选择）。

### 2. 消费接线（最小面）
- `packages/core/src/cli/main.ts` 装配点：主端口装配后调 assembleModelRouter；subagentRunner 创建处（config.subagent.enabled 分支）把 model 参数从主端口换成 router.route("subagent")。
- background/summarize 插槽：当前无稳定消费点（cron/上下文紧缩的 summarizer 由并行单以主端口实现）——**本单不强行接**，route() 面留好即可，注释备案"background/summarize 消费点随 BI-10 紧缩接线跟进"。

### 3. 测试 packages/core/src/cli/model-router.test.ts（新文件）
- route：有插槽返回插槽、无配置回退主端口、插槽装配失败回退且不抛；
- assemble：三键全空=三插槽全空；部分配置=对应插槽就位；
- 零真实网络（resolvePort 注入替身）。

## 红线
- 不许 commit/push/stash；**不改 schema.ts、toolset.ts、headless.ts、packages/tui/**、packages/mcp/**、packages/a2a/**（并行单施工面）**；main.ts 允许改（只许动 subagent runner 装配那几行，其他并行单改动保留不回退）
- 注释/缩进跟随 cli 目录 tab 风格

## 报告格式从简先落盘：/tmp/brief-h-report.md
## 自检
- `cd packages/core && bun test src/cli/model-router.test.ts` 全绿；全仓 `BI_PTY_E2E=1 bun test` 全绿 + core 包 tsc 零错；报告模块面/回退语义/测试数/门禁统计
