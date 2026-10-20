/**
 * W4-D9（BI-05.1）· headless 记忆沉淀装配验收（headless 面独占）。
 *
 * 覆盖：
 * - 会话收尾沉淀：memory.dream 开→写 <dir>/BI.dream.md（含 finalText 精华）；
 *   空闲阈值用器官既有常量 DEFAULT_DREAM_IDLE_MS（低于阈值不沉淀）；
 * - 锁文件防并发：他人持锁未过期 → 沉淀静默跳过不写盘；
 * - 会话启动注入：memory.inject 开 + <dir>/BI.dream.md 存在 → 内容进 system 面；
 *   缺失 → 不注入（零行为差）；
 * - F-ST-05 注入链补 BI.md：BI.md（项目记忆）+ BI.dream.md（dream 沉淀）双文件
 *   各自存在且非空才注入，BI.md 段在前；两文件内容相同只注一次；
 * - 与 --agent-file（systemInstruction）共存顺序：agent-file 优先，dream 追加其后；
 * - 缺省（memory 未提供）：沉淀/注入全关，行为与既有路径逐字节等价。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadless, type HeadlessOptions, type ModelPort, type ToolBinding } from "./headless";
import type { AgentMessage, StreamEvent } from "../adapters/deepseek-adapter";
import { DREAM_FILE_FILENAME, DEFAULT_DREAM_IDLE_MS, acquireDreamLock } from "../memory/dream";
import { makeMemFs } from "../rules/testing-memfs";

/** 脚本化模型端口：按回合回放事件序列，捕获收到的消息流供接线断言。 */
function scriptedModel(rounds: StreamEvent[][]): {
	port: ModelPort;
	received: Array<{ messages: readonly AgentMessage[]; tools: readonly string[] }>;
} {
	const received: Array<{ messages: readonly AgentMessage[]; tools: readonly string[] }> = [];
	let cursor = 0;
	const port: ModelPort = {
		async *stream(input) {
			const round = rounds[cursor];
			cursor += 1;
			if (round === undefined) throw new Error(`scripted-model: 第 ${cursor} 回合无脚本`);
			received.push({ messages: [...input.messages], tools: input.tools.map((t) => t.name) });
			for (const event of round) yield event;
		},
	};
	return { port, received };
}

const FINAL_ROUND: StreamEvent[] = [
	{ type: "content_delta", delta: "收尾结论。" },
	{ type: "done", stopReason: "stop" },
];

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-w4d9-hl-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function systemTextOf(messages: readonly AgentMessage[]): string {
	const sys = messages.find((m) => m.role === "system");
	return typeof sys?.content === "string" ? sys.content : "";
}

// ---------------------------------------------------------------------------
// 会话收尾沉淀（memory.dream）
// ---------------------------------------------------------------------------

describe("W4-D9 headless: 会话收尾沉淀（BI-05.1 dream）", () => {
	test("开（idleMs 到阈值）：finalText 精华写入 <dir>/BI.dream.md", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs();
			const { port } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				memory: { dream: { dir: "/proj", fs, idleMs: DEFAULT_DREAM_IDLE_MS, now: () => 1_000 } },
				out: () => {},
			} as HeadlessOptions);
			const content = fs.peek(`/proj/${DREAM_FILE_FILENAME}`) ?? "";
			expect(content).toContain("## dream @ ");
			expect(content).toContain("- 收尾结论。");
			expect(content.endsWith("\n")).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("空闲低于阈值：不沉淀（零写盘）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs();
			const { port } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				memory: { dream: { dir: "/proj", fs, idleMs: DEFAULT_DREAM_IDLE_MS - 1, now: () => 1_000 } },
				out: () => {},
			} as HeadlessOptions);
			// 空闲不足 → 跳过 consolidate，BI.dream.md 不存在。
			expect(fs.existsSync(`/proj/${DREAM_FILE_FILENAME}`)).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("缺省（未提供 memory）：不沉淀（零写盘，现状逐字节等价）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs();
			const { port } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				out: () => {},
			} as HeadlessOptions);
			// 即便注入 memfs，也无任何沉淀写盘（memory 未装配）。
			expect(fs.existsSync(`/proj/${DREAM_FILE_FILENAME}`)).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("锁文件防并发：他人持锁未过期 → 沉淀静默跳过，BI.dream.md 不写盘", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs();
			// 模拟另一进程已持锁（未过期）。
			const held = acquireDreamLock("/proj", { fs, now: 1_000, pid: 111 });
			expect(held).not.toBeNull();
			const { port } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				memory: { dream: { dir: "/proj", fs, idleMs: DEFAULT_DREAM_IDLE_MS, now: () => 2_000 } },
				out: () => {},
			} as HeadlessOptions);
			// 锁被他人持有 → consolidate 返回 {ok:false,reason:"locked"} → 不写盘。
			expect(fs.existsSync(`/proj/${DREAM_FILE_FILENAME}`)).toBe(false);
			// 锁仍由他人持有（未被本会话释放）。
			expect(fs.existsSync("/proj/.consolidate-lock")).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("extractor 注入：映射 finalText 精华后再沉淀", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs();
			const { port } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				memory: {
					dream: {
						dir: "/proj",
						fs,
						idleMs: DEFAULT_DREAM_IDLE_MS,
						now: () => 1,
						extractor: (s) => `提炼: ${s.trim()}`,
					},
				},
				out: () => {},
			} as HeadlessOptions);
			const content = fs.peek(`/proj/${DREAM_FILE_FILENAME}`) ?? "";
			expect(content).toContain("- 提炼: 收尾结论。");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// 会话启动注入（memory.inject）
// ---------------------------------------------------------------------------

describe("W4-D9 headless: 会话启动注入（BI-05.1 inject）", () => {
	test("开 + BI.dream.md 存在：内容进 system 面", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs({ files: { "/proj/BI.dream.md": "- 既有沉淀一\n- 既有沉淀二" } });
			const { port, received } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				memory: { inject: { dir: "/proj", fs } },
				out: () => {},
			} as HeadlessOptions);
			const sys = systemTextOf(received[0]!.messages);
			expect(sys).toContain("既有沉淀一");
			expect(sys).toContain("既有沉淀二");
		} finally {
			await cleanup();
		}
	});

	test("缺失 BI.dream.md：不注入（零行为差）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs(); // 无 BI.dream.md
			const { port, received } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				memory: { inject: { dir: "/proj", fs } },
				out: () => {},
			} as HeadlessOptions);
			expect(systemTextOf(received[0]!.messages)).toBe("");
		} finally {
			await cleanup();
		}
	});

	test("与 --agent-file（systemInstruction）共存：agent-file 优先，dream 追加其后", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs({ files: { "/proj/BI.dream.md": "沉淀记忆内容" } });
			const { port, received } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				systemInstruction: "你是助手。",
				memory: { inject: { dir: "/proj", fs } },
				out: () => {},
			} as HeadlessOptions);
			const sys = systemTextOf(received[0]!.messages);
			expect(sys.startsWith("你是助手。")).toBe(true); // agent-file 优先
			expect(sys).toContain("沉淀记忆内容"); // dream 追加其后
			expect(sys.indexOf("你是助手。")).toBeLessThan(sys.indexOf("沉淀记忆内容"));
		} finally {
			await cleanup();
		}
	});

	test("注入 + 沉淀双开：启动注入既有沉淀，收尾再追加新沉淀（合并语义）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs({ files: { "/proj/BI.dream.md": "- 既有沉淀" } });
			const { port, received } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				memory: {
					inject: { dir: "/proj", fs },
					dream: { dir: "/proj", fs, idleMs: DEFAULT_DREAM_IDLE_MS, now: () => 1_000 },
				},
				out: () => {},
			} as HeadlessOptions);
			// 启动注入既有沉淀
			expect(systemTextOf(received[0]!.messages)).toContain("既有沉淀");
			// 收尾追加新沉淀（合并语义：既有段不重复落）
			const content = fs.peek(`/proj/${DREAM_FILE_FILENAME}`) ?? "";
			expect(content).toContain("既有沉淀");
			expect(content).toContain("收尾结论。");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// F-ST-05：注入链补 BI.md（项目记忆 + dream 沉淀双文件）
// ---------------------------------------------------------------------------

describe("F-ST-05 headless: 记忆注入双文件（BI.md + BI.dream.md）", () => {
	test("仅 BI.md 存在：内容进 system 面（init 产出的项目记忆被消费）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs({ files: { "/proj/BI.md": "# 项目记忆\n- 技术栈：Bun + TypeScript" } });
			const { port, received } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				memory: { inject: { dir: "/proj", fs } },
				out: () => {},
			} as HeadlessOptions);
			const sys = systemTextOf(received[0]!.messages);
			expect(sys).toContain("项目记忆");
			expect(sys).toContain("技术栈：Bun + TypeScript");
		} finally {
			await cleanup();
		}
	});

	test("两文件都在：各自注入，BI.md 段在前（项目规则先于沉淀记忆）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs({
				files: { "/proj/BI.md": "项目记忆正文", "/proj/BI.dream.md": "沉淀记忆正文" },
			});
			const { port, received } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				memory: { inject: { dir: "/proj", fs } },
				out: () => {},
			} as HeadlessOptions);
			const sys = systemTextOf(received[0]!.messages);
			expect(sys).toContain("项目记忆正文");
			expect(sys).toContain("沉淀记忆正文");
			expect(sys.indexOf("项目记忆正文")).toBeLessThan(sys.indexOf("沉淀记忆正文"));
		} finally {
			await cleanup();
		}
	});

	test("两文件内容相同：只注一次（去重，不重复进 system 面）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs({
				files: { "/proj/BI.md": "同一段记忆", "/proj/BI.dream.md": "同一段记忆" },
			});
			const { port, received } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				memory: { inject: { dir: "/proj", fs } },
				out: () => {},
			} as HeadlessOptions);
			const sys = systemTextOf(received[0]!.messages);
			expect(sys).toContain("同一段记忆");
			expect(sys.split("同一段记忆").length - 1).toBe(1);
		} finally {
			await cleanup();
		}
	});

	test("BI.md 为空（纯空白）：不注入该段（其余文件照常）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs({
				files: { "/proj/BI.md": "   \n\t ", "/proj/BI.dream.md": "沉淀记忆正文" },
			});
			const { port, received } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				memory: { inject: { dir: "/proj", fs } },
				out: () => {},
			} as HeadlessOptions);
			const sys = systemTextOf(received[0]!.messages);
			expect(sys).toContain("沉淀记忆正文");
			expect(sys.trim().length).toBe("沉淀记忆正文".length);
		} finally {
			await cleanup();
		}
	});

	test("两文件都缺失：不注入（零行为差）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs();
			const { port, received } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				memory: { inject: { dir: "/proj", fs } },
				out: () => {},
			} as HeadlessOptions);
			expect(systemTextOf(received[0]!.messages)).toBe("");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// 缺省全关零变化回归
// ---------------------------------------------------------------------------

describe("W4-D9 headless: 缺省等价（memory 未提供 = 现状逐字节等价）", () => {
	test("无任何 memory 选项：无 system 注入、无沉淀写盘、正常退出", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fs = makeMemFs();
			const { port, received } = scriptedModel([FINAL_ROUND]);
			const result = await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				out: () => {},
			} as HeadlessOptions);
			expect(result.exitCode).toBe(0);
			expect(systemTextOf(received[0]!.messages)).toBe(""); // 无注入
			expect(fs.existsSync(`/proj/${DREAM_FILE_FILENAME}`)).toBe(false); // 无沉淀
		} finally {
			await cleanup();
		}
	});
});
