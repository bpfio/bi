/**
 * BI-13.1 — Tool-on-Demand 动态按需加载器 (select_tools)
 *
 * 设计要点（工单 BI-13.1）：
 * - 初态仅向模型暴露 pinned 核心工具的全量 Schema + 其余工具的紧凑名录
 *   （name + 一句话描述，无 schema），以压降 System Prompt 中的工具开销
 *   （度量口径见 packages/core/src/tools/tool-activator.ts 文件头）。
 * - select(names)：按名激活全量 Schema（含所属 server 路由）；未知名返回
 *   结构化 unknown-tool（附编辑距离最近候选）；重复激活幂等。
 * - deactivate(name)：停用工具；pinned 工具不可停用。
 * - 激活计数与字节统计（usageStats / surfaceByteStats）供 BI-13.3 压缩器与
 *   core 侧 compressionStats() 消费。
 * - 服务器形态为结构类型（与已关单卡 McpClient.listTools 兼容），
 *   本文件不 import 具体客户端类，仅复用 protocol.ts 的结构化错误类型。
 */

import { McpError } from "./protocol";

// ---------- 注入形态（结构类型，不 import 具体类） ----------

/** 服务器侧工具定义（MCP listTools 结果的宽松子集）。 */
export interface RemoteToolDef {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

/** listTools 返回形态：兼容 MCP 标准 `{ tools: [...] }` 与裸数组。 */
export type ListToolsResult = { tools?: RemoteToolDef[] } | readonly RemoteToolDef[];

/** 注入的服务器形态 —— 与已关单卡 McpClient 结构兼容（结构类型，不 import 具体类）。 */
export interface ToolServerLike {
	name: string;
	listTools(): Promise<ListToolsResult>;
}

export interface ToolOnDemandRegistryOptions {
	servers: readonly ToolServerLike[];
	/** 核心工具白名单：初态即激活，不可停用。 */
	pinned?: readonly string[];
	/** 紧凑名录的一句话描述截断上限（字符），默认 120。 */
	compactDescriptionMaxChars?: number;
}

// ---------- 对外目录与结果 ----------

/** 工具目录条目（initialSurface 返回）。 */
export interface ToolCatalogEntry {
	name: string;
	description: string;
	/** 未激活的紧凑名录条目省略该字段（无 schema）。 */
	inputSchema?: unknown;
	activated: boolean;
}

/** select 激活成功的工具（全量 Schema + server 路由）。 */
export interface ActivatedTool {
	name: string;
	server: string;
	description: string;
	inputSchema: unknown;
}

/** 未知名的结构化拒绝。 */
export interface UnknownToolRefusal {
	kind: "unknown-tool";
	name: string;
	message: string;
	/** 目录中最接近的候选名（编辑距离启发式，至多 3 个）。 */
	suggestions: string[];
}

export interface SelectResult {
	activated: ActivatedTool[];
	alreadyActive: string[];
	unknown: UnknownToolRefusal[];
	stats: RegistryUsageStats;
}

export type DeactivateResult =
	| { deactivated: true; name: string }
	| { deactivated: false; name: string; reason: "pinned" | "unknown-tool" | "not-active" };

// ---------- 统计（供 BI-13.3 压缩器与 core compressionStats 消费） ----------

export interface SurfaceByteStats {
	/** 对照基线：全量工具以全 Schema 直出时的 UTF-8 字节数。 */
	baselineBytes: number;
	/** 初态表面字节数（pinned 全量 + 紧凑名录），装载后为快照常量。 */
	initialBytes: number;
	/** 当前表面字节数（已激活全量 + 未激活紧凑名录）。 */
	currentBytes: number;
}

export interface RegistryUsageStats {
	selectCalls: number;
	totalActivations: number;
	/** 每工具被 select 成功激活的次数（pinned 初态激活不计入）。 */
	activationCounts: Record<string, number>;
	activeTools: string[];
	pinnedTools: string[];
	catalogSize: number;
	/** pinned 中未命中目录的名字。 */
	unresolvedPinned: string[];
	bytes: SurfaceByteStats;
}

// ---------- 内部实现 ----------

interface CatalogRecord {
	name: string;
	server: string;
	description: string;
	inputSchema: unknown;
	pinned: boolean;
	activated: boolean;
	activationCount: number;
}

const DEFAULT_COMPACT_DESCRIPTION_MAX_CHARS = 120;
const MAX_SUGGESTIONS = 3;

const utf8Encoder = new TextEncoder();

/** UTF-8 字节数（度量口径统一按字节计）。 */
function byteLen(text: string): number {
	return utf8Encoder.encode(text).length;
}

/** 全量表面条目（对照基线与当前表面的已激活部分）。 */
function fullEntryBytes(record: CatalogRecord): number {
	return byteLen(
		JSON.stringify({ name: record.name, description: record.description, inputSchema: record.inputSchema }),
	);
}

/** 紧凑名录条目字节（无 schema）。 */
function compactEntryBytes(record: CatalogRecord, maxChars: number): number {
	return byteLen(
		JSON.stringify({ name: record.name, description: compactDescription(record.description, maxChars) }),
	);
}

/** 一句话描述：折叠全部空白为单空格，超长截断加省略号。 */
function compactDescription(raw: string, maxChars: number): string {
	const text = raw.replace(/\s+/g, " ").trim();
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}…`;
}

/** 兼容 `{ tools }` 与裸数组两种 listTools 返回形态。 */
function normalizeToolList(result: ListToolsResult): RemoteToolDef[] {
	if (Array.isArray(result)) {
		return [...result] as RemoteToolDef[];
	}
	const record = result as { tools?: RemoteToolDef[] };
	return Array.isArray(record.tools) ? [...record.tools] : [];
}

/** Levenshtein 编辑距离（目录规模小，O(mn) 足够）。 */
function editDistance(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	if (a.length === 0) {
		return b.length;
	}
	if (b.length === 0) {
		return a.length;
	}
	const unreachable = Number.MAX_SAFE_INTEGER;
	let previous: number[] = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) {
		previous[j] = j;
	}
	for (let i = 1; i <= a.length; i++) {
		const current: number[] = [i];
		for (let j = 1; j <= b.length; j++) {
			const above = previous[j] ?? unreachable;
			const aboveLeft = previous[j - 1] ?? unreachable;
			const left = current[j - 1] ?? unreachable;
			const substitution = aboveLeft + (a[i - 1] === b[j - 1] ? 0 : 1);
			current[j] = Math.min(above + 1, left + 1, substitution);
		}
		previous = current;
	}
	return previous[b.length] ?? unreachable;
}

/** 未知名的最近候选（编辑距离升序，距离相同按字典序，至多 3 个）。 */
function suggestionsFor(name: string, candidates: readonly string[]): string[] {
	return candidates
		.map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
		.sort((x, y) => x.distance - y.distance || x.candidate.localeCompare(y.candidate))
		.slice(0, MAX_SUGGESTIONS)
		.map((entry) => entry.candidate);
}

/** Tool-on-Demand 动态按需加载器。 */
export class ToolOnDemandRegistry {
	private readonly servers: readonly ToolServerLike[];
	private readonly pinnedNames: readonly string[];
	private readonly compactMaxChars: number;

	private catalog: CatalogRecord[] = [];
	private readonly byName = new Map<string, CatalogRecord>();
	private loadPromise: Promise<void> | null = null;
	private unresolvedPinned: string[] = [];

	private selectCalls = 0;
	private totalActivations = 0;
	private baselineBytes = 0;
	private initialBytes = 0;

	constructor(options: ToolOnDemandRegistryOptions) {
		if (!Array.isArray(options.servers)) {
			throw new McpError("invalid-state", "servers 必须为数组");
		}
		for (const server of options.servers) {
			const name = (server as Partial<ToolServerLike> | null)?.name;
			const listTools = (server as Partial<ToolServerLike> | null)?.listTools;
			if (typeof name !== "string" || name.length === 0 || typeof listTools !== "function") {
				throw new McpError(
					"invalid-state",
					`非法服务器形态（要求 { name: string, listTools(): Promise }）：${JSON.stringify(name ?? null)}`,
				);
			}
		}
		this.servers = options.servers;
		this.pinnedNames = options.pinned ?? [];
		this.compactMaxChars = Math.max(1, options.compactDescriptionMaxChars ?? DEFAULT_COMPACT_DESCRIPTION_MAX_CHARS);
	}

	/** 初态表面：pinned 全量 Schema + 其余工具紧凑名录（无 schema）。 */
	async initialSurface(): Promise<ToolCatalogEntry[]> {
		await this.ensureLoaded();
		return this.catalog.map((record) =>
			record.activated
				? { name: record.name, description: record.description, inputSchema: record.inputSchema, activated: true }
				: {
						name: record.name,
						description: compactDescription(record.description, this.compactMaxChars),
						activated: false,
					},
		);
	}

	/**
	 * 按名激活全量 Schema；未知名 → 结构化 unknown-tool；重复激活幂等
	 * （输入内重复名去重，跨调用重复激活进入 alreadyActive，不重复计数）。
	 */
	async select(names: readonly string[]): Promise<SelectResult> {
		if (!Array.isArray(names)) {
			throw new McpError("invalid-state", "names 必须为字符串数组");
		}
		for (const name of names) {
			if (typeof name !== "string") {
				throw new McpError("invalid-state", "names 含非字符串元素");
			}
		}
		await this.ensureLoaded();
		this.selectCalls++;
		const activated: ActivatedTool[] = [];
		const alreadyActive: string[] = [];
		const unknown: UnknownToolRefusal[] = [];
		const seen = new Set<string>();
		for (const name of names) {
			if (seen.has(name)) {
				continue;
			}
			seen.add(name);
			const record = this.byName.get(name);
			if (record === undefined) {
				unknown.push({
					kind: "unknown-tool",
					name,
					message: `工具 "${name}" 不在工具目录中，请从紧凑名录选择`,
					suggestions: suggestionsFor(
						name,
						this.catalog.map((entry) => entry.name),
					),
				});
				continue;
			}
			if (record.activated) {
				alreadyActive.push(name);
				continue;
			}
			record.activated = true;
			record.activationCount += 1;
			this.totalActivations += 1;
			activated.push(toActivatedTool(record));
		}
		return { activated, alreadyActive, unknown, stats: this.usageStats() };
	}

	/** 停用工具；pinned 不可停用。幂等：未激活工具返回 not-active。 */
	async deactivate(name: string): Promise<DeactivateResult> {
		if (typeof name !== "string" || name.length === 0) {
			throw new McpError("invalid-state", "name 必须为非空字符串");
		}
		await this.ensureLoaded();
		const record = this.byName.get(name);
		if (record === undefined) {
			return { deactivated: false, name, reason: "unknown-tool" };
		}
		if (record.pinned) {
			return { deactivated: false, name, reason: "pinned" };
		}
		if (!record.activated) {
			return { deactivated: false, name, reason: "not-active" };
		}
		record.activated = false;
		return { deactivated: true, name };
	}

	/** 当前激活集合（全量 Schema + server 路由），pinned 与激活顺序在目录序之前。 */
	async activeSurface(): Promise<ActivatedTool[]> {
		await this.ensureLoaded();
		return this.catalog.filter((record) => record.activated).map(toActivatedTool);
	}

	/** 用量与字节统计（目录装载完成后数据完整；装载前各项为零值）。 */
	usageStats(): RegistryUsageStats {
		const activationCounts: Record<string, number> = {};
		for (const record of this.catalog) {
			if (record.activationCount > 0) {
				activationCounts[record.name] = record.activationCount;
			}
		}
		return {
			selectCalls: this.selectCalls,
			totalActivations: this.totalActivations,
			activationCounts,
			activeTools: this.catalog.filter((record) => record.activated).map((record) => record.name),
			pinnedTools: this.catalog.filter((record) => record.pinned).map((record) => record.name),
			catalogSize: this.catalog.length,
			unresolvedPinned: [...this.unresolvedPinned],
			bytes: this.surfaceByteStats(),
		};
	}

	/** 字节统计（core 侧 compressionStats 的底座）。 */
	surfaceByteStats(): SurfaceByteStats {
		let currentBytes = 0;
		for (const record of this.catalog) {
			currentBytes += record.activated
				? fullEntryBytes(record)
				: compactEntryBytes(record, this.compactMaxChars);
		}
		return { baselineBytes: this.baselineBytes, initialBytes: this.initialBytes, currentBytes };
	}

	/** 懒装载（并发安全：共享同一次装载 promise）。 */
	private ensureLoaded(): Promise<void> {
		if (this.loadPromise === null) {
			this.loadPromise = this.loadCatalog();
		}
		return this.loadPromise;
	}

	private async loadCatalog(): Promise<void> {
		const perServer = await Promise.all(
			this.servers.map(async (server) => {
				let tools: RemoteToolDef[];
				try {
					tools = normalizeToolList(await server.listTools());
				} catch (cause) {
					throw new McpError("connect-failed", `服务器 "${server.name}" 枚举工具失败`, {
						cause: String(cause),
					});
				}
				return { serverName: server.name, tools };
			}),
		);

		const catalog: CatalogRecord[] = [];
		const seen = new Set<string>();
		const bareOwner = new Map<string, string>();
		for (const { serverName, tools } of perServer) {
			for (const tool of tools) {
				if (typeof tool?.name !== "string" || tool.name.length === 0) {
					continue;
				}
				let name = tool.name;
				const owner = bareOwner.get(tool.name);
				if (owner === undefined) {
					bareOwner.set(tool.name, serverName);
				} else if (owner === serverName) {
					continue; // 同服务器重复工具名：后者忽略
				} else {
					// 跨服务器撞名：加 `server__tool` 后缀消歧，仍撞则追加下划线兜底
					name = `${serverName}__${tool.name}`;
					while (seen.has(name)) {
						name = `${name}_`;
					}
				}
				seen.add(name);
				catalog.push({
					name,
					server: serverName,
					description: typeof tool.description === "string" ? tool.description : "",
					inputSchema: tool.inputSchema,
					pinned: false,
					activated: false,
					activationCount: 0,
				});
			}
		}

		const unresolved: string[] = [];
		for (const pinned of this.pinnedNames) {
			const record = catalog.find((entry) => entry.name === pinned);
			if (record === undefined) {
				unresolved.push(pinned);
				continue;
			}
			record.pinned = true;
			record.activated = true;
		}
		this.unresolvedPinned = unresolved;
		this.catalog = catalog;
		this.byName.clear();
		for (const record of catalog) {
			this.byName.set(record.name, record);
		}
		this.computeBytes();
	}

	private computeBytes(): void {
		let baseline = 0;
		let initial = 0;
		for (const record of this.catalog) {
			baseline += fullEntryBytes(record);
			initial += record.activated
				? fullEntryBytes(record)
				: compactEntryBytes(record, this.compactMaxChars);
		}
		this.baselineBytes = baseline;
		this.initialBytes = initial;
	}
}

function toActivatedTool(record: CatalogRecord): ActivatedTool {
	return {
		name: record.name,
		server: record.server,
		description: record.description,
		inputSchema: record.inputSchema,
	};
}
