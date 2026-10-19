/**
 * BI-28.4 · 执行面真实任务演练 —— 全链路无头走查（全离线、127.0.0.1 only）。
 *
 * 与既有覆盖的分工：
 * - scripts/fake-endpoint-e2e.test.ts：bin 级纯文本回环（无工具调用；BI_PTY_E2E 门控）；
 * - evals/e2e-drill-l-execution.test.ts：toolset 逐工具真面（bash 注入 spawnImpl 零实弹）；
 * - 本演练：脚本化伪端点（本地 Bun.serve SSE，多回合 tool_use 编排）→ BI-04.2
 *   适配器真实解析 → BI-23.1 headless 全回合循环 → buildDefaultToolset 真实
 *   read_file / edit / bash（真实 Bun.spawn 子进程）→ 最终文本收束。
 *
 * 演练剧本（模型侧按回合脚本出牌，任何执行面环节破损都会让断言翻红）：
 *   回合1 read_file 读坏文件 → 回合2 edit 修复（a - b → a + b）→
 *   回合3 bash 真实执行 `bun test calc.test.ts`（子进程内真实跑测试）→
 *   回合4 end_turn 收束文本。
 *
 * 断言面：磁盘上的文件确实被修复；bash 结果 JSON 携带真实测试输出（1 pass /
 * 0 fail / exitCode 0）；stopReason 出现 stop；permissionDecisions 全 allow
 * （auto 门禁 reasonedDefault 放行，器官照常在绑定层运行）；会话 JSONL 落在
 * 注入的临时 sessionsRoot（绝不触真实 HOME）。
 * 网络纪律：端点仅绑定 127.0.0.1 随机端口，进程内显式 close；无任何真实外呼。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHeadless } from "./headless";
import { buildDefaultToolset } from "./toolset";
import { createAdapterModelPort } from "./model-port";

// ---------------------------------------------------------------------------
// 脚本化伪端点：按请求序出牌的多回合 SSE 编排（_messages_ 模态 wire 契约）
// ---------------------------------------------------------------------------

const frame = (obj: unknown): string => JSON.stringify(obj);

/** tool_use 回合帧序：message_start → content_block_start(tool_use) → input_json_delta → message_delta(tool_use) → message_stop。 */
function toolUseTurn(id: string, name: string, input: unknown): string[] {
	return [
		frame({ type: "message_start", message: { usage: { input_tokens: 24 } } }),
		frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name } }),
		frame({
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
		}),
		frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 16 } }),
		frame({ type: "message_stop" }),
	];
}

/** 最终文本回合帧序：message_start → text_delta → message_delta(end_turn) → message_stop。 */
function finalTextTurn(text: string): string[] {
	return [
		frame({ type: "message_start", message: { usage: { input_tokens: 96 } } }),
		frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 24 } }),
		frame({ type: "message_stop" }),
	];
}

interface ScriptedEndpoint {
	/** 恒 http://127.0.0.1:<port>（仅本机回环）。 */
	readonly url: string;
	/** 收到的请求体（按序；断言回合编排用）。 */
	readonly requests: readonly Record<string, unknown>[];
	close(): void;
}

function startScriptedEndpoint(turns: readonly string[][]): ScriptedEndpoint {
	const requests: Array<Record<string, unknown>> = [];
	const sse = (frames: readonly string[]): Response =>
		new Response(frames.map((f) => `data: ${f}\n\n`).join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	const server = Bun.serve({
		port: 0, // 随机空闲端口
		hostname: "127.0.0.1", // 仅本机回环：结构性杜绝外呼
		fetch: async (req) => {
			const raw = await req.text();
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				body = {};
			}
			requests.push(body);
			const index = requests.length - 1;
			// 脚本外多出的回合 = 循环失控，500 让断言翻红（不静默续牌）。
			if (index >= turns.length) {
				return new Response(JSON.stringify({ error: `drill: 超出剧本的第 ${index + 1} 个回合` }), { status: 500 });
			}
			return sse(turns[index]!);
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, requests, close: () => server.stop(true) };
}

// ---------------------------------------------------------------------------
// 演练
// ---------------------------------------------------------------------------

describe("BI-28.4 · 执行面真实任务演练（全链路：伪端点 → 适配器 → headless 循环 → 真实工具）", () => {
	test("读坏文件 → edit 修复 → bash 真实跑 bun test 通过 → end_turn 收束；磁盘确实修好", async () => {
		// ---- 工位：临时工作区（坏文件 + 测试） + 临时会话根（hermetic，不触 HOME） ----
		const ws = await mkdtemp(join(tmpdir(), "bi-exec-drill-"));
		const sessionsRoot = join(ws, "bi-sessions");
		await writeFile(
			join(ws, "calc.ts"),
			["export function add(a: number, b: number): number {", "\treturn a - b; // TODO: 修复：这里应为加法", "}", ""].join("\n"),
			"utf8",
		);
		await writeFile(
			join(ws, "calc.test.ts"),
			[
				'import { expect, test } from "bun:test";',
				'import { add } from "./calc";',
				"",
				'test("add 加法", () => {',
				"\texpect(add(2, 3)).toBe(5);",
				"\texpect(add(-1, 1)).toBe(0);",
				"});",
				"",
			].join("\n"),
			"utf8",
		);

		// ---- 剧本：read → edit → bash → final text ----
		const FINAL_TEXT = "修复完成：add 已改回加法实现，bun test calc.test.ts 通过（1 pass, 0 fail）。";
		const endpoint = startScriptedEndpoint([
			toolUseTurn("toolu_drill_read", "read_file", { path: "calc.ts" }),
			toolUseTurn("toolu_drill_edit", "edit", {
				path: "calc.ts",
				old_string: "return a - b;",
				new_string: "return a + b;",
			}),
			toolUseTurn("toolu_drill_bash", "bash", { command: "bun test calc.test.ts" }),
			finalTextTurn(FINAL_TEXT),
		]);

		const outLines: string[] = [];
		try {
			// ---- 全链路装配（headless.ts 同款装配序：真端口 + 真工具集 + auto 门禁） ----
			const result = await runHeadless({
				prompt: "读取 calc.ts，修复 add 的实现使其通过 calc.test.ts，然后用 bash 运行 bun test calc.test.ts 验证。",
				cwd: ws,
				model: createAdapterModelPort({
					baseUrl: endpoint.url,
					apiKey: "drill-local-only",
					model: "bi-exec-drill",
					mode: "messages",
				}),
				tools: buildDefaultToolset(ws), // 真实绑定：defaultSpawnImpl = 真实 Bun.spawn
				permissionMode: "auto", // 无头无审批 UI：全自动放行 + reasonedDefault 审计标记
				sessionsRoot,
				out: (line) => outLines.push(line),
				maxRounds: 8,
			});

			// ---- 循环收束面：exitCode 0 / 4 回合 / 最终文本为剧本收束词 ----
			expect(result.exitCode).toBe(0);
			expect(result.rounds).toBe(4);
			expect(result.finalText).toBe(FINAL_TEXT);

			// ---- 执行面 ①：磁盘上的文件确实被修复 ----
			const fixed = await readFile(join(ws, "calc.ts"), "utf8");
			expect(fixed).toContain("return a + b;");
			expect(fixed).not.toContain("a - b;");

			// ---- 执行面 ②：三个工具按序真实执行成功 ----
			expect(result.toolResults.map((r) => r.name)).toEqual(["read_file", "edit", "bash"]);
			for (const tr of result.toolResults) expect(tr.ok).toBe(true);

			// ---- 执行面 ③：bash 结果 JSON 携带真实 bun test 输出（真实子进程跑测试） ----
			const bashResult = result.toolResults.find((r) => r.name === "bash");
			expect(bashResult).toBeDefined();
			const parsed = JSON.parse(String(bashResult?.value)) as { exitCode: number; output: string };
			expect(parsed.exitCode).toBe(0);
			expect(parsed.output).toContain("1 pass");
			expect(parsed.output).toContain("0 fail");
			expect(parsed.output).toContain("add 加法");

			// ---- 权限面：三笔决策全 allow（auto 门禁放行；器官在绑定层照常运行） ----
			expect(result.permissionDecisions).toEqual([
				{ tool: "read_file", decision: "allow" },
				{ tool: "edit", decision: "allow" },
				{ tool: "bash", decision: "allow" },
			]);

			// ---- 流事件面：done 帧恰 4 个，末帧 stopReason=stop ----
			const doneEvents = outLines
				.map((line) => JSON.parse(line) as { type?: string; stopReason?: string })
				.filter((e) => e.type === "done");
			expect(doneEvents).toHaveLength(4);
			expect(doneEvents.slice(0, 3).map((e) => e.stopReason)).toEqual(["tool_use", "tool_use", "tool_use"]);
			expect(doneEvents[3]?.stopReason).toBe("stop");
			const last = JSON.parse(outLines[outLines.length - 1] ?? "{}") as {
				type?: string;
				exit?: string;
				rounds?: number;
				finalText?: string;
			};
			expect(last).toMatchObject({ type: "session_done", exit: "ok", rounds: 4, finalText: FINAL_TEXT });

			// ---- wire 面：4 个请求全部落在 127.0.0.1；首请求携带全量工具定义 ----
			expect(endpoint.url.startsWith("http://127.0.0.1:")).toBe(true);
			expect(endpoint.requests).toHaveLength(4);
			const firstTools = (endpoint.requests[0]?.tools as Array<{ name: string }> | undefined) ?? [];
			expect(firstTools.map((t) => t.name)).toEqual([
				"read_file",
				"web_fetch",
				"web_search",
				"glob",
				"grep",
				"bash",
				"edit",
				"write",
			]);
			// 末请求携带 tool_result 回填（bash 结果回灌模型，闭环成立）
			const lastMessages = (endpoint.requests[3]?.messages as Array<{ role: string; content?: unknown }> | undefined) ?? [];
			const lastUser = lastMessages.at(-1);
			expect(lastUser?.role).toBe("user");
			expect(JSON.stringify(lastUser?.content)).toContain("tool_result");

			// ---- hermetic 面：会话 JSONL 落在注入的临时根，绝无真实 HOME 写入 ----
			const sessionFiles = (await readdir(sessionsRoot)).filter((f) => f.endsWith(".jsonl"));
			expect(sessionFiles).toHaveLength(1);
			const transcript = await readFile(join(sessionsRoot, sessionFiles[0] ?? ""), "utf8");
			expect(transcript).toContain("tool_call");
			expect(transcript).toContain("tool_result");
			expect(transcript).toContain(FINAL_TEXT);
		} finally {
			endpoint.close();
			await rm(ws, { recursive: true, force: true });
		}
	}, 120_000);
});
