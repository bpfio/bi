import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
	RepeatBreaker,
	ToolDedupe,
	canonicalHash,
	canonicalJson,
	compareCodePointOrder,
} from "./tool-dedupe";

describe("canonicalHash / canonicalJson", () => {
	test("键序扰动同哈希：顶层对象键插入顺序不影响结果", () => {
		expect(canonicalHash("t", { a: 1, b: 2 })).toBe(canonicalHash("t", { b: 2, a: 1 }));
	});

	test("嵌套键序扰动同哈希（递归排序）", () => {
		const x = { x: { p: 1, q: [1, { m: 1, n: 2 }] } };
		const y = { x: { q: [1, { n: 2, m: 1 }], p: 1 } };
		expect(canonicalHash("t", x)).toBe(canonicalHash("t", y));
	});

	test("数组保持序：[1,2] 与 [2,1] 异哈希", () => {
		expect(canonicalHash("t", [1, 2])).not.toBe(canonicalHash("t", [2, 1]));
	});

	test("类型敏感：数字 1 与字符串 \"1\"、true 与 \"true\" 异哈希", () => {
		expect(canonicalHash("t", 1)).not.toBe(canonicalHash("t", "1"));
		expect(canonicalHash("t", true)).not.toBe(canonicalHash("t", "true"));
	});

	test("toolName 参与哈希：同参异工具不互判重复", () => {
		expect(canonicalHash("read", { p: "a" })).not.toBe(canonicalHash("grep", { p: "a" }));
	});

	test("确定性：同输入两次调用恒等，且为 64 位 hex（SHA-256）", () => {
		const once = canonicalHash("bash", { cmd: "ls -la" });
		expect(canonicalHash("bash", { cmd: "ls -la" })).toBe(once);
		expect(once).toMatch(/^[0-9a-f]{64}$/);
		const expected = createHash("sha256").update(`bash\0${canonicalJson({ cmd: "ls -la" })}`).digest("hex");
		expect(once).toBe(expected);
	});

	test("码点序（非码元序）：U+FFFD 先于 BMP 外字符 😀", () => {
		// 码元序会把 😀（D83D DE00）排在 U+FFFD 之前；码点序 0xFFFD < 0x1F600。
		const json = canonicalJson({ "\u{1F600}": 2, "\uFFFD": 1 });
		expect(json).toBe(`{"\uFFFD":1,"\u{1F600}":2}`);
		expect(compareCodePointOrder("\uFFFD", "\u{1F600}")).toBe(-1);
		expect(compareCodePointOrder("\u{1F600}", "\uFFFD")).toBe(1);
		expect(compareCodePointOrder("ab", "ab")).toBe(0);
		// 前缀短者在前。
		expect(compareCodePointOrder("a", "ab")).toBe(-1);
	});

	test("undefined 语义：对象属性跳过（{a:undefined} ≡ {}），数组落 null", () => {
		expect(canonicalHash("t", { a: undefined })).toBe(canonicalHash("t", {}));
		expect(canonicalHash("t", [undefined])).toBe(canonicalHash("t", [null]));
	});

	test("非法参数（function/symbol）结构化抛错，绝不静默吞", () => {
		expect(() => canonicalJson({ fn: () => 1 })).toThrow(TypeError);
		expect(() => canonicalJson(Symbol("x"))).toThrow(TypeError);
	});

	test("bigint 兜底为十进制字符串编码", () => {
		expect(canonicalJson({ n: 10n })).toBe('{"n":"10"}');
	});
});

describe("ToolDedupe 滑动窗口排重", () => {
	test("缺省只读名单为空集：任何工具首调不判重复（从紧不误缓存）", () => {
		const dedupe = new ToolDedupe();
		expect(dedupe.check("read", { p: "a" })).toEqual({ duplicate: false });
	});

	test("只读工具窗口内同哈希 → duplicate + 回放 recordResult 的结果", () => {
		const dedupe = new ToolDedupe({ readOnlyTools: ["read"] });
		expect(dedupe.check("read", { p: "a" })).toEqual({ duplicate: false });
		dedupe.recordResult("read", { p: "a" }, "file-content");
		const verdict = dedupe.check("read", { p: "a" });
		expect(verdict.duplicate).toBe(true);
		expect(verdict.cachedResult).toBe("file-content");
	});

	test("未 recordResult 的只读重复仍 duplicate，cachedResult 为 undefined", () => {
		const dedupe = new ToolDedupe({ readOnlyTools: ["read"] });
		dedupe.check("read", { p: "a" });
		const verdict = dedupe.check("read", { p: "a" });
		expect(verdict.duplicate).toBe(true);
		expect(verdict.cachedResult).toBeUndefined();
	});

	test("写类工具同参永不缓存：重复写必须走 07.2 门禁", () => {
		const dedupe = new ToolDedupe({ readOnlyTools: ["read"] });
		dedupe.check("edit", { p: "a" });
		dedupe.recordResult("edit", { p: "a" }, "ok");
		expect(dedupe.check("edit", { p: "a" })).toEqual({ duplicate: false });
	});

	test("参数不同 → 异哈希不判重复", () => {
		const dedupe = new ToolDedupe({ readOnlyTools: ["read"] });
		dedupe.check("read", { p: "a" });
		expect(dedupe.check("read", { p: "b" })).toEqual({ duplicate: false });
	});

	test("滑动窗口挤出：windowSize=2 时最老条目失效后重新入窗", () => {
		const dedupe = new ToolDedupe({ windowSize: 2, readOnlyTools: ["read"] });
		dedupe.check("read", { p: "a" });
		dedupe.check("read", { p: "b" });
		// a 已被挤出？先验证 b 仍可命中。
		dedupe.check("read", { p: "b" });
		// a 重新 check 会因被挤出而重新入窗；再挤 b 一次后 a、b 均在窗内。
		expect(dedupe.size).toBeLessThanOrEqual(2);
		dedupe.check("read", { p: "c" });
		expect(dedupe.size).toBe(2);
	});

	test("写类调用同样占用窗口（按调用序记录所有工具）", () => {
		const dedupe = new ToolDedupe({ windowSize: 2, readOnlyTools: ["read"] });
		dedupe.check("read", { p: "a" });
		dedupe.check("edit", { p: "x" });
		dedupe.check("read", { p: "b" });
		// read(a) 已被挤出：再次 check 视为新调用。
		expect(dedupe.check("read", { p: "a" })).toEqual({ duplicate: false });
	});

	test("recordResult 回填最近一次同哈希未决条目", () => {
		const dedupe = new ToolDedupe({ readOnlyTools: ["read"] });
		dedupe.check("read", { p: "a" });
		dedupe.recordResult("read", { p: "a" }, "v1");
		dedupe.check("read", { p: "b" });
		dedupe.recordResult("read", { p: "b" }, "v2");
		expect(dedupe.check("read", { p: "a" })).toEqual({ duplicate: true, cachedResult: "v1" });
		expect(dedupe.check("read", { p: "b" })).toEqual({ duplicate: true, cachedResult: "v2" });
	});

	test("reset 清空窗口", () => {
		const dedupe = new ToolDedupe({ readOnlyTools: ["read"] });
		dedupe.check("read", { p: "a" });
		dedupe.reset();
		expect(dedupe.size).toBe(0);
		expect(dedupe.check("read", { p: "a" })).toEqual({ duplicate: false });
	});
});

describe("RepeatBreaker 三阶打断门", () => {
	test("连续 1-2 次同参调用：tier 0 allow", () => {
		const breaker = new RepeatBreaker();
		expect(breaker.observe("bash", { cmd: "ls" })).toMatchObject({ tier: 0, action: "allow", count: 1 });
		expect(breaker.observe("bash", { cmd: "ls" })).toMatchObject({ tier: 0, action: "allow", count: 2 });
	});

	test("第 3 次触发阶 1 remind，message 与工单逐字一致", () => {
		const breaker = new RepeatBreaker();
		breaker.observe("bash", { cmd: "ls" });
		breaker.observe("bash", { cmd: "ls" });
		const verdict = breaker.observe("bash", { cmd: "ls" });
		expect(verdict.tier).toBe(1);
		expect(verdict.action).toBe("remind");
		expect(verdict.message).toBe("单句陈述本次调用的预期新增信息");
	});

	test("第 4 次仍阶 1；第 5 次阶 2 challenge", () => {
		const breaker = new RepeatBreaker();
		for (let i = 0; i < 3; i++) breaker.observe("bash", { cmd: "ls" });
		expect(breaker.observe("bash", { cmd: "ls" }).tier).toBe(1); // 第 4 次
		const fifth = breaker.observe("bash", { cmd: "ls" });
		expect(fifth.count).toBe(5);
		expect(fifth.tier).toBe(2);
		expect(fifth.action).toBe("challenge");
		expect(fifth.message).toBe("证伪检查：若无法给出新增信息，依据现有证据终结或提出缺失决策问题");
	});

	test("第 6-7 次维持阶 2；第 8 次阶 3 block 硬阻断", () => {
		const breaker = new RepeatBreaker();
		for (let i = 0; i < 5; i++) breaker.observe("bash", { cmd: "ls" });
		expect(breaker.observe("bash", { cmd: "ls" }).tier).toBe(2); // 第 6 次
		expect(breaker.observe("bash", { cmd: "ls" }).tier).toBe(2); // 第 7 次
		const eighth = breaker.observe("bash", { cmd: "ls" });
		expect(eighth.count).toBe(8);
		expect(eighth.tier).toBe(3);
		expect(eighth.action).toBe("block");
		expect(eighth.message).toBe("硬阻断：后续工具调用全部拒绝，强制直出文本");
	});

	test("阶 3 后同参持续拒绝；异参重置计数回 allow", () => {
		const breaker = new RepeatBreaker();
		for (let i = 0; i < 9; i++) breaker.observe("bash", { cmd: "ls" });
		expect(breaker.observe("bash", { cmd: "ls" }).tier).toBe(3);
		const different = breaker.observe("bash", { cmd: "pwd" });
		expect(different.tier).toBe(0);
		expect(different.count).toBe(1);
	});

	test("per 工具独立计数，互不串扰", () => {
		const breaker = new RepeatBreaker();
		breaker.observe("bash", { cmd: "ls" });
		breaker.observe("bash", { cmd: "ls" });
		expect(breaker.observe("read", { p: "a" }).count).toBe(1);
		expect(breaker.observe("bash", { cmd: "ls" }).count).toBe(3);
	});

	test("reset(tool) 只清该工具；reset() 清全部", () => {
		const breaker = new RepeatBreaker();
		breaker.observe("bash", { cmd: "ls" });
		breaker.observe("read", { p: "a" });
		breaker.reset("bash");
		expect(breaker.observe("bash", { cmd: "ls" }).count).toBe(1);
		expect(breaker.observe("read", { p: "a" }).count).toBe(2);
		breaker.reset();
		expect(breaker.observe("read", { p: "a" }).count).toBe(1);
	});

	test("键序扰动同参：规范化哈希相同即一次重复", () => {
		const breaker = new RepeatBreaker();
		breaker.observe("read", { p: "a", limit: 1 });
		const second = breaker.observe("read", { limit: 1, p: "a" });
		expect(second.count).toBe(2);
	});

	test("阈值可注入覆盖（remind=2, challenge=3, block=4）", () => {
		const breaker = new RepeatBreaker({ remindThreshold: 2, challengeThreshold: 3, blockThreshold: 4 });
		expect(breaker.observe("bash", { cmd: "ls" }).tier).toBe(0);
		expect(breaker.observe("bash", { cmd: "ls" }).action).toBe("remind");
		expect(breaker.observe("bash", { cmd: "ls" }).action).toBe("challenge");
		expect(breaker.observe("bash", { cmd: "ls" }).action).toBe("block");
	});
});
