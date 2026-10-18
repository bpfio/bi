/**
 * HOOK-EVENT-MAP 装载适配层：config.toml `[[hooks]]` 分区（BI-01.1 snake_case 面）
 * → hook-runner 的 HooksConfig（BI-06.4 PascalCase 20 事件契约）。
 *
 * 权属：hooks/types.ts 约定「装载与校验归 config 模块负责，runner 只消费 HooksConfig」，
 * 故本适配器归 config 域。职责三件：
 *   1. 事件名映射：规范 20 事件 snake_case ↔ PascalCase 机械互转，早期别名
 *      （pre_tool / post_tool）归一为规范事件；
 *   2. 字段映射：timeout_ms → timeoutMs，blocking / matcher 直传；
 *   3. 装载期语义校验：空 command、非法 matcher 正则整条丢弃并留审计（dropped），
 *      hooks.enabled = false 时整体停用（config.hooks = []）。
 *
 * schema 层（sListOf + sEntity）已先行丢弃结构非法条目（未知事件、类型不符）并记
 * ConfigIssue；本层只处理 schema 放行后的语义级丢弃，两层丢弃互不重叠。
 */
import {
  HOOK_EVENTS as RUNNER_HOOK_EVENTS,
  type HookDefinition,
  type HookEvent as RunnerHookEvent,
  type HooksConfig,
} from "../hooks/types";
import { HOOK_EVENT_ALIASES, type HookEntry, type HooksSection } from "./schema";

/** PascalCase → snake_case（runner 20 事件名均为纯 Pascal 词序，机械可逆）。 */
function pascalToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`).replace(/^_/, "");
}

/** 规范 snake_case（含兼容别名）→ runner 事件名。对配置面事件全集完全覆盖。 */
const SNAKE_TO_RUNNER: ReadonlyMap<string, RunnerHookEvent> = (() => {
  const map = new Map<string, RunnerHookEvent>(
    RUNNER_HOOK_EVENTS.map((name) => [pascalToSnake(name), name]),
  );
  for (const [alias, canonical] of Object.entries(HOOK_EVENT_ALIASES)) {
    const runnerEvent = map.get(canonical);
    if (runnerEvent !== undefined) {
      map.set(alias, runnerEvent);
    }
  }
  return map;
})();

/** 装载结果：生效配置 + 语义级丢弃审计（index 为 section.entries 原始下标）。 */
export interface HooksLoadResult {
  config: HooksConfig;
  dropped: Array<{ index: number; reason: string }>;
}

/**
 * 将已过 schema 校验的 hooks 分区装载为 runner 配置（纯函数，无 IO）。
 * sObj 缺省键不回填：schema 放行的条目在运行期可能缺 timeout_ms / matcher /
 * blocking（raw 未提供时键不出现），本函数按「缺省即 runner 缺省语义」容忍——
 * timeoutMs 缺省由 runner 回退 DEFAULT_HOOK_TIMEOUT_MS，blocking 缺省视为 true，
 * matcher 缺省视为匹配全部。
 */
export function loadHooksConfig(section: HooksSection): HooksLoadResult {
  if (!section.enabled) {
    return { config: { hooks: [] }, dropped: [] };
  }
  const hooks: HookDefinition[] = [];
  const dropped: Array<{ index: number; reason: string }> = [];
  section.entries.forEach((entry: HookEntry, index: number) => {
    const command = entry.command ?? "";
    const matcher = entry.matcher ?? "";
    if (command.trim() === "") {
      dropped.push({ index, reason: "empty-command" });
      return;
    }
    const event = SNAKE_TO_RUNNER.get(entry.event);
    if (event === undefined) {
      // 配置面事件全集已入表，类型上不可达；程序化直构越界时的防御丢弃。
      dropped.push({ index, reason: `unknown-event: ${String(entry.event)}` });
      return;
    }
    if (matcher !== "") {
      try {
        new RegExp(matcher);
      } catch {
        dropped.push({ index, reason: `invalid-matcher-regex: ${matcher}` });
        return;
      }
    }
    const hook: HookDefinition = {
      event,
      command,
      timeoutMs: entry.timeout_ms,
      blocking: entry.blocking,
    };
    if (matcher !== "") {
      hook.matcher = matcher;
    }
    hooks.push(hook);
  });
  return { config: { hooks }, dropped };
}
