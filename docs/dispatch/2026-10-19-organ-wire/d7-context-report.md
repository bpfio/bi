All deliverables complete. Change scope is clean: only `config/schema.ts`, `cli/headless.ts`, `cli/main.ts` modified (no boundary files touched, context organs read-only, no existing tests changed).

---

## 工单 ORGAN-WIRE W3-D7 结论清单

### 1. 家族分级表（逐文件读头注 + export 面，按证据）

**轻·可即接（纯函数 + 注入即用，不改循环骨架）**
| 器官 | export 形态 | 装配点 |
|---|---|---|
| `time-context` | `buildTimeContext(opts)→string` | system 面注入 |
| `date-change-sensor` | `DateChangeSensor.check(nowMs)→marker` | system 面跨日披露 |
| `tool-result-pruner` | `pruneToolResult(text,opts)→string` | executor（紧接 boundToolText） |
| `image-offload` | `offloadOldestImages(unknown[],opts)`（鸭子类型） | 消息数组变换（证据上亦属轻，未接） |

**重·需设计（改循环骨架 / 需伴侣器官 / 需 token 数 / 需 Msg[] 转换）**
`compactor`(需 summarizer 模型端口+window-manager)、`pruner`(需 Msg[] 转换)、`window-manager`(token 水位追踪器，需 token 数+compactor 才生效)、`spill-store`(需 executor 落盘副作用)、`tool-pairing`/`tool-history-normalizer`(需 Msg[] 转换)、`cache-continuity`(需 maxTokens+overflow 检测)、`media-compress`(需原始字节流，headless 无入口)、`interruption-recovery`(需 Ctrl+C 截断轮捕获)、`recovery-pointer`(需 compactor 落盘行号)。

### 2. 接入子集语义
- **`time-context`**：session 构建时把 `buildTimeContext` 块（当前 ISO 时间+时区+UTC 偏移）注入 system 消息；与 `--agent-file` 指令共存时追加其后。
- **`date-change-sensor`**：`DateChangeSensor` 实例跨轮持久；每轮开始 `check(ctxNow())`，跨 00:00 时把披露提示注入 system 面（每自然日至多一次）。
- **`tool-result-pruner`**：executor 内 boundToolText 之后，字符串结果 >8192 码点保头尾抹中段（纵深防御二级修剪）。
- **`window-manager`（重·最小一件）**：`max_history_entries>0` 时每轮保留最近 N 条历史（头部 system 恒留）；并真实喂入每轮估算 token 数作遥测。其完整 token 水位紧缩需伴侣 `AutoCompactor`（本批归档）。

### 3. 新 config 键面（`[context]` 挂载式分区，不进 17 根键，仿 `[verify]`/`[subagent]`）
```
[context]
time_context        = false   # 缺省 off
date_change_sensor = false   # 缺省 off
tool_result_prune  = false   # 缺省 off
max_history_entries = 0      # 0 = off
timezone           = "Asia/Shanghai"
```
挂载逻辑写入 `BI_CONFIG_SCHEMA`（validate 抽取 + backfill），并入 `BiConfig` 联盟；`DEFAULT_BI_CONFIG` 仍为 17 根键（既有钉死断言不红）。`main.ts` 经 `loadedConfig?.context` 映射下发到 `runHeadless({ context })`。

### 4. 测试数 + 双 tsc
- 新增 **25** 测试（3 文件）：schema 挂载/缺省/17键回归/单层校验/ConfigService e2e（12）+ headless on-off 逐器官+缺省等价（10）+ main 下发 e2e（3）。
- **双 tsc 0**：`packages/core` exit 0、`packages/tui` exit 0；根 `tsc --noEmit` 亦 0。
- 既有测试 **零改动**；全量 `bun test ./packages/core/src/ ./packages/tui/` = **3546 通过 / 2 失败**。2 个失败属 `evals/e2e-drill.test.ts`（BI-21 财报勾稽/研报生成，依赖 xlsx_audit.py+worktree），**已用 git stash 验证为预存失败，与本次改动无关**（干净树同样 2 失败）。
- 完成判据满足：`bun test` 全绿（除 2 预存）+ 双 tsc 0。

### 5. 重·不接 备案清单（一句话原因 + 建议卡）
- **compactor**：需 summarizer 模型端口 + window-manager 熔断，属"长会话三件套"协同；建议与 window-manager 同批作为紧缩子系统接入。
- **pruner / tool-pairing / tool-history-normalizer**：操作 `tool-pairing.Msg[]`，headless 消息为 `AgentMessage`，需双向转换层；建议作为"工具史面"一批接入（配 `normalizeHistory`+`sanitize`+`dehydrate`）。
- **spill-store**：需 executor 落盘副作用 + 句柄回收策略；建议与 tool-result-pruner 同批做"超大输出分级"（Spill 第三级）。
- **cache-continuity**：`compactRequest` 需 maxTokens 与 overflow 检测；属紧缩重试闭环，随 compactor 接入。
- **media-compress**：需原始字节流入口（headless 无媒体摄取），建议随图像/文件工具接入。
- **interruption-recovery / recovery-pointer**：需 Ctrl+C 截断轮捕获与 wire 行号登记，建议随会话持久化与紧缩落盘接入。

**上下文器官本体零缺陷报告**：16 源文件头注与 export 面一致，无可报告缺陷（只读消费，未改写任何器官体）。未 commit / 未 push。
D7X_EXIT=0
