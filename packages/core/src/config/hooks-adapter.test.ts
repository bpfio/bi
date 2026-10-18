/**
 * HOOK-EVENT-MAP 装载适配层测试（finding HOOK-EVENT-MAP 的验收面）：
 * 1. 规范 20 事件与 runner 事件集一一对应（完备性钉死）；
 * 2. 早期别名 pre_tool / post_tool 归一；prompt_submitted 在 schema 层整条丢弃；
 * 3. 字段映射 timeout_ms → timeoutMs、blocking / matcher 直传；
 * 4. 语义级丢弃：空 command、非法 matcher 正则（dropped 审计含原始下标）；
 * 5. enabled = false 整体停用；缺键容忍（缺省即 runner 缺省语义）。
 */
import { describe, expect, test } from "bun:test";
import { HOOK_EVENTS as RUNNER_HOOK_EVENTS } from "../hooks/types";
import { HOOK_EVENT_NAMES, hooksSchema, type ConfigIssue, type HooksSection } from "./schema";
import { loadHooksConfig } from "./hooks-adapter";

describe("hooks-adapter: 事件面完备性", () => {
  test("配置规范事件恰为 20 个，装载后与 runner 事件集一一对应", () => {
    expect(HOOK_EVENT_NAMES).toHaveLength(22); // 20 规范 + 2 兼容别名
    const entries = HOOK_EVENT_NAMES.map((event) => ({
      event,
      command: "true",
      timeout_ms: 1_000,
      matcher: "",
      blocking: true,
    }));
    // 全集含别名，别名与规范名映射到同一 runner 事件 → 去重后应恰为 runner 20 事件
    const { config, dropped } = loadHooksConfig({ enabled: true, entries });
    expect(dropped).toEqual([]);
    const mapped = new Set(config.hooks.map((hook) => hook.event));
    expect([...mapped].sort()).toEqual([...RUNNER_HOOK_EVENTS].sort());
    expect(mapped.size).toBe(20);
  });
});

describe("hooks-adapter: 名称与字段映射", () => {
  test("早期别名 pre_tool / post_tool 归一为 PreToolUse / PostToolUse", () => {
    const { config, dropped } = loadHooksConfig({
      enabled: true,
      entries: [
        { event: "pre_tool", command: "echo a", timeout_ms: 1_000, matcher: "", blocking: true },
        { event: "post_tool", command: "echo b", timeout_ms: 1_000, matcher: "", blocking: true },
      ],
    });
    expect(dropped).toEqual([]);
    expect(config.hooks.map((hook) => hook.event)).toEqual(["PreToolUse", "PostToolUse"]);
  });

  test("字段映射：timeout_ms → timeoutMs，blocking / matcher 直传", () => {
    const { config, dropped } = loadHooksConfig({
      enabled: true,
      entries: [
        {
          event: "pre_tool_use",
          command: "echo hi",
          timeout_ms: 2_500,
          matcher: "^Bash$",
          blocking: false,
        },
      ],
    });
    expect(dropped).toEqual([]);
    expect(config.hooks[0]).toEqual({
      event: "PreToolUse",
      command: "echo hi",
      timeoutMs: 2_500,
      matcher: "^Bash$",
      blocking: false,
    });
  });

  test("schema 层集成：prompt_submitted 与未知事件整条丢弃并记 issue，别名放行", () => {
    const issues: ConfigIssue[] = [];
    // validateLayer 返回 unknown：测试内以结构断言收窄（条目级元素必为已验证对象）
    const validated = hooksSchema.validateLayer(
      {
        enabled: true,
        entries: [
          { event: "prompt_submitted", command: "x" },
          { event: "no_such_event", command: "y" },
          { event: "pre_tool", command: "z" },
        ],
      },
      "hooks",
      issues,
    ) as { enabled: boolean; entries: Array<{ event: string }> } | undefined;
    expect(validated?.entries.map((entry) => entry.event)).toEqual(["pre_tool"]);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    // ConfigIssue 文案记录值类型（describeValue）：非法事件触发「期望枚举」诊断
    expect(issues.filter((issue) => issue.message.includes("期望枚举")).length).toBe(2);
  });
});

describe("hooks-adapter: 语义级丢弃与停用", () => {
  test("空 command 条目丢弃并留审计（下标为 entries 原始下标）", () => {
    const { config, dropped } = loadHooksConfig({
      enabled: true,
      entries: [
        { event: "session_start", command: "   ", timeout_ms: 1_000, matcher: "", blocking: true },
        { event: "session_start", command: "true", timeout_ms: 1_000, matcher: "", blocking: true },
      ],
    });
    expect(dropped).toEqual([{ index: 0, reason: "empty-command" }]);
    expect(config.hooks).toHaveLength(1);
  });

  test("非法 matcher 正则整条丢弃并留审计", () => {
    const { config, dropped } = loadHooksConfig({
      enabled: true,
      entries: [
        {
          event: "pre_tool_use",
          command: "echo x",
          timeout_ms: 1_000,
          matcher: "([unclosed",
          blocking: true,
        },
      ],
    });
    expect(dropped).toEqual([{ index: 0, reason: "invalid-matcher-regex: ([unclosed" }]);
    expect(config.hooks).toHaveLength(0);
  });

  test("enabled = false 整体停用（config.hooks = []，无丢弃审计）", () => {
    const { config, dropped } = loadHooksConfig({
      enabled: false,
      entries: [
        { event: "pre_tool_use", command: "echo x", timeout_ms: 1_000, matcher: "", blocking: true },
      ],
    });
    expect(config.hooks).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("缺键容忍：raw 未提供 timeout_ms / matcher / blocking 时按 runner 缺省语义放行", () => {
    const issues: ConfigIssue[] = [];
    const validated = hooksSchema.validateLayer(
      { enabled: true, entries: [{ event: "pre_tool_use", command: "echo x" }] },
      "hooks",
      issues,
    ) as HooksSection | undefined;
    expect(issues).toEqual([]);
    const { config, dropped } = loadHooksConfig(validated!);
    expect(dropped).toEqual([]);
    expect(config.hooks[0]).toEqual({ event: "PreToolUse", command: "echo x" });
  });
});
