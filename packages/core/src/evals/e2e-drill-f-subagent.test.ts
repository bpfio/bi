/**
 * BI-21 工位 H 域级演练 F —— 子代理编排全链。
 *
 * 链路:SubagentRunner(loopFactory 伪模型循环为 I/O 边界)+ 真实 SessionManager
 * 会话写端口 → explore/coder 双代理协同(steer 双向信令 + 协调器工具 + 镜像)
 * → fork 克隆(字节级 systemPrompt + 历史切片 + 危害工具剥离 + toolLock)
 * → SwarmService 扇出并发与预算。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../session/manager";
import type { SessionEntry } from "../session/types";
import { Inbox } from "../session/inbox";
import type { JsonValue } from "../session/types";
import type { LoopFactory, SubLoopSessionCtx, SubagentOutboxMessage } from "../subagent/runner";
import { SubagentRunner } from "../subagent/runner";
import { MirrorSink } from "../subagent/mirror-sink";
import { RespondToCoordinatorTool, SendMessageTool } from "../subagent/coordinator";
import { SwarmService, SwarmError } from "../subagent/swarm/swarm-service";
import { pairingBalance } from "../context/tool-pairing";
import type { Msg } from "../context/tool-pairing";
import type { SubagentProfile } from "../subagent/profiles";

const roots: string[] = [];
afterAll(async () => {
	while (roots.length > 0) {
		const dir = roots.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

async function injectRoot(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `bi21-f-${prefix}-`));
	roots.push(dir);
	return dir;
}

/** 会话写端口:duck-type 适配真实 SessionManager(parentId 链自管,子会话惰性创建)。 */
function makeWriter(mgr: SessionManager) {
	const tips = new Map<string, string | null>();
	return {
		async append(
			sessionId: string,
			draft: { type: SessionEntry["type"]; payload: JsonValue; toolCallId?: string; toolName?: string },
		): Promise<SessionEntry> {
			let parentId = tips.get(sessionId);
			if (parentId === undefined) {
				try {
					parentId = (await mgr.entries(sessionId)).at(-1)?.id ?? null;
				} catch {
					// 子会话文件尚未存在:runner 域的会话由写端口惰性创建
					await mgr.createSession({ sessionId, title: `子会话 ${sessionId}` });
					parentId = null;
				}
			}
			const entry = await mgr.append(sessionId, parentId, draft);
			tips.set(sessionId, entry.id);
			return entry;
		},
	};
}

describe("BI-21 域 F —— 子代理编排", () => {
	test("F1 双代理协同:派生落盘配对 + steer 双向信令 + 协调器 + 镜像", async () => {
		const mgr = new SessionManager({ rootDir: await injectRoot("sessions") });
		const main = await mgr.createSession({ title: "主会话" });
		await mgr.append(main.sessionId, null, { type: "user", payload: { text: "演练任务:审计公报指标" } });
		const writer = makeWriter(mgr);

		const sink = new MirrorSink({ capacity: 64 });
		const mirrored: string[] = [];
		const unsubscribe = sink.subscribe((ev) => mirrored.push(`${ev.childSessionId}:${ev.type}:${ev.toolName ?? ""}`));

		// explore 循环在第一步后挂起,等父级 steer 到达再消费(确定性时序)
		let releaseExplore: (() => void) | null = null;
		const exploreGate = new Promise<void>((resolve) => {
			releaseExplore = resolve;
		});
		let steerSeen: string[] = [];
		const reports: Array<{ ok: boolean; from?: string; to?: string }> = [];
		let coderConsumedReport = "";

		const loopFactory: LoopFactory = (profile: SubagentProfile, ctx: SubLoopSessionCtx) => ({
			run: async () => {
				if (profile.type === "explore") {
					await ctx.emit({ type: "tool_call", payload: { argv: ["Grep", "953680"] }, toolCallId: "c-e1", toolName: "Grep" });
					await exploreGate; // 步界挂起,等父级 steer
					steerSeen = ctx.takeSteers().map((s) => s.text);
					await ctx.emit({ type: "tool_result", payload: { text: "找到 3 处指标" }, toolCallId: "c-e1", toolName: "Grep" });
					const respond = new RespondToCoordinatorTool({ runner });
					const report = await respond.run(
						{ message: "探查完成:公报 3 份", phase: "research" },
						{ childSessionId: ctx.childSessionId },
					);
					reports.push({ ok: report.ok, ...(report.ok ? { delivered: report.delivered, from: report.from, to: report.to } : {}) });
					return { ok: true, summary: "探查完成:公报 3 份", toolCalls: 2 };
				}
				// coder:消费父 outbox 里 explore 的阶段汇报再落笔
				const outboxMsgs = runner.outbox?.takeSteers() ?? [];
				coderConsumedReport = outboxMsgs.map((r) => ("text" in r ? r.text : "")).join("|");
				await ctx.emit({ type: "tool_call", payload: { argv: ["Write", "ledger.md"] }, toolCallId: "c-c1", toolName: "Write" });
				await ctx.emit({ type: "tool_result", payload: { text: "已写 ledger.md" }, toolCallId: "c-c1", toolName: "Write" });
				return { ok: true, summary: "已写 ledger.md", toolCalls: 2 };
			},
		});

		const runner = new SubagentRunner({
			loopFactory,
			sessionWriter: writer,
			mirror: sink,
			outbox: new Inbox<SubagentOutboxMessage>(),
			getHistorySlice: async (sessionId) => ({ entries: await mgr.entries(sessionId) }),
		});
		const sendTool = new SendMessageTool({ runner });

		// —— explore 派生(运行中)——
		const explorePromise = runner.spawn("explore", "扫盘找公报文件", { parentSessionId: main.sessionId });
		await new Promise((r) => setTimeout(r, 20));
		const run = runner.runInfos().find((r) => r.profileType === "explore");
		expect(run).toBeDefined();
		expect(run!.steerInbox).toBeDefined();

		// 父→子 steer:SendMessage 投递(caller 绑定父会话),子循环步界消费
		const steer = await sendTool.run(
			{ childSessionId: run!.childSessionId, message: "优先看双栏版面" },
			{ parentSessionId: main.sessionId },
		);
		expect(steer.ok).toBe(true);
		releaseExplore!();

		const explore = await explorePromise;
		expect(explore.ok).toBe(true);
		expect(explore.childSessionId.startsWith("sub-")).toBe(true);
		expect(explore.parentSessionId).toBe(main.sessionId);
		expect(explore.toolCalls).toBe(1); // toolCalls 计 tool_call 事件数
		// explore 只读档案不含危害工具:零剥离
		expect(explore.strippedTools).toEqual([]);
		expect(steerSeen).toEqual(["优先看双栏版面"]);

		// 子会话真实落盘:tool_call/tool_result 配对完整
		const childEntries = await mgr.entries(explore.childSessionId);
		expect(childEntries.length).toBeGreaterThanOrEqual(2);
		const pairingMsgs: Msg[] = childEntries.map((e) => ({
			role: e.type === "tool_result" ? "tool" : e.type === "tool_call" ? "assistant" : e.type === "user" ? "user" : "system",
			toolCallId: e.toolCallId,
			toolName: e.toolName,
			content: e.payload,
		}));
		expect(pairingBalance(pairingMsgs).balanced).toBe(true);

		// 子→父汇报:经 outbox steer 通道可寻址收割
		const report = reports[0]!;
		expect(report).toMatchObject({ ok: true, delivered: true });
		if (report.ok) {
			expect(report.from).toBe(explore.childSessionId);
			expect(report.to).toBe(main.sessionId);
		}

		// coder 接棒:消费 outbox 中 explore 的汇报
		const coder = await runner.spawn("coder", "把探查结论写入台账", { parentSessionId: main.sessionId });
		expect(coder.ok).toBe(true);
		expect(coder.profileType).toBe("coder");
		expect(coder.strippedTools).toEqual([]);
		expect(coder.toolCalls).toBe(1);
		expect(coderConsumedReport).toContain("探查完成:公报 3 份");

		// 镜像:只有工具事件,只镜不落库(镜像流 ≠ 会话文件),seq 单调
		expect(mirrored.length).toBe(4);
		expect(mirrored.every((m) => m.includes("tool_"))).toBe(true);
		const snap = sink.snapshot();
		const seqs = snap.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

		// 主会话:两个子代理的结果汇总落回主会话(payload 带 source:"subagent")
		const mainAfter = await mgr.entries(main.sessionId);
		const summaries = mainAfter.filter((e) => e.type === "assistant" && (e.payload as { source?: string }).source === "subagent");
		expect(summaries.length).toBe(2);
		expect((summaries[0]!.payload as { text: string }).text).toContain("探查完成");
		unsubscribe();
	}, 30_000);

	test("F2 fork 克隆:父级 systemPrompt 字节级 + 历史切片 + toolLock 收紧", async () => {
		const mgr = new SessionManager({ rootDir: await injectRoot("fork") });
		const main = await mgr.createSession({ title: "fork 源" });
		await mgr.append(main.sessionId, null, { type: "user", payload: { text: "父上下文" } });
		const writer = makeWriter(mgr);
		let seenCtx: { effectiveTools: readonly string[]; systemPrompt: string; historyLen: number } | null = null;
		const runner = new SubagentRunner({
			sessionWriter: writer,
			getHistorySlice: async (sessionId, opts) => {
				const all = await mgr.entries(sessionId);
				const tail = opts.tail ?? all.length;
				return { entries: all.slice(-tail) };
			},
			loopFactory: (_profile, ctx) => ({
				run: async () => {
					seenCtx = {
						effectiveTools: ctx.effectiveTools,
						systemPrompt: ctx.systemPrompt,
						historyLen: ctx.historySlice?.entries.length ?? 0,
					};
					return { ok: true, summary: "fork done" };
				},
			}),
		});
		const res = await runner.spawn("fork", "克隆父上下文续跑", {
			parentSessionId: main.sessionId,
			parentSystemPrompt: "父级系统提示(字节级克隆源)",
			parentTools: ["Read", "Agent", "Bash", "Write"],
			historyTail: 1,
			toolLock: ["Read", "Bash"],
		});
		expect(res.ok).toBe(true);
		// 危害工具 Agent 被剥离;toolLock 只收不放:kept ∩ lock → Write 被剔除
		expect(res.strippedTools).toEqual(["Agent"]);
		expect(seenCtx!.effectiveTools).toEqual(["Read", "Bash"]);
		// 字节级克隆:绝不拼接
		expect(seenCtx!.systemPrompt).toBe("父级系统提示(字节级克隆源)");
		// 历史切片透传
		expect(seenCtx!.historyLen).toBe(1);
	}, 30_000);

	test("F3 swarm:模板扇出并发预算 + 超时结构化 + 非法模板拒绝", async () => {
		// 并发预算:5 任务 / 2 槽 → 峰值在飞 ≤ 2,结果保持输入序
		let inFlight = 0;
		let maxInFlight = 0;
		const swarm = new SwarmService(async (prompt) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 30));
			inFlight -= 1;
			return `done:${prompt}`;
		}, { maxConcurrency: 2 });
		const res = await swarm.swarm(["公报A", "公报B", "公报C", "公报D", "公报E"], {
			promptTemplate: "审计 {{item}} 并核对 953680",
		});
		expect(res.total).toBe(5);
		expect(res.failed).toBe(0);
		expect(res.results.map((r) => r.item)).toEqual(["公报A", "公报B", "公报C", "公报D", "公报E"]);
		expect(res.results.every((r) => r.ok && r.output.startsWith("done:审计 "))).toBe(true);
		expect(maxInFlight).toBeLessThanOrEqual(2);

		// 超时:挂死任务被看门狗拒绝,结构化 error,其余照常
		const swarmT = new SwarmService(
			(prompt) => (prompt.includes("挂") ? new Promise<string>(() => {}) : Promise.resolve("ok")),
			{ maxConcurrency: 2 },
		);
		const resT = await swarmT.swarm(["正常", "挂死任务"], { promptTemplate: "{{item}}", timeoutMs: 80 });
		expect(resT.results[0]!.ok).toBe(true);
		expect(resT.results[1]!.ok).toBe(false);
		expect(resT.failed).toBe(1);
		expect(resT.results[1]!.error).toBeDefined();

		// 非法模板 / 空任务:结构化拒绝
		await expect(swarm.swarm(["x"], { promptTemplate: "无占位符" })).rejects.toBeInstanceOf(SwarmError);
		await expect(swarm.swarm([], { promptTemplate: "{{item}}" })).rejects.toMatchObject({ code: "invalid-tasks" });
	}, 30_000);
});
