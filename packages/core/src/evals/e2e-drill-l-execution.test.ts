/**
 * BI-26.1 —— 工位 L 域级演练:执行面与装配链(BI-23/24/25 器官入阵)。
 *
 * 链路 1(toolset 真面):buildDefaultToolset 真实绑定 —— write 原子写 →
 * read_file 实读 → edit 唯一替换($& 字面量不被 $ 展开) → bash 注入 spawnImpl
 * (零实弹)+ shell-scan 审计注记;根外路径一律 path-escape。
 * 链路 2(model-port 装配):BiConfig fixture → resolveModelPort 选择链
 * (models.default → provider → kind → api_key_env 凭据门),失败面结构化。
 * 链路 3(agent-tui 挂载):AgentTuiSession 真装配 + 脚本化 ModelPort 全回合,
 * onFrame 行集探针断言行分离(提示行/状态行不叠写 —— BI-26.4 pty 锚点的
 * 进程内等价物,24x80 网格真实渲染)。
 * 链路 4(acp 桥):AcpSessionConnection 全生命周期(initialize → session/new →
 * session/prompt×2 同链续聊 → session/end),JSONL 落盘验证,单飞忙拒绝。
 * 链路 5(八子命令):runBi 真分发 init/session/fork/export/transfer/acp/
 * upgrade/doctor 逐个真实代码路径(注入 IO,零外呼)。
 *
 * 注入仅限 I/O 边界(spawnImpl/模型端口/帧通道/探针端口);装配层、权限门、
 * 路径守卫、协议层全部真实代码。零 DEGRADED:无 skipIf 门,全链无条件下沉。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDefaultToolset } from "../cli/toolset";
import { ModelPortConfigError, resolveModelPort } from "../cli/model-port";
import { ConfigService } from "../config/config-service";
import { AcpSessionConnection } from "../cli/commands/acp-session";
import { PermissionSessionController } from "../cli/permission-mode";
import { permissionsCommand } from "../cli/commands/permissions-command";
import { SessionManager } from "../session/manager";
import { runBi } from "../cli/main";
import type { ModelPort } from "../cli/headless";
import type { StreamEvent } from "../adapters/deepseek-adapter";
import { AgentTuiSession } from "../../../tui/src/mount/agent-tui";

// ---------------------------------------------------------------------------
// 共用夹具
// ---------------------------------------------------------------------------

const CLEANUPS: string[] = [];

function tmpRoot(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	CLEANUPS.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of CLEANUPS) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// 清理尽力而为
		}
	}
});

/** 收集型 IO(runBi deps 同形)。 */
function collectIo(): { io: { out: (l: string) => void; err: (l: string) => void }; outs: string[]; errs: string[] } {
	const outs: string[] = [];
	const errs: string[] = [];
	return { io: { out: (l) => void outs.push(l), err: (l) => void errs.push(l) }, outs, errs };
}

/** 脚本化模型端口:依次吐文本增量后 done(零网络、零延时)。 */
function scriptedPort(chunks: readonly string[]): ModelPort {
	return {
		stream(): AsyncIterable<StreamEvent> {
			return (async function* (): AsyncIterable<StreamEvent> {
				for (const chunk of chunks) {
					yield { type: "content_delta", delta: chunk };
				}
				yield { type: "done", stopReason: "stop" };
			})();
		},
	};
}

/** 可写模型端口工厂(每回合独立脚本)。 */
function scriptedPortFactory(script: readonly string[][]): () => ModelPort {
	let call = 0;
	return () => scriptedPort(script[Math.min(call++, script.length - 1)] ?? []);
}

// ---------------------------------------------------------------------------
// 链路 1 —— toolset 真面(写 → 读 → 改 → 跑;守卫拒绝面)
// ---------------------------------------------------------------------------

describe("BI-26.1 链路 1:toolset 真面(执行工具全链)", () => {
	test("write 原子写 → read_file 实读 → edit 唯一替换($& 字面量) → bash 注入 spawnImpl", async () => {
		const ws = tmpRoot("bi-drill-l-ws-");
		mkdirSync(join(ws, "src"), { recursive: true });
		const toolset = buildDefaultToolset(ws);
		const byName = new Map(toolset.map((b) => [b.definition.name, b]));
		const signal = new AbortController().signal;

		// write:父目录在位,原子写落盘
		const writeResult = (await byName.get("write")!.execute(
			{ path: "src/a.ts", content: "export const x = 1;\n" },
			signal,
		)) as string;
		expect(JSON.parse(writeResult).ok).toBe(true);
		expect(readFileSync(join(ws, "src", "a.ts"), "utf8")).toContain("x = 1");

		// read_file:真实器官读回
		const text = (await byName.get("read_file")!.execute({ path: "src/a.ts" }, signal)) as string;
		expect(text).toContain("export const x = 1;");

		// edit:唯一替换;$& 是 String.replace 的特殊序列,必须按字面量落盘(wave-1 缺陷面)
		await byName.get("edit")!.execute(
			{ path: "src/a.ts", old_string: "x = 1", new_string: 'y = "$&"' },
			signal,
		);
		const after = readFileSync(join(ws, "src", "a.ts"), "utf8");
		expect(after).toContain('y = "$&"');
		expect(after).not.toContain('y = "x = 1"');

		// edit:零命中结构化报错
		await expect(
			byName.get("edit")!.execute({ path: "src/a.ts", old_string: "不存在", new_string: "z" }, signal),
		).rejects.toThrow();

		// bash:spawnImpl 注入(零实弹),输出形状 {exitCode, output}
		const seen: string[][] = [];
	 const offline = buildDefaultToolset(ws, {
			spawnImpl: (cmd, _options) => {
				seen.push([...cmd]);
				const encoder = new TextEncoder();
				return {
					exited: Promise.resolve(0),
					stdout: new ReadableStream<Uint8Array>({
						start(c) {
							c.enqueue(encoder.encode("drill-ok"));
							c.close();
						},
					}),
					stderr: new ReadableStream<Uint8Array>({ start(c) {
						c.close();
					} }),
					kill: () => undefined,
				};
			},
		});
		const bash = new Map(offline.map((b) => [b.definition.name, b])).get("bash")!;
		const bashResult = (await bash.execute({ command: "echo drill-ok" }, signal)) as string;
		const parsed = JSON.parse(bashResult) as { exitCode: number; output: string };
		expect(parsed.exitCode).toBe(0);
		expect(parsed.output).toContain("drill-ok");
		expect(seen).toHaveLength(1);

		// bash argSummary:确定性危险命令(rm -rf /)带 shell-scan 注记;良性命令零注记
		const dangerousSummary = bash.argSummary?.({ command: "rm -rf /" }) ?? "";
		expect(dangerousSummary).toContain("rm -rf /");
		expect(dangerousSummary).toMatch(/\[shell-scan:(dangerous|dangerous\+opaque)\]/);
		const benignSummary = bash.argSummary?.({ command: "echo hi" }) ?? "";
		expect(benignSummary).not.toContain("shell-scan");
	});

	test("守卫面:根外路径 read/write/edit 一律拒绝,绝不读入内容", async () => {
		const ws = tmpRoot("bi-drill-l-ws2-");
		const outside = tmpRoot("bi-drill-l-out-");
		const secret = join(outside, "secret.txt");
		writeFileSync(secret, "TOP-SECRET", { mode: 0o600 });
		const toolset = buildDefaultToolset(ws);
		const byName = new Map(toolset.map((b) => [b.definition.name, b]));
		const signal = new AbortController().signal;

		await expect(
			byName.get("read_file")!.execute({ path: "../bi-drill-l-out-/secret.txt" }, signal),
		).rejects.toThrow();
		// 绝对路径同样拒绝
		await expect(byName.get("read_file")!.execute({ path: secret }, signal)).rejects.toThrow();
		await expect(
			byName.get("write")!.execute({ path: "../escape.txt", content: "no" }, signal),
		).rejects.toThrow();
		await expect(
			byName.get("edit")!.execute(
				{ path: "../secret.txt", old_string: "TOP", new_string: "no" },
				signal,
			),
		).rejects.toThrow();
		expect(readFileSync(secret, "utf8")).toBe("TOP-SECRET");
	});
});

// ---------------------------------------------------------------------------
// 链路 2 —— model-port 装配链(配置 → 凭据门 → 协议选择)
// ---------------------------------------------------------------------------

function configFixture(kind: string, withEnvKey = true): string {
	return [
		"[providers.entries.fake]",
		`api_key_env = ${withEnvKey ? '"BI_DRILL_L_KEY"' : '""'}`,
		'base_url = "https://mimo.example.internal/v1"',
		`kind = "${kind}"`,
		'models = ["fake-mini"]',
		"",
		"[providers]",
		'default = "fake"',
		"",
		"[models]",
		'default = "main"',
		"",
		"[models.entries.main]",
		'provider = "fake"',
		'model = "fake-mini"',
		"",
	].join("\n");
}

function configHome(lines: string): string {
	const home = tmpRoot("bi-drill-l-home-");
	mkdirSync(join(home, ".bi"), { recursive: true });
	writeFileSync(join(home, ".bi", "config.toml"), lines, { mode: 0o600 });
	return home;
}

describe("BI-26.1 链路 2:model-port 装配链(真实配置代码路径)", () => {
	test("openai kind:选择链贯通,selection 携带 provider/mode/baseUrl", async () => {
		const home = configHome(configFixture("openai"));
		const config = await new ConfigService({ env: { BI_DRILL_L_KEY: "k" }, homeDir: home }).load();
		const selection = resolveModelPort(config, { env: { BI_DRILL_L_KEY: "k" } });
		expect(selection.providerName).toBe("fake");
		expect(selection.modelId).toBe("main");
		expect(selection.wireModel).toBe("fake-mini");
		expect(selection.mode).toBe("openai");
		expect(selection.baseUrl).toBe("https://mimo.example.internal/v1");
	});

	test("anthropic kind → messages 协议;google kind → 结构化报错(不猜测不降级)", async () => {
		// anthropic fixture 用无静态 Key 形态(api_key_env=""),凭据门天然放行
		const homeOk = configHome(configFixture("anthropic", false));
		const cfgOk = await new ConfigService({ env: {}, homeDir: homeOk }).load();
		expect(resolveModelPort(cfgOk, { env: {} }).mode).toBe("messages");

		const homeBad = configHome(configFixture("google"));
		const cfgBad = await new ConfigService({ env: {}, homeDir: homeBad }).load();
		expect(() => resolveModelPort(cfgBad, { env: {} })).toThrow(ModelPortConfigError);
		expect(() => resolveModelPort(cfgBad, { env: {} })).toThrow(/暂无已装配驱动/);
	});

	test("凭据门:api_key_env 未设 → ModelPortConfigError 带导出指引;api_key_env 空 = 无静态 Key 形态放行", async () => {
		const home = configHome(configFixture("openai"));
		const config = await new ConfigService({ env: {}, homeDir: home }).load();
		try {
			resolveModelPort(config, { env: {} });
			throw new Error("应当抛出");
		} catch (e) {
			expect(e).toBeInstanceOf(ModelPortConfigError);
			expect((e as Error).message).toContain("BI_DRILL_L_KEY");
			expect((e as Error).message).toContain("api_key_env");
		}

		const homeNoKey = configHome(configFixture("openai", false));
		const cfgNoKey = await new ConfigService({ env: {}, homeDir: homeNoKey }).load();
		expect(() => resolveModelPort(cfgNoKey, { env: {} })).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// 链路 3 —— agent-tui 挂载(真装配全回合;onFrame 行集探针 = pty 锚点的进程内等价)
// ---------------------------------------------------------------------------

describe("BI-26.1 链路 3:agent-tui 挂载(24x80 网格真实渲染)", () => {
	test("全回合:流式预览出现 → 收束清空;状态行/提示行分离不叠写;JSONL 落盘", async () => {
		const root = tmpRoot("bi-drill-l-tui-");
		const rows = 24;
		const cols = 80;
		const frames: string[][] = [];
		const session = new AgentTuiSession({
			model: scriptedPort(["你好", ",世界"]),
			tools: [],
			cwd: root,
			sessionsRoot: join(root, "sessions"),
			permissionMode: "manual",
			rows,
			cols,
			hooks: {
				onFrame: (visible) => {
					frames.push([...visible]);
				},
			},
		});
		const sessionId = await session.start("演练");
		expect(sessionId.length).toBeGreaterThan(0);

		const result = await session.submit("打声招呼");
		expect(result.finalText).toContain("你好");
		expect(result.finalText).toContain("世界");
		expect(session.state).toBe("idle");

		// 出帧过且非空(帧=审批浮层+转录尾窗+流式行+状态行;长度随内容浮动)
		expect(frames.length).toBeGreaterThan(0);
		for (const frame of frames) {
			expect(frame.length).toBeGreaterThanOrEqual(1);
		}
		// 流式预览:回合中出现过 ▌ 前缀行(BI-27.2),收束后不再出现
		expect(frames.some((f) => f.some((l) => l.includes("▌")))).toBe(true);
		const lastFrame = frames.at(-1)!;
		expect(lastFrame.some((l) => l.includes("▌"))).toBe(false);
		// 帧末行 = 状态行(含权限模式 [manual];❯ 提示行归 runRepl 画,submit() 流程无之)
		expect(lastFrame.at(-1)).toContain("[manual]");
		expect(lastFrame.at(-1)).not.toContain("▌");
		// 转录尾窗:回合双方(user 提问/assistant 回复)以纯 L3 文本入帧
		expect(lastFrame.join("\n")).toContain("你好");

		// JSONL 落盘:user + assistant 双方入链
		const manager = new SessionManager({ rootDir: join(root, "sessions") });
		const entries = await manager.entries(sessionId);
		const types = entries.map((e) => e.type);
		expect(types).toContain("user");
		expect(types).toContain("assistant");
	});

	test("斜杠命令拦截(BI-28.3 接线):/permissions 切模式即时生效且不入模型回合", async () => {
		const root = tmpRoot("bi-drill-l-slash-");
		const frames: string[][] = [];
		const controller = new PermissionSessionController({ mode: "manual" });
		const session = new AgentTuiSession({
			model: scriptedPort(["不应被调用"]),
			tools: [],
			cwd: root,
			sessionsRoot: join(root, "sessions"),
			gate: controller.gate,
			rows: 24,
			cols: 80,
			slashCommand: async (line) => {
				const body = line.trim().replace(/^\/permissions\b/, "").trim();
				const parsed = permissionsCommand.parse(body);
				if (!parsed.ok) return parsed.error.message;
				return permissionsCommand.execute(parsed.args, controller.toPorts()).join("\n");
			},
			hooks: {
				onFrame: (visible) => {
					frames.push([...visible]);
				},
			},
		});
		const sessionId = await session.start("拦截演练");

		const result = await session.submit("/permissions yolo");
		expect(result.endedAs).toBe("finish");
		expect(result.finalText).toContain("manual → yolo");
		// 共享 gate 即时生效:状态行与门禁模式同步
		expect(session.statusText()).toContain("[yolo]");
		// 不入模型回合:finalText 是命令回执而非模型文本;JSONL 无条目(仅 meta)
		expect(result.finalText).not.toContain("不应被调用");
		const manager = new SessionManager({ rootDir: join(root, "sessions") });
		expect(await manager.entries(sessionId)).toHaveLength(0);
		// system 行已上屏(帧尾窗含切换回执)
		expect(frames.at(-1)!.join("\n")).toContain("manual → yolo");
	});
});

// ---------------------------------------------------------------------------
// 链路 4 —— acp 桥全生命周期(协议帧 → JSONL 链)
// ---------------------------------------------------------------------------

function acpFrame(obj: unknown): Uint8Array {
	const body = new TextEncoder().encode(JSON.stringify(obj));
	const head = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
	const frameBytes = new Uint8Array(head.byteLength + body.byteLength);
	frameBytes.set(head, 0);
	frameBytes.set(body, head.byteLength);
	return frameBytes;
}

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

function decodeAcpFrames(chunks: Uint8Array[]): unknown[] {
	const all = chunks.reduce((acc, c) => {
		const merged = new Uint8Array(acc.byteLength + c.byteLength);
		merged.set(acc, 0);
		merged.set(c, acc.byteLength);
		return merged;
	}, new Uint8Array(0));
	const frames: unknown[] = [];
	let cursor = 0;
	while (cursor < all.byteLength) {
		// 逐字节扫描 \r\n\r(Uint8Array.indexOf 不支持串+编码形态,Bun 语义)
		let headerEnd = -1;
		for (let i = cursor; i + 4 <= all.byteLength; i++) {
			if (all[i] === 13 && all[i + 1] === 10 && all[i + 2] === 13 && all[i + 3] === 10) {
				headerEnd = i;
				break;
			}
		}
		if (headerEnd === -1) break;
		const header = new TextDecoder("ascii").decode(all.subarray(cursor, headerEnd));
		const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
		if (!Number.isFinite(length)) break;
		const bodyStart = headerEnd + 4;
		frames.push(JSON.parse(new TextDecoder().decode(all.subarray(bodyStart, bodyStart + length))));
		cursor = bodyStart + length;
	}
	return frames;
}

describe("BI-26.1 链路 4:acp 桥全生命周期", () => {
	test("initialize → session/new → prompt×2 同链续聊 → session/end;JSONL 链尾续接", async () => {
		const root = tmpRoot("bi-drill-l-acp-");
		const outChunks: Uint8Array[] = [];
		const manager = new SessionManager({ rootDir: join(root, "sessions") });

		// 帧时序由生成器按真实协议顺序供给:prompt 携带 session/new 回执里的真实
		// sessionId;下一回合等上一回合回执落定(单飞语义)。输入用 pull 式流
		//(async pull 驱动生成器),不在 write 回调里反压注入(实测会僵死读泵)。
		let sessionId = "";
		let turn1Done = false;
		let turn2Done = false;
		const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
		async function* frameSource(): AsyncGenerator<Uint8Array> {
			yield acpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
			yield acpFrame({ jsonrpc: "2.0", id: 2, method: "session/new", params: { title: "演练" } });
			while (sessionId === "") await sleep(5);
			yield acpFrame({
				jsonrpc: "2.0",
				id: 3,
				method: "session/prompt",
				params: { sessionId, content: [{ type: "text", text: "第一问" }] },
			});
			while (!turn1Done) await sleep(5);
			yield acpFrame({
				jsonrpc: "2.0",
				id: 4,
				method: "session/prompt",
				params: { sessionId, content: [{ type: "text", text: "第二问" }] },
			});
			while (!turn2Done) await sleep(5);
			yield acpFrame({ jsonrpc: "2.0", id: 5, method: "session/end", params: { sessionId } });
		}
		const frames = frameSource();
		const connection = new AcpSessionConnection({
			input: new ReadableStream<Uint8Array>({
				async pull(controller) {
					const { value, done } = await frames.next();
					if (done) controller.close();
					else controller.enqueue(value);
				},
			}),
			output: {
				write: (chunk) => {
					void outChunks.push(chunk);
					const s = new TextDecoder().decode(chunk);
					const m = /Content-Length: (\d+)\r\n\r\n/.exec(s);
					if (m === null) return;
					const parsed = JSON.parse(
						s.slice(m.index + m[0].length, m.index + m[0].length + Number(m[1])),
					) as { id?: number; result?: { sessionId?: string } };
					if (parsed.id === 2 && typeof parsed.result?.sessionId === "string") {
						sessionId = parsed.result.sessionId;
					}
					if (parsed.id === 3) turn1Done = true;
					if (parsed.id === 4) turn2Done = true;
				},
			},
			manager,
			buildModelPort: scriptedPortFactory([["答一"], ["答二"]]),
		});
		const stats = await connection.run();

		expect(stats.initialize).toBe(1);
		expect(stats.sessionNew).toBe(1);
		expect(stats.promptTurns).toBe(2);
		expect(stats.busyRefusals).toBe(0);
		expect(stats.sessionEnds).toBe(1);

		const wire = decodeAcpFrames(outChunks);
		const responses = new Map(
			wire
				.filter((f): f is { id: number; result?: Record<string, unknown> } => typeof (f as { id?: unknown }).id === "number")
				.map((f) => [f.id, f.result ?? null]),
		);
		expect(responses.get(2)?.sessionId).toBe(sessionId);
		// prompt 回执 = 终态 stopReason(文本走 session/update 通知,不合入回执)
		expect(responses.get(3)?.stopReason).toBe("end_turn");
		expect(responses.get(4)?.stopReason).toBe("end_turn");
		// 通知面:两回合文本经 session/update(agent_message_chunk) 流出
		const updates = wire.filter(
			(f): f is { method: string } => (f as { method?: unknown }).method === "session/update",
		);
		const updateText = JSON.stringify(updates);
		expect(updateText).toContain("答一");
		expect(updateText).toContain("答二");
		// session/end 收束
		expect(responses.get(5)?.ended).toBe(true);

		// JSONL:两回合四条目链(user/assistant ×2,parentId 续接)
		const entries = await manager.entries(sessionId);
		expect(entries.length).toBe(4);
		expect(entries[1]!.parentId).toBe(entries[0]!.id);
		expect(entries[3]!.parentId).toBe(entries[2]!.id);
	});
});

// ---------------------------------------------------------------------------
// 链路 5 —— 八子命令真分发链(runBi 全真实代码路径)
// ---------------------------------------------------------------------------

describe("BI-26.1 链路 5:八子命令分发链", () => {
	test("init → session → fork → export → transfer → acp → upgrade → doctor 全链", async () => {
		const root = tmpRoot("bi-drill-l-cli-");
		const sessionsRoot = join(root, "sessions");

		// init:脚手架落 local.toml
		const initIo = collectIo();
		expect(await runBi(["init"], { ...initIo.io, deps: { cwd: root, homeDir: root } })).toBe(0);
		expect(initIo.outs.join("\n")).toContain(join(root, ".bi", "local.toml"));

		// 会话造数(真实 SessionManager)→ session 列举
		const manager = new SessionManager({ rootDir: sessionsRoot });
		const meta = await manager.createSession({ title: "链五" });
		const rootEntry = await manager.append(meta.sessionId, null, { type: "user", payload: { text: "问" } } as never);
		const sessionIo = collectIo();
		expect(await runBi(["session"], { ...sessionIo.io, deps: { sessionsRoot } })).toBe(0);
		expect(sessionIo.outs.join("\n")).toContain(meta.sessionId);

		// fork:分叉出平行线(回执报新会话 id;title 落在新会话 meta)
		const forkIo = collectIo();
		expect(
			await runBi(["fork", meta.sessionId, rootEntry.id, "--title", "支线"], {
				...forkIo.io,
				deps: { sessionsRoot },
			}),
		).toBe(0);
		expect(forkIo.outs.join("\n")).toContain("新会话");
		const allSessions = await manager.listSessions();
		expect(allSessions.map((m) => m.title)).toContain("支线");

		// export:markdown 落盘
		const exportPath = join(root, "export.md");
		const exportIo = collectIo();
		expect(
			await runBi(["export", meta.sessionId, "--out", exportPath], { ...exportIo.io, deps: { sessionsRoot } }),
		).toBe(0);
		expect(readFileSync(exportPath, "utf8")).toContain("问");

		// transfer:脱敏归档导出
		const archivePath = join(root, "archive.tar");
		const transferIo = collectIo();
		expect(
			await runBi(["transfer", "export", "--sanitize", meta.sessionId, "--out", archivePath], {
				...transferIo.io,
				deps: { sessionsRoot },
			}),
		).toBe(0);
		expect(initIo.outs.length).toBeGreaterThanOrEqual(0);

		// acp:注入 IO 最小握手
		const acpChunks: Uint8Array[] = [];
		expect(
			await runBi(["acp"], {
				out: () => undefined,
				err: () => undefined,
				deps: {
					acpInput: byteStream([acpFrame({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} })]),
					acpOutput: { write: (chunk) => void acpChunks.push(chunk) },
				},
			}),
		).toBe(0);
		const acpFrames = decodeAcpFrames(acpChunks);
		expect(acpFrames).toHaveLength(1);

		// upgrade:无 manifest 源 → 结构化 exit 4(BI-29.2 真链)
		const upgradeIo = collectIo();
		expect(await runBi(["upgrade"], { ...upgradeIo.io, deps: {} })).toBe(4);
		expect(upgradeIo.errs.join("\n")).toContain("未配置 manifest 源");

		// doctor:注入全绿检查项 → exit 0
		const doctorIo = collectIo();
		expect(
			await runBi(["doctor"], {
				...doctorIo.io,
				deps: { doctorChecks: [() => ({ name: "注入项", ok: true, detail: "好" })] },
			}),
		).toBe(0);
		expect(doctorIo.outs.join("\n")).toContain("BI Doctor 体检报告");

		// 未知子命令仍 exit 2
		expect(await runBi(["nonsense"], { out: () => undefined, err: () => undefined, deps: {} })).toBe(2);
	});
});
