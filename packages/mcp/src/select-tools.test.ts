import { describe, expect, test } from "bun:test";
import { McpClient } from "./client";
import type { JsonRpcMessage, McpErrorCode, McpTransport, TransportCloseEvent } from "./protocol";
import { McpError, jsonRpcError, jsonRpcResponse } from "./protocol";
import { ToolOnDemandRegistry, type RemoteToolDef, type ToolServerLike } from "./select-tools";
// 跨包测试冒烟（仅测试）：core 侧 select_tools 处理器与真实 registry 的鸭子类型组合
import { createToolActivator } from "../../core/src/tools/tool-activator";

// ---------- 测试基建 ----------

/** 本地独立字节计数（用于验证 registry 统计口径，Buffer 按 UTF-8 计）。 */
function byteLen(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function stubServer(name: string, tools: RemoteToolDef[], calls?: { count: number }): ToolServerLike {
	return {
		name,
		async listTools() {
			if (calls !== undefined) {
				calls.count += 1;
			}
			return { tools };
		},
	};
}

function tool(name: string, description: string, inputSchema: unknown = { type: "object" }): RemoteToolDef {
	return { name, description, inputSchema };
}

/** 撑大体积的 Schema（每属性约 100+ 字节）。 */
function bigSchema(propCount: number): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	for (let index = 0; index < propCount; index++) {
		properties[`property_${index}_with_reasonably_long_name`] = {
			type: "string",
			description: "属性描述文本用于撑大 Schema 体积以便验证压缩口径",
		};
	}
	return { type: "object", properties, required: Object.keys(properties) };
}

async function expectMcpError(promise: Promise<unknown>, code: McpErrorCode): Promise<McpError> {
	try {
		await promise;
	} catch (error) {
		if (!(error instanceof McpError)) {
			throw error;
		}
		expect(error.code).toBe(code);
		return error;
	}
	throw new Error(`期望 McpError(${code})，但成功返回`);
}

/** 内存 stub 传输：按方法名脚本化应答（供真 McpClient 组合冒烟）。 */
class StubMcpTransport implements McpTransport {
	readonly sent: JsonRpcMessage[] = [];
	private readonly callbacks: Array<(message: JsonRpcMessage) => void> = [];

	constructor(private readonly responders: Record<string, () => unknown>) {}

	async start(): Promise<void> {}

	async send(message: JsonRpcMessage): Promise<void> {
		this.sent.push(message);
		if ("method" in message && "id" in message) {
			const responder = this.responders[message.method];
			if (responder === undefined) {
				this.emit(jsonRpcError(message.id, -32601, `no handler: ${message.method}`));
				return;
			}
			this.emit(jsonRpcResponse(message.id, responder()));
		}
	}

	onMessage(callback: (message: JsonRpcMessage) => void): void {
		this.callbacks.push(callback);
	}

	onClose(_callback: (event: TransportCloseEvent) => void): void {}

	async close(): Promise<void> {}

	/** 某方法发出的请求数（装载次数断言用）。 */
	requestCount(method: string): number {
		return this.sent.filter((message) => "method" in message && message.method === method).length;
	}

	private emit(message: JsonRpcMessage): void {
		for (const callback of this.callbacks) {
			callback(message);
		}
	}
}

// ---------- 初态表面 ----------

describe("ToolOnDemandRegistry 初态表面", () => {
	const servers = [
		stubServer("fs", [
			tool("fs.read", "读取文件内容", { type: "object", properties: { path: { type: "string" } } }),
			tool("fs.write", "写入文件内容\n支持多行描述文本，会被折叠为一句话", { type: "object" }),
		]),
	];
	const pinned = ["fs.read"];

	test("pinned 工具初态激活且携带全量 Schema", async () => {
		const registry = new ToolOnDemandRegistry({ servers, pinned });
		const surface = await registry.initialSurface();
		const read = surface.find((entry) => entry.name === "fs.read");
		expect(read?.activated).toBe(true);
		expect(read?.inputSchema).toEqual({ type: "object", properties: { path: { type: "string" } } });
	});

	test("非 pinned 工具为紧凑名录：activated=false 且无 inputSchema 字段", async () => {
		const registry = new ToolOnDemandRegistry({ servers, pinned });
		const surface = await registry.initialSurface();
		const write = surface.find((entry) => entry.name === "fs.write");
		expect(write?.activated).toBe(false);
		expect(write && Object.hasOwn(write, "inputSchema")).toBe(false);
	});

	test("紧凑描述折叠空白换行并超长截断（默认 120 字符 + 省略号）", async () => {
		const longText = `第一段。${"很长的描述".repeat(40)}`;
		const registry = new ToolOnDemandRegistry({
			servers: [stubServer("s", [tool("s.a", `多行\n描述\t文本 ${longText}`)])],
		});
		const entry = (await registry.initialSurface())[0];
		expect(entry?.description.startsWith("多行 描述 文本 第一段。")).toBe(true);
		expect(entry?.description.length).toBe(121);
		expect(entry?.description.endsWith("…")).toBe(true);
	});

	test("pinned 未命中目录：surface 正常返回且 unresolvedPinned 记录", async () => {
		const registry = new ToolOnDemandRegistry({ servers, pinned: ["fs.read", "ghost.tool"] });
		const surface = await registry.initialSurface();
		expect(surface.length).toBe(2);
		expect(registry.usageStats().unresolvedPinned).toEqual(["ghost.tool"]);
	});
});

// ---------- select ----------

describe("ToolOnDemandRegistry select", () => {
	function makeRegistry() {
		return new ToolOnDemandRegistry({
			servers: [
				stubServer("fs", [tool("fs.read", "读", { type: "object" }), tool("fs.write", "写", { type: "object" })]),
				stubServer("git", [tool("git.status", "状态", { type: "object", properties: { deep: { type: "boolean" } } })]),
			],
			pinned: ["fs.read"],
		});
	}

	test("按名激活：返回全量 Schema 与所属 server 路由", async () => {
		const registry = makeRegistry();
		const result = await registry.select(["git.status"]);
		expect(result.unknown).toEqual([]);
		expect(result.activated.length).toBe(1);
		expect(result.activated[0]?.name).toBe("git.status");
		expect(result.activated[0]?.server).toBe("git");
		expect(result.activated[0]?.inputSchema).toEqual({ type: "object", properties: { deep: { type: "boolean" } } });
	});

	test("跨 server 路由正确：同批激活多 server 工具各归其主", async () => {
		const registry = makeRegistry();
		const result = await registry.select(["fs.write", "git.status"]);
		const owners = Object.fromEntries(result.activated.map((entry) => [entry.name, entry.server]));
		expect(owners).toEqual({ "fs.write": "fs", "git.status": "git" });
	});

	test("未知名：结构化 unknown-tool，附最近候选 suggestions", async () => {
		const registry = makeRegistry();
		const result = await registry.select(["fs.reda"]);
		expect(result.activated).toEqual([]);
		expect(result.unknown.length).toBe(1);
		expect(result.unknown[0]?.kind).toBe("unknown-tool");
		expect(result.unknown[0]?.name).toBe("fs.reda");
		expect(result.unknown[0]?.suggestions[0]).toBe("fs.read");
	});

	test("重复激活幂等：第二次进入 alreadyActive，activated 为空", async () => {
		const registry = makeRegistry();
		const first = await registry.select(["fs.write"]);
		const second = await registry.select(["fs.write"]);
		expect(first.activated.length).toBe(1);
		expect(second.activated).toEqual([]);
		expect(second.alreadyActive).toEqual(["fs.write"]);
		expect(registry.usageStats().activationCounts["fs.write"]).toBe(1);
	});

	test("输入内重复名去重：只激活一次", async () => {
		const registry = makeRegistry();
		const result = await registry.select(["fs.write", "fs.write", "fs.write"]);
		expect(result.activated.length).toBe(1);
		expect(result.alreadyActive).toEqual([]);
	});

	test("pinned 工具再次 select：alreadyActive（初态即激活）", async () => {
		const registry = makeRegistry();
		const result = await registry.select(["fs.read"]);
		expect(result.activated).toEqual([]);
		expect(result.alreadyActive).toEqual(["fs.read"]);
	});

	test("非法输入：names 非数组或含非字符串 → invalid-state 结构化错误", async () => {
		const registry = makeRegistry();
		await expectMcpError(
			registry.select("fs.write" as unknown as string[]),
			"invalid-state",
		);
		await expectMcpError(
			registry.select([123 as unknown as string]),
			"invalid-state",
		);
	});

	test("selectCalls 计数随调用递增（失败名也计入调用次数）", async () => {
		const registry = makeRegistry();
		await registry.select(["fs.write"]);
		await registry.select(["nope"]);
		const stats = registry.usageStats();
		expect(stats.selectCalls).toBe(2);
		expect(stats.totalActivations).toBe(1);
	});
});

// ---------- deactivate ----------

describe("ToolOnDemandRegistry deactivate", () => {
	function makeActivatedRegistry() {
		const registry = new ToolOnDemandRegistry({
			servers: [stubServer("fs", [tool("fs.read", "读"), tool("fs.write", "写")])],
			pinned: ["fs.read"],
		});
		return registry;
	}

	test("非 pinned 激活工具：停用成功并移出激活面", async () => {
		const registry = makeActivatedRegistry();
		await registry.select(["fs.write"]);
		const result = await registry.deactivate("fs.write");
		expect(result).toEqual({ deactivated: true, name: "fs.write" });
		const active = await registry.activeSurface();
		expect(active.map((entry) => entry.name)).toEqual(["fs.read"]);
	});

	test("pinned 工具拒绝停用：reason=pinned 且仍在激活面", async () => {
		const registry = makeActivatedRegistry();
		const result = await registry.deactivate("fs.read");
		expect(result).toEqual({ deactivated: false, name: "fs.read", reason: "pinned" });
		const active = await registry.activeSurface();
		expect(active.map((entry) => entry.name)).toEqual(["fs.read"]);
	});

	test("未知名与未激活名：结构化 reason 拒绝", async () => {
		const registry = makeActivatedRegistry();
		expect(await registry.deactivate("nope")).toEqual({
			deactivated: false,
			name: "nope",
			reason: "unknown-tool",
		});
		expect(await registry.deactivate("fs.write")).toEqual({
			deactivated: false,
			name: "fs.write",
			reason: "not-active",
		});
	});

	test("非法 name：空字符串 → invalid-state", async () => {
		const registry = makeActivatedRegistry();
		await expectMcpError(registry.deactivate(""), "invalid-state");
	});
});

// ---------- 目录与路由 ----------

describe("ToolOnDemandRegistry 目录装载", () => {
	test("跨 server 工具撞名：后到者加 server__tool 后缀消歧", async () => {
		const registry = new ToolOnDemandRegistry({
			servers: [
				stubServer("a", [tool("search", "A 的搜索")]),
				stubServer("b", [tool("search", "B 的搜索")]),
			],
		});
		const surface = await registry.initialSurface();
		const names = surface.map((entry) => entry.name).sort();
		// 首到者（a）保留裸名，后到者（b）加 server__tool 后缀
		expect(names).toEqual(["b__search", "search"]);
		const result = await registry.select(["b__search"]);
		expect(result.activated[0]?.server).toBe("b");
	});

	test("listTools 裸数组形态兼容", async () => {
		const registry = new ToolOnDemandRegistry({
			servers: [{ name: "bare", listTools: async () => [tool("bare.t", "裸数组")] }],
		});
		const surface = await registry.initialSurface();
		expect(surface.map((entry) => entry.name)).toEqual(["bare.t"]);
	});

	test("listTools 失败：connect-failed 结构化错误并携带 server 名", async () => {
		const registry = new ToolOnDemandRegistry({
			servers: [
				{
					name: "broken",
					listTools: () => Promise.reject(new Error("boom")),
				},
			],
		});
		const error = await expectMcpError(registry.initialSurface(), "connect-failed");
		expect(error.message).toContain("broken");
	});

	test("构造校验：server 缺 listTools → invalid-state", () => {
		expect(
			() =>
				new ToolOnDemandRegistry({
					servers: [{ name: "bad" } as unknown as ToolServerLike],
				}),
		).toThrow(McpError);
	});

	test("并发 initialSurface/select 共享同一次装载（listTools 仅调用一次）", async () => {
		const calls = { count: 0 };
		const registry = new ToolOnDemandRegistry({
			servers: [stubServer("fs", [tool("fs.read", "读")], calls)],
		});
		const [surfaceA, surfaceB] = await Promise.all([
			registry.initialSurface(),
			registry.select(["fs.read"]).then(() => registry.initialSurface()),
		]);
		expect(surfaceA.length).toBe(1);
		expect(surfaceB.length).toBe(1);
		expect(calls.count).toBe(1);
	});
});

// ---------- 字节统计（压缩口径） ----------

describe("ToolOnDemandRegistry 字节统计", () => {
	test("baseline/initial/current 与本地独立计算一致（含 CJK UTF-8 字节）", async () => {
		const registry = new ToolOnDemandRegistry({
			servers: [
				stubServer("s", [
					tool("s.t1", "工具", { type: "object" }),
					tool("s.t2", "d2", { type: "string" }),
				]),
			],
			pinned: ["s.t1"],
		});
		await registry.initialSurface();
		const bytes = registry.surfaceByteStats();
		const full1 = byteLen(JSON.stringify({ name: "s.t1", description: "工具", inputSchema: { type: "object" } }));
		const full2 = byteLen(JSON.stringify({ name: "s.t2", description: "d2", inputSchema: { type: "string" } }));
		const compact2 = byteLen(JSON.stringify({ name: "s.t2", description: "d2" }));
		expect(bytes.baselineBytes).toBe(full1 + full2);
		expect(bytes.initialBytes).toBe(full1 + compact2);
		// CJK 按字节计：initial 严格小于 baseline
		expect(bytes.initialBytes).toBeLessThan(bytes.baselineBytes);
	});

	test("initialBytes 为装载快照：激活/停用不改变，currentBytes 随激活面伸缩", async () => {
		const registry = new ToolOnDemandRegistry({
			servers: [stubServer("s", [tool("s.t1", "读"), tool("s.t2", "写", bigSchema(8))])],
			pinned: ["s.t1"],
		});
		await registry.initialSurface();
		const initial = registry.surfaceByteStats();
		await registry.select(["s.t2"]);
		const activated = registry.surfaceByteStats();
		expect(activated.initialBytes).toBe(initial.initialBytes);
		expect(activated.currentBytes).toBeGreaterThan(initial.currentBytes);
		expect(activated.currentBytes).toBe(activated.baselineBytes);
		await registry.deactivate("s.t2");
		expect(registry.surfaceByteStats().currentBytes).toBe(initial.currentBytes);
	});

	test("压降达标场景：1 pinned 小工具 + 19 个大 Schema 工具 → 压降 ≥ 80%", async () => {
		const tools = [tool("core.run", "核心工具", { type: "object" })];
		for (let index = 0; index < 19; index++) {
			tools.push(tool(`plugin.fn${index}`, `插件功能 ${index}`, bigSchema(20)));
		}
		const registry = new ToolOnDemandRegistry({
			servers: [stubServer("mix", tools)],
			pinned: ["core.run"],
		});
		await registry.initialSurface(); // 懒装载：统计口径以目录装载完成后的快照为准
		const bytes = registry.surfaceByteStats();
		const reduction = 1 - bytes.initialBytes / bytes.baselineBytes;
		expect(reduction).toBeGreaterThanOrEqual(0.8);
	});
});

// ---------- 与 McpClient 组合冒烟（内存 stub） ----------

describe("ToolOnDemandRegistry 与 McpClient 组合冒烟", () => {
	function connectedClient(tools: RemoteToolDef[]): McpClient {
		const transport = new StubMcpTransport({
			initialize: () => ({
				protocolVersion: "2025-06-18",
				capabilities: {},
				serverInfo: { name: "stub-fs", version: "0.1.0" },
			}),
			"tools/list": () => ({ tools }),
		});
		const client = new McpClient(transport);
		return client;
	}

	test("真 McpClient.listTools 注入 registry：初态 → 激活 → 激活面全链路", async () => {
		const client = connectedClient([
			tool("fs.read", "读文件", { type: "object", properties: { path: { type: "string" } } }),
			tool("fs.write", "写文件", { type: "object" }),
		]);
		await client.initialize();
		const registry = new ToolOnDemandRegistry({
			servers: [{ name: "fs", listTools: () => client.listTools() }],
			pinned: ["fs.read"],
		});
		const surface = await registry.initialSurface();
		expect(surface.length).toBe(2);
		expect(surface.find((entry) => entry.name === "fs.read")?.activated).toBe(true);

		const result = await registry.select(["fs.write"]);
		expect(result.activated[0]?.server).toBe("fs");
		const active = await registry.activeSurface();
		expect(active.map((entry) => entry.name).sort()).toEqual(["fs.read", "fs.write"]);
	});

	test("跨包冒烟：registry + core createToolActivator 全链路（激活 + 压缩统计达标）", async () => {
		const tools = [tool("core.run", "核心工具", { type: "object" })];
		for (let index = 0; index < 19; index++) {
			tools.push(tool(`plugin.fn${index}`, `插件功能 ${index}`, bigSchema(20)));
		}
		const client = connectedClient(tools);
		await client.initialize();
		const registry = new ToolOnDemandRegistry({
			servers: [{ name: "mix", listTools: () => client.listTools() }],
			pinned: ["core.run"],
		});
		const activator = createToolActivator(registry);
		expect(activator.tool.name).toBe("select_tools");

		const outcome = await activator.handle({ names: ["plugin.fn0", "plugin.fn1"] });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		expect(outcome.result.activated.length).toBe(2);
		expect(outcome.result.activated[0]?.server).toBe("mix");
		expect(outcome.result.summary).toContain("已激活 2 个工具");

		const stats = activator.compressionStats();
		expect(stats.reductionPercent).toBeGreaterThanOrEqual(80);
		expect(stats.meetsTarget).toBe(true);
		// 激活后当前表面压降回落但仍应为正
		expect(stats.currentReductionPercent).toBeGreaterThan(0);
		expect(stats.currentReductionPercent).toBeLessThan(stats.reductionPercent);
	});
});
