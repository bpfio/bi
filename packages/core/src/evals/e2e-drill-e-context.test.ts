/**
 * BI-21 工位 H 域级演练 E —— 上下文防御链。
 *
 * 链路:构造超限对话 → WindowManager 水位告警 → pruner 脱水老旧工具输出 →
 * AutoCompactor 紧缩(伪 summarizer,I/O 边界注入)→ tool-pairing 配对完整性 →
 * cache-continuity 前缀缓存保持与溢出判级 → interruption-recovery 截断提醒 →
 * date-change-sensor 跨日披露。断言:紧缩后水位回落、工具配对完整、预算约束成立。
 */

import { describe, expect, test } from "bun:test";

import { WindowManager, COMPACT_WATERMARK } from "../context/window-manager";
import { dehydrateOldToolResults } from "../context/pruner";
import { AutoCompactor } from "../context/compactor";
import { pairingBalance, isCutSafe } from "../context/tool-pairing";
import type { Msg } from "../context/tool-pairing";
import {
	effectiveWindow,
	compactRequest,
	handleOverflowError,
	DEFAULT_COMPACT_INSTRUCTION,
} from "../context/cache-continuity";
import { InterruptionInjector, INTERRUPTION_NOTICE_TEXT } from "../context/interruption-recovery";
import { DateChangeSensor } from "../context/date-change-sensor";

/** 构造带工具配对的多轮超限对话(8 个 user 轮,前 6 轮挂大体积工具输出)。 */
function buildOverlimitConversation(): Msg[] {
	const msgs: Msg[] = [{ role: "system", content: "你是数据审计助手" }];
	for (let i = 1; i <= 8; i++) {
		msgs.push({ role: "user", content: `第 ${i} 轮:核对指标` });
		msgs.push({ role: "assistant", content: "执行抓取", ...(i <= 6 ? { toolCallId: `call-${i}`, toolName: "web-fetch" } : {}) });
		if (i <= 6) {
			msgs.push({
				role: "tool",
				toolCallId: `call-${i}`,
				toolName: "web-fetch",
				content: `公报正文 ${i}:` + "953680 亿元 同比 4.8%。".repeat(400),
			});
		}
	}
	return msgs;
}

describe("BI-21 域 E —— 上下文防御链", () => {
	test("E1 超限对话:水位告警 → 脱水 → 紧缩,预算内且工具配对完整", async () => {
		const window = new WindowManager({ outputReserve: 1_000 });
		window.updateUsage(9_000, 10_000); // ratio = 0.9 ≥ 0.8
		expect(window.ratio()).toBeGreaterThanOrEqual(COMPACT_WATERMARK);
		expect(window.shouldCompact()).toBe(true);
		expect(window.snapshot().alertActive).toBe(true);
		expect(window.snapshot().effectiveWindow).toBe(9_000);

		const msgs = buildOverlimitConversation();
		// 原始序列配平:每个 tool_use 都有结果
		expect(pairingBalance(msgs).balanced).toBe(true);

		// 第一道:pruner 脱水老旧工具输出(保留最近 2 轮逐字)
		const dehydrated = dehydrateOldToolResults(msgs, { keepRecentTurns: 2 });
		expect(dehydrated.prunedCount).toBeGreaterThan(0);
		expect(dehydrated.savedBytes).toBeGreaterThan(0);
		// 脱水不破坏配对:toolCallId 骨架保留
		expect(pairingBalance(dehydrated.messages).balanced).toBe(true);
		// 脱水后体积确实变小
		const sizeOf = (ms: Msg[]) => ms.reduce((n, m) => n + JSON.stringify(m.content ?? "").length, 0);
		expect(sizeOf(dehydrated.messages)).toBeLessThan(sizeOf(msgs));

		// 第二道:AutoCompactor 紧缩(summarizer 为伪模型端口,I/O 边界注入)
		const summarizerSeen: Msg[][] = [];
		const compactor = new AutoCompactor({
			summarizer: async (older) => {
				summarizerSeen.push(older);
				return "摘要:前 6 轮完成公报抓取与核对,GDP 953680 亿元。";
			},
			window,
			keepRecentTurns: 2,
		});
		const result = await compactor.maybeCompact(dehydrated.messages);
		expect(result).not.toBeNull();
		const compacted = result!.messages;
		// 预算内:紧缩后字符量大幅回落
		expect(sizeOf(compacted)).toBeLessThan(sizeOf(dehydrated.messages));
		// 工具配对完整:紧缩序列依然配平(安全切点门禁生效)
		expect(pairingBalance(compacted).balanced).toBe(true);
		// 摘要占位注入 + 逐字保留最近轮
		expect(JSON.stringify(compacted)).toContain("摘要:前 6 轮");
		expect(JSON.stringify(compacted)).toContain("第 8 轮:核对指标");
		// system 头不进 summarizer(裁定 3)
		expect(summarizerSeen[0]!.some((m) => m.role === "system")).toBe(false);
		// 留痕:紧缩条目携带紧缩前 token 与触碰文件
		expect(result!.entry.tokensBefore).toBeGreaterThan(0);

		// 紧缩后水位回落 → 连击清零,告警解除
		window.recordCompaction();
		window.updateUsage(2_000, 10_000); // ratio 0.2 < 0.35 复位水位
		expect(window.snapshot().strikes).toBe(0);
		expect(window.snapshot().alertActive).toBe(false);
		expect(window.shouldCompact()).toBe(false);
	}, 30_000);

	test("E2 熔断器:连续紧缩仍超水位 → 结构化熔断", async () => {
		const window = new WindowManager({ outputReserve: 1_000 });
		window.updateUsage(9_500, 10_000);
		const compactor = new AutoCompactor({
			summarizer: async () => "无效摘要",
			window,
			keepRecentTurns: 2,
		});
		const msgs = buildOverlimitConversation();
		// 三次紧缩(成功紧缩由组件内部计数连击),水位始终不降(伪摘要无效)→ 第三次后熔断
		for (let i = 0; i < 3; i++) {
			const r = await compactor.maybeCompact(msgs);
			expect(r).not.toBeNull(); // 伪摘要不影响"执行了紧缩"的事实
		}
		expect(window.isTripped()).toBe(true);
		await expect(compactor.maybeCompact(msgs)).rejects.toThrow(/circuit open/);
		window.reset();
		expect(window.isTripped()).toBe(false);
	}, 30_000);

	test("E3 cache-continuity:紧缩请求保前缀 + 溢出 413 判级回紧缩", () => {
		// 有效视窗公式:显式 output 预算 → min(预算, 64k)
		expect(effectiveWindow(100_000, { maxOutputTokens: 8_000 })).toBe(92_000);
		expect(effectiveWindow(100_000, { maxOutputTokens: 200_000 })).toBe(36_000); // 64k cap
		expect(() => effectiveWindow(-1)).toThrow(RangeError);

		// 紧缩请求:原消息逐元素原样(KV 前缀缓存不破),尾部追加指令,tools 同引用
		const msgs = buildOverlimitConversation();
		const tools = [{ name: "web-fetch" }];
		const req = compactRequest(msgs, { tools });
		expect(req.preservedToolDefs).toBe(true);
		expect(req.tools).toBe(tools); // 同引用,零改写
		expect(req.messages.length).toBe(msgs.length + 1);
		for (let i = 0; i < msgs.length; i++) {
			expect(req.messages[i]).toBe(msgs[i]); // 前缀恒等
		}
		expect(req.messages.at(-1)).toEqual({ role: "user", content: DEFAULT_COMPACT_INSTRUCTION });

		// 溢出判级:413/400 → 回紧缩;429/5xx/未知 → 升级
		expect(handleOverflowError({ status: 413 })).toEqual({ willRetry: true, action: "compact" });
		expect(handleOverflowError({ statusCode: 400 })).toEqual({ willRetry: true, action: "compact" });
		expect(handleOverflowError(Object.assign(new Error("boom"), { code: "413" })).action).toBe("compact");
		expect(handleOverflowError({ status: 429 })).toEqual({ willRetry: false, action: "escalate" });
		expect(handleOverflowError({ status: 500 }).action).toBe("escalate");
		expect(handleOverflowError(new Error("no status")).action).toBe("escalate");
	}, 30_000);

	test("E4 interruption-recovery + date-change-sensor:截断提醒一次性消费与跨日披露", () => {
		// 截断轮(悬挂的 tool_use)→ 规范提醒待发,一次性取走
		const injector = new InterruptionInjector();
		expect(injector.offer({ role: "assistant" as const, toolUseIds: ["call-6"], content: "" })).toBe(true);
		expect(injector.hasPending).toBe(true);
		expect(injector.take()).toBe(INTERRUPTION_NOTICE_TEXT);
		expect(injector.take()).toBeNull();

		// 完整轮 → 清空待发(上一提醒已过期)
		injector.offer({ role: "assistant" as const, toolUseIds: ["call-7"], content: "" });
		expect(injector.hasPending).toBe(true);
		expect(injector.offer({ role: "assistant" as const, toolUseIds: [], content: "完整回复" })).toBe(false);
		expect(injector.take()).toBeNull();

		// 跨日披露:UTC 时区,同日登记 → 次日 marker → 同日重复 check 不再触发
		const sensor = new DateChangeSensor({ timezone: "UTC" });
		const day1 = Date.UTC(2026, 9, 16, 12, 0, 0);
		const day2 = Date.UTC(2026, 9, 17, 1, 0, 0);
		const first = sensor.check(day1);
		expect(first.marker).toBeNull();
		const cross = sensor.check(day2);
		expect(cross.marker).not.toBeNull();
		expect(cross.marker!.kind).toBe("date_change");
		expect(cross.marker!.previousDate).toBe("2026-10-16");
		expect(cross.marker!.currentDate).toBe("2026-10-17");
		expect(cross.marker!.note).toContain("日期由 2026-10-16 变为 2026-10-17");
		const sameDay = sensor.check(Date.UTC(2026, 9, 17, 20, 0, 0));
		expect(sameDay.marker).toBeNull();
	}, 30_000);
});
