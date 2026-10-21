/**
 * FIX-B F6 —— 鼠标语义开关真接线验收（config [tui] mouse_mode）。
 *
 * 覆盖两态：
 * - 启用态（缺省 true / 显式 true）：写 SGR 鼠标上报开启序列，离场写还原序列；
 * - 关闭态（显式 false）：两序列皆空——宿主既不启用也不还原（滚轮翻页随之关闭）。
 */
import { describe, expect, test } from "bun:test";

import {
	MOUSE_DISABLE,
	MOUSE_ENABLE,
	mouseModeEnabled,
	mouseModeSequences,
} from "./agent-tui";

describe("FIX-B F6 · config [tui] mouse_mode 两态", () => {
	test("启用态：缺省（未声明）/ 显式 true → 启用 SGR 鼠标上报", () => {
		expect(mouseModeEnabled(undefined)).toBe(true);
		expect(mouseModeEnabled(true)).toBe(true);
		const seq = mouseModeSequences(undefined);
		expect(seq.enable).toBe(MOUSE_ENABLE);
		expect(seq.disable).toBe(MOUSE_DISABLE);
		expect(mouseModeSequences(true)).toEqual({ enable: MOUSE_ENABLE, disable: MOUSE_DISABLE });
	});

	test("关闭态：显式 false → 不启用、不还原（无任何鼠标转义）", () => {
		expect(mouseModeEnabled(false)).toBe(false);
		const seq = mouseModeSequences(false);
		expect(seq.enable).toBe("");
		expect(seq.disable).toBe("");
	});
});
