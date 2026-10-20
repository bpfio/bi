/**
 * BI-20.5 接线 —— 轮转令牌权威（tui 侧装配）验收。
 *
 * 全离线：时钟与随机源注入（零等待、确定性）；核心 vis 处理器用 core 侧真实
 * VisHandler（令牌权威端口）验证宽限双活口径。
 */
import { describe, expect, test } from "bun:test";

import { createVisTokenAuthority } from "./vis-token-authority";
import { VisHandler } from "../../../core/src/cli/commands/vis";
import type { SessionMeta } from "../../../core/src/session/types";

/** 假会话管理器（只读 API 只需 listSessions）。 */
const fakeManager = {
  listSessions: async (): Promise<SessionMeta[]> => [],
  getSessionMeta: async (): Promise<SessionMeta | undefined> => undefined,
  entries: async () => [],
} as never;

/** 可控时钟 + 固定令牌序列（确定性）。 */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

describe("BI-20.5 接线 · 轮转令牌权威", () => {
	test("缺省：128-bit 令牌（32 字符 hex）；当前令牌恒真、异令牌假", () => {
		const authority = createVisTokenAuthority();
		const token = authority.current();
		expect(token).toHaveLength(32);
		expect(/^[0-9a-f]{32}$/.test(token)).toBe(true);
		expect(authority.validate(token)).toBe(true);
		expect(authority.validate("nope")).toBe(false);
		expect(authority.validate(null)).toBe(false);
		expect(authority.validate("")).toBe(false);
	});

	test("轮转后宽限双活：旧令牌在宽限期内仍过，过期即假", () => {
		const clock = makeClock();
		const tokenA = "a".repeat(32);
		const tokenB = "b".repeat(32);
		const tokens = [tokenA, tokenB];
		let index = 0;
		const authority = createVisTokenAuthority({
			rotationMs: 1000,
			graceMs: 500,
			clock,
			randomToken: () => tokens[index++]!,
		});
		const first = authority.current();
		expect(first).toBe(tokenA);
		expect(authority.validate(first)).toBe(true);

		clock.advance(1000); // 越过轮转周期 → 惰性轮转
		const second = authority.current();
		expect(second).toBe(tokenB);
		expect(second).not.toBe(first);
		expect(authority.validate(first)).toBe(true); // 宽限期内旧令牌双活
		expect(authority.validate(second)).toBe(true);

		clock.advance(500); // 宽限期耗尽
		expect(authority.validate(first)).toBe(false);
		expect(authority.validate(second)).toBe(true);
	});

	test("graceMs=0：轮转后旧令牌立即失效", () => {
		const clock = makeClock();
		const tokenC = "c".repeat(32);
		const tokenD = "d".repeat(32);
		const tokens = [tokenC, tokenD];
		let index = 0;
		const authority = createVisTokenAuthority({
			rotationMs: 1000,
			graceMs: 0,
			clock,
			randomToken: () => tokens[index++]!,
		});
		const first = authority.current();
		clock.advance(1000);
		authority.current();
		expect(authority.validate(first)).toBe(false);
	});

	test("onRotate 回调：轮转发生时收到新令牌（宿主据此重印访问链接）", () => {
		const clock = makeClock();
		const tokenE = "e".repeat(32);
		const tokenF = "f".repeat(32);
		const tokens = [tokenE, tokenF];
		let index = 0;
		const rotated: string[] = [];
		const authority = createVisTokenAuthority({
			rotationMs: 1000,
			graceMs: 500,
			clock,
			randomToken: () => tokens[index++]!,
			onRotate: (token) => rotated.push(token),
		});
		expect(rotated).toEqual([]); // 构造与首次读取不触发回调
		authority.current();
		expect(rotated).toEqual([]);
		clock.advance(1000);
		authority.current();
		expect(rotated).toEqual([tokenF]);
	});

	test("注入 core vis 处理器：当前令牌 200、宽限内旧令牌 200、非法令牌 401", async () => {
		const clock = makeClock();
		const token1 = "1".repeat(32);
		const token2 = "2".repeat(32);
		const tokens = [token1, token2];
		let index = 0;
		const authority = createVisTokenAuthority({
			rotationMs: 1000,
			graceMs: 500,
			clock,
			randomToken: () => tokens[index++]!,
		});
		const handler = new VisHandler({
			manager: fakeManager,
			requireToken: true,
			token: "",
			tokens: authority,
		});
		const first = authority.current();
		expect((await handler.dispatch(new Request("http://127.0.0.1/api/sessions?t=" + first))).status).toBe(200);

		clock.advance(1000); // 轮转
		const second = authority.current();
		expect((await handler.dispatch(new Request("http://127.0.0.1/api/sessions?t=" + second))).status).toBe(200);
		expect((await handler.dispatch(new Request("http://127.0.0.1/api/sessions?t=" + first))).status).toBe(200); // 宽限双活

		clock.advance(500); // 宽限耗尽
		expect((await handler.dispatch(new Request("http://127.0.0.1/api/sessions?t=" + first))).status).toBe(401);
		expect((await handler.dispatch(new Request("http://127.0.0.1/api/sessions?t=wrong"))).status).toBe(401);
	});
});
