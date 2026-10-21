/**
 * FIX-A F3 · lsp_navigate 诚实化验收（main 装配面）。
 *
 * 关注面：
 * - config [tools] lsp=true 但宿主未提供 LSP 装配（无 lspClient）→ **不挂载**
 *   lsp_navigate，并发一条结构化警告（依赖缺失不伪造能力；挂一个恒返
 *   lsp-unavailable 的工具即虚账）。
 * - [tools] lsp 未开启 → 不挂载、不告警（缺省零行为差）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBi } from "./main";
import { LSP_MOUNT_SKIPPED_WARNING } from "./toolset";
import type { ModelPort } from "./headless";
import type { StreamEvent } from "../adapters/deepseek-adapter";
import { createDefaultConfig, type BiConfig } from "../config/schema";

/** 记录模型收到的工具名集合。 */
function scriptedModel(): { port: ModelPort; toolNames: () => string[] } {
	const seen: string[] = [];
	const port: ModelPort = {
		async *stream(input): AsyncGenerator<StreamEvent> {
			seen.push(...input.tools.map((t) => t.name));
			yield { type: "content_delta", delta: "好。" };
			yield { type: "done", stopReason: "stop" };
		},
	};
	return { port, toolNames: () => [...seen] };
}

function configWith(patch: (config: BiConfig) => void): BiConfig {
	const config = createDefaultConfig();
	patch(config);
	return config;
}

describe("FIX-A F3 · [tools] lsp=true 但无宿主 LSP 装配 → 不挂载 + 结构化警告", () => {
	test("lsp=true：工具面不含 lsp_navigate；stderr 有结构化警告行", async () => {
		const root = await mkdtemp(join(tmpdir(), "bi-lsp-wire-"));
		const errs: string[] = [];
		try {
			const { port, toolNames } = scriptedModel();
			const code = await runBi(["--prompt", "找定义"], {
				model: port,
				out: () => {},
				err: (line) => errs.push(line),
				config: configWith((c) => {
					c.tools.lsp = true;
					// 打开工具集构建门（[ptc] 未开启时缺省工具集不构建）。
					c.ptc = { enabled: true, timeout_ms: 30_000, max_tool_calls: 64 };
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions") },
			});
			expect(code).toBe(0);
			expect(toolNames()).not.toContain("lsp_navigate");
			expect(errs.join("\n")).toContain("lsp_navigate 未挂载");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("[tools] lsp 未开启：不挂载、不告警（缺省零行为差）", async () => {
		const root = await mkdtemp(join(tmpdir(), "bi-lsp-wire-"));
		const errs: string[] = [];
		try {
			const { port, toolNames } = scriptedModel();
			const code = await runBi(["--prompt", "你好"], {
				model: port,
				out: () => {},
				err: (line) => errs.push(line),
				config: configWith((c) => {
					c.ptc = { enabled: true, timeout_ms: 30_000, max_tool_calls: 64 };
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions") },
			});
			expect(code).toBe(0);
			expect(toolNames()).not.toContain("lsp_navigate");
			expect(errs.join("\n")).not.toContain("lsp_navigate 未挂载");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("FIX-B F8 · 同一条挂载告警只打一遍（两次工具集构建不重复告警）", async () => {
		const root = await mkdtemp(join(tmpdir(), "bi-lsp-wire-"));
		const errs: string[] = [];
		try {
			const { port } = scriptedModel();
			const code = await runBi(["--prompt", "找定义"], {
				model: port,
				out: () => {},
				err: (line) => errs.push(line),
				config: configWith((c) => {
					c.tools.lsp = true;
					// 打开工具集构建门（[ptc] 未开启时缺省工具集不构建）。
					c.ptc = { enabled: true, timeout_ms: 30_000, max_tool_calls: 64 };
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions") },
			});
			expect(code).toBe(0);
			const hits = errs.filter((line) => line === LSP_MOUNT_SKIPPED_WARNING);
			expect(hits).toHaveLength(1); // 无头路径两次构建工具集 → 只告一次
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
