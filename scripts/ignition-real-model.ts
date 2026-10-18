#!/usr/bin/env bun
/**
 * BI-23.3 —— 真实模型端到端点火（实弹 e2e，非 bun test 套件成员）。
 *
 * 门控纪律（零外呼默认）：
 * - 不设 BI_IGNITION=1 → 直接跳过，退出 0，零网络；
 * - 设 BI_IGNITION=1 但缺 BI_IGNITION_API_KEY → DEGRADED 备案退出 0（沿 BI-21
 *   矩阵纪律：环境无凭据时降级备案，绝不伪造 PASS）；
 * - 两者齐备 → 对真实端点跑双模态（anthropic-messages / openai）各一次完整
 *   会话：main 配置装配 → BI-02 凭据门 → BI-04.2 SSE 驱动 → BI-07 工具流水线
 *   → BI-03 JSONL 会话，断言工具真实回环（模型自主调用 read_file）。
 *
 * 凭据安全：key 仅存于运行进程环境（BI_MIMO_API_KEY），配置文件只写
 * api_key_env 变量名，不落盘、不入库、不打印。
 *
 * 用法：
 *   BI_IGNITION=1 BI_IGNITION_API_KEY=<key> bun scripts/ignition-real-model.ts
 * 可选：BI_IGNITION_ORIGIN（缺省 https://token-plan-cn.xiaomimimo.com）、
 *       BI_IGNITION_MODEL（缺省 mimo-v2.6-flash）
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ToolBinding } from "../packages/core/src/cli/headless";
import { runBi } from "../packages/core/src/cli/main";

const MAGIC = "42";

function readFileSyncBinding(cwd: string): ToolBinding {
	return {
		definition: {
			name: "read_file",
			description: "读取工作区内文本文件",
			inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
		readOnly: true,
		argSummary: (args) => String((args as { path?: string }).path ?? ""),
		execute: async (args) => {
			const path = (args as { path?: string }).path;
			if (typeof path !== "string" || path === "") throw new Error("path required");
			const abs = resolve(cwd, path);
			if (!abs.startsWith(resolve(cwd))) throw new Error("path-escape");
			return await Bun.file(abs).text();
		},
	};
}

interface PassSpec {
	provider: string;
	label: string;
}

interface PassOutcome {
	label: string;
	provider: string;
	verdict: "PASS" | "FAIL";
	exitCode: number;
	contentDeltas: number;
	thinkingDeltas: number;
	toolCalls: number;
	toolResultsOk: number;
	usageEvents: number;
	rounds: number;
	finalText: string;
	reason: string;
}

const PROMPT = "请使用 read_file 工具读取 note.txt，然后把文件里的数字原样告诉我。";

async function runPass(spec: PassSpec, key: string, model: string, origin: string): Promise<PassOutcome> {
	const home = await mkdtemp(join(tmpdir(), "bi-ign-home-"));
	const work = await mkdtemp(join(tmpdir(), "bi-ign-work-"));
	const sessionsRoot = join(home, "sessions");
	try {
		await mkdir(join(home, ".bi"), { recursive: true });
		await writeFile(join(work, "note.txt"), `魔数是 ${MAGIC}\n`, "utf8");
		const configToml = `
[providers.entries.mimo_anthropic]
api_key_env = "BI_MIMO_API_KEY"
base_url = "${origin}"
kind = "anthropic"
models = ["${model}"]

[providers.entries.mimo_openai]
api_key_env = "BI_MIMO_API_KEY"
base_url = "${origin}/v1"
kind = "openai"
models = ["${model}"]

[models]
default = "main"

[models.entries.main]
provider = ""
model = "${model}"
`;
		await writeFile(join(home, ".bi", "config.toml"), configToml, "utf8");

		const lines: string[] = [];
		const errs: string[] = [];
		const previous = {
			provider: process.env.BI_PROVIDER,
			key: process.env.BI_MIMO_API_KEY,
			effort: process.env.BI_THINKING_EFFORT,
		};
		process.env.BI_MIMO_API_KEY = key;
		process.env.BI_PROVIDER = spec.provider;
		process.env.BI_THINKING_EFFORT = "minimal";
		let exitCode: number;
		try {
			exitCode = await runBi(["--prompt", PROMPT, "--output-format", "stream-json"], {
				out: (line) => lines.push(line),
				err: (line) => errs.push(line),
				headless: { homeDir: home, cwd: work, sessionsRoot, tools: [readFileSyncBinding(work)] },
			});
		} finally {
			if (previous.provider === undefined) delete process.env.BI_PROVIDER;
			else process.env.BI_PROVIDER = previous.provider;
			if (previous.effort === undefined) delete process.env.BI_THINKING_EFFORT;
			else process.env.BI_THINKING_EFFORT = previous.effort;
			if (previous.key === undefined) delete process.env.BI_MIMO_API_KEY;
			else process.env.BI_MIMO_API_KEY = previous.key;
		}

		const events = lines
			.map((line) => {
				try {
					return JSON.parse(line) as Record<string, unknown>;
				} catch {
					return undefined;
				}
			})
			.filter((e): e is Record<string, unknown> => e !== undefined);
		const done = events.at(-1);
		const sessionDone = done?.type === "session_done" ? (done as { rounds?: number; finalText?: string }) : undefined;
		const contentDeltas = events.filter((e) => e.type === "content_delta").length;
		const thinkingDeltas = events.filter((e) => e.type === "thinking_delta").length;
		const usageEvents = events.filter((e) => e.type === "usage").length;
		const errorEvents = events.filter((e) => e.type === "error");

		// 会话 JSONL 断言：user/assistant/tool_call/tool_result 条目链在盘。
		let toolCalls = 0;
		let toolResultsOk = 0;
		let sessionFileCount = 1;
		const sessionFiles = (await readdir(sessionsRoot)).filter((f) => f.endsWith(".jsonl"));
		if (sessionFiles.length === 1) {
			const raw = await readFile(join(sessionsRoot, sessionFiles[0]!), "utf8");
			for (const line of raw.split("\n")) {
				if (line === "") continue;
				// 记录形状：{kind:"meta"|"entry", v, entry?:{type,payload,...}}（BI-03 jsonl 契约）
				const record = JSON.parse(line) as { kind?: string; entry?: { type?: string; payload?: { ok?: boolean } } };
				const entry = record.entry;
				if (record.kind !== "entry" || entry === undefined) continue;
				if (entry.type === "tool_call") toolCalls += 1;
				if (entry.type === "tool_result" && entry.payload?.ok === true) toolResultsOk += 1;
			}
		} else {
			sessionFileCount = sessionFiles.length;
		}
		const finalText = sessionDone?.finalText ?? "";
		const reasons: string[] = [];
		if (exitCode !== 0) reasons.push(`exitCode=${exitCode} errs=${errs.join(" | ").slice(0, 300)}`);
		if (errorEvents.length > 0) reasons.push(`stream errors=${JSON.stringify(errorEvents).slice(0, 400)}`);
		if (contentDeltas === 0) reasons.push("无 content_delta");
		if (sessionFileCount !== 1) reasons.push(`会话文件数异常: ${sessionFileCount}`);
		if (toolCalls === 0) reasons.push("模型未发起工具调用（工具回环未点亮）");
		if (toolResultsOk === 0) reasons.push("无成功 tool_result 落盘");
		if (!finalText.includes(MAGIC)) reasons.push(`finalText 未包含 ${MAGIC}: "${finalText.slice(0, 120)}"`);
		if (sessionDone === undefined) reasons.push("缺 session_done 终帧");

		return {
			label: spec.label,
			provider: spec.provider,
			verdict: reasons.length === 0 ? "PASS" : "FAIL",
			exitCode,
			contentDeltas,
			thinkingDeltas,
			toolCalls,
			toolResultsOk,
			usageEvents,
			rounds: sessionDone?.rounds ?? -1,
			finalText: finalText.slice(0, 200),
			reason: reasons.join("; ") || "全链贯通：SSE 流 + 工具自主回环 + 会话落盘 + stream-json 合约",
		};
	} finally {
		await rm(home, { recursive: true, force: true });
		await rm(work, { recursive: true, force: true });
	}
}

async function main(): Promise<number> {
	if (process.env.BI_IGNITION !== "1") {
		console.log(JSON.stringify({ ignition: "SKIPPED", note: "设置 BI_IGNITION=1 并提供 BI_IGNITION_API_KEY 以执行真实点火；默认零外呼。" }));
		return 0;
	}
	const key = process.env.BI_IGNITION_API_KEY ?? "";
	if (key === "") {
		console.log(JSON.stringify({ ignition: "DEGRADED", note: "BI_IGNITION_API_KEY 未设置：无凭据环境按 BI-21 纪律降级备案，不执行、不伪造 PASS。" }));
		return 0;
	}
	const origin = (process.env.BI_IGNITION_ORIGIN ?? "https://token-plan-cn.xiaomimimo.com").replace(/\/+$/, "");
	const model = process.env.BI_IGNITION_MODEL ?? "mimo-v2.6-flash";
	const passes: PassSpec[] = [
		{ provider: "mimo_anthropic", label: "anthropic-messages" },
		{ provider: "mimo_openai", label: "openai-completions" },
	];
	const outcomes: PassOutcome[] = [];
	for (const spec of passes) {
		const wireUrl =
			spec.provider === "mimo_anthropic" ? `${origin}/anthropic/v1/messages` : `${origin}/v1/chat/completions`;
		process.stdout.write(`bi: 点火中 [${spec.label}] ${wireUrl} model=${model} ...\n`);
		const outcome = await runPass(spec, key, model, origin);
		outcomes.push(outcome);
		process.stdout.write(
			`bi: [${spec.label}] ${outcome.verdict} rounds=${outcome.rounds} contentΔ=${outcome.contentDeltas} thinkingΔ=${outcome.thinkingDeltas} tool_calls=${outcome.toolCalls} tool_ok=${outcome.toolResultsOk} usage=${outcome.usageEvents} — ${outcome.reason}\n`,
		);
	}
	const allPass = outcomes.every((o) => o.verdict === "PASS");
	const anyPass = outcomes.some((o) => o.verdict === "PASS");
	const summary = {
		ignition: allPass ? "PASS" : anyPass ? "PARTIAL" : "FAIL",
		model,
		origin,
		apiKey: "REDACTED",
		passes: outcomes.map((o) => ({
			label: o.label,
			provider: o.provider,
			verdict: o.verdict,
			exitCode: o.exitCode,
			contentDeltas: o.contentDeltas,
			thinkingDeltas: o.thinkingDeltas,
			toolCalls: o.toolCalls,
			toolResultsOk: o.toolResultsOk,
			usageEvents: o.usageEvents,
			rounds: o.rounds,
			reason: o.reason,
		})),
	};
	console.log(JSON.stringify(summary, null, 2));
	return allPass ? 0 : 1;
}

process.exitCode = await main();
