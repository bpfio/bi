# 工单 D：bi headless 上下文管线接线（BI-08.2 image-offload + BI-10 AutoCompactor）

仓库 /home/yupeng/bi。背景：两管线器官交付时未接运行时（虚账清偿波次 1）。config 键已由前一单加齐（context.image_offload / context.auto_compactor，均缺省 false），你只做接线，**不改 schema.ts**。

## 任务

### 1. BI-08.2 image-offload 接 headless 管线
- 器官：`packages/core/src/context/image-offload.ts`（offloadOldestImages：识别最早未卸载 image 块→就地替换占位符，结构不变式钉死。先通读器官+其测试）。
- 接线点：`packages/core/src/cli/headless.ts` 的会话回合管线（先通读 headless.ts 找上下文管理段——tool_result_prune/boundToolText 等既有管线挂点，image-offload 应挂在与修剪同层的"回合前/发送前"处理位）。
- 门控：`config.context?.image_offload === true` 才挂（loadedConfig 传参进 runHeadless 的方式先读现状——headless options 或装配点闭包，选与现有配置消费一致的模式）。
- 接线语义：每回合构造请求消息前，若开启则对历史消息跑一次 offloadOldestImages（超限策略以器官自带参数为准），行为零开启=零变动。

### 2. BI-10 AutoCompactor 接 headless
- 器官：`packages/core/src/context/compactor.ts`（AutoCompactor：80% 高水位静默紧缩，summarizer 端口注入）+ `context/window-manager.ts`（COMPACT_WATERMARK）。先通读两者+ `headless.ts:508` 附近"本批归档不接"的备案注释。
- 接线点：同管线。门控 `config.context?.auto_compactor === true`。
- **summarizer 端口**：需要"用当前模型总结历史"的实现——用 runHeadless 已装配的 model 端口包装成器官要求的 summarizer 接口（读 compactor.ts 的端口类型，最小包装：截断历史→单轮总结 prompt→返回摘要文本；失败不炸会话，走器官自带熔断）。
- 关闭（缺省）=现状条目数门禁裁剪，路径完全不进。

### 3. 测试
- headless 层测试（现有 headless.test.ts 模式，注入替身）：两开关关闭=零行为回归；开启=image-offload 对含 image 块历史生效一次、AutoCompactor 在模拟超水位时触发紧缩（summarizer 用替身返回固定摘要）。零真实模型调用。

## 红线
- 不许 commit/push/stash；**不改 schema.ts、toolset.ts、packages/tui/**、packages/a2a/**、packages/mcp/**（并行单施工面）
- 器官文件（context/image-offload.ts、context/compactor.ts、context/window-manager.ts）只读不改
- 缺省（两键 false）行为必须与现状逐字节等价（既有 4681 测试全绿是硬门槛）

## 完成自检并报告
- `cd /home/yupeng/bi/packages/core && bun test src/cli/headless.test.ts src/context/` 全绿
- 全仓 `BI_PTY_E2E=1 bun test` 全绿 + core 包 `bunx tsc --noEmit` 零错
- 报告：接线点位置（文件:行）、门控语义、summarizer 包装设计、新增测试数、门禁统计
