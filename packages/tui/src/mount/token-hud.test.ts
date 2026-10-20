/**
 * BI-11 接线 —— TokenHud 状态跟踪验收：usage 读数 → 状态行 HUD 片段。
 *
 * 全离线：喂适配器 usage 读数（StreamUsage），断言确定性渲染（TokenHud 契约）。
 */
import { describe, expect, test } from "bun:test";

import { DEFAULT_CONTEXT_TOKENS, TokenHudTracker } from "./token-hud";

describe("BI-11 · TokenHud 状态跟踪", () => {
	test("无读数：HUD 片段为空串（状态行不挂段，绝不冒充 0/0）", () => {
		const tracker = new TokenHudTracker(128_000);
		expect(tracker.hasReading).toBe(false);
		expect(tracker.line).toBe("");
	});

	test("usage 读数：Tokens 段按 k 缩写 + floor 百分比渲染", () => {
		const tracker = new TokenHudTracker(128_000);
		tracker.update({ inputTokens: 42_000 });
		expect(tracker.hasReading).toBe(true);
		expect(tracker.line).toBe("Tokens: 42k/128k (32%)");
	});

	test("usage 读数带缓存命中：Cache 段按 round 百分比渲染", () => {
		const tracker = new TokenHudTracker(128_000);
		tracker.update({ inputTokens: 42_000, cachedInputTokens: 36_960 });
		expect(tracker.line).toBe("Tokens: 42k/128k (32%) | Cache: 88%");
	});

	test("无缓存读数：整段 Cache 缺席", () => {
		const tracker = new TokenHudTracker(128_000);
		tracker.update({ inputTokens: 42_000, outputTokens: 100 });
		expect(tracker.line).toBe("Tokens: 42k/128k (32%)");
	});

	test("缓存命中但输入为 0：Cache 段缺席（0/0 无意义）", () => {
		const tracker = new TokenHudTracker(128_000);
		tracker.update({ inputTokens: 0, cachedInputTokens: 0 });
		expect(tracker.line).toBe("Tokens: 0/128k (0%)");
	});

	test("无 inputTokens 的读数被忽略（保留上一次读数）", () => {
		const tracker = new TokenHudTracker(128_000);
		tracker.update({ inputTokens: 42_000 });
		tracker.update({ outputTokens: 128 });
		expect(tracker.line).toBe("Tokens: 42k/128k (32%)");
	});

	test("上下文窗口可配（宿主按模型 context_limit 注入）", () => {
		const tracker = new TokenHudTracker(200_000);
		tracker.update({ inputTokens: 50_000 });
		expect(tracker.line).toBe("Tokens: 50k/200k (25%)");
	});

	test("缺省上下文窗口 = 128000", () => {
		const tracker = new TokenHudTracker();
		expect(DEFAULT_CONTEXT_TOKENS).toBe(128_000);
		tracker.update({ inputTokens: 42_000 });
		expect(tracker.line).toBe("Tokens: 42k/128k (32%)");
	});

	test("确定性：同读数两次渲染逐字节一致", () => {
		const tracker = new TokenHudTracker(128_000);
		tracker.update({ inputTokens: 42_000, cachedInputTokens: 36_960 });
		expect(tracker.line).toBe(tracker.line);
	});
});
