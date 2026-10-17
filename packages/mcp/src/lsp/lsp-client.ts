/**
 * @bi/mcp —— LSP 符号级导航客户端（BI-13.2）。
 *
 * LspClient 持有 LspStdioTransport：connect() 编排 initialize/initialized
 * 握手与能力协商（positionEncoding 缺省 utf-16），四大导航操作映射 LSP 方法：
 * - goToDefinition    → textDocument/definition
 * - findReferences    → textDocument/references
 * - goToImplementation → textDocument/implementation
 * - hover             → textDocument/hover
 *
 * 输出保护：maxLocations=100（超限截断并携带 omittedLocations），
 * maxResultChars=16000（渲染文本按 UTF-16 码元截断并标记 truncated）。
 * 位置渲染按文件分组、文件内按行列升序，显示为 1 基行列。
 * 服务器未声明对应能力（definitionProvider 等）时抛 capability-unsupported。
 */
import type { LspCloseEvent, LspErrorCode } from "./lsp-stdio-transport";
import { LspError, LspStdioTransport } from "./lsp-stdio-transport";

// ---------- 位置与 URI ----------

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

/** 文件路径 → file:// URI（已是 URI 则原样返回；空格转义为 %20）。 */
export function pathToUri(path: string): string {
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
		return path;
	}
	return `file://${encodeURI(path)}`;
}

/** file:// URI → 文件路径（非 file scheme 原样返回）。 */
export function uriToPath(uri: string): string {
	if (!uri.startsWith("file://")) {
		return uri;
	}
	let rest = uri.slice("file://".length);
	const slash = rest.indexOf("/");
	if (slash > 0) {
		rest = rest.slice(slash); // 剥离 authority（如 localhost）
	}
	try {
		rest = decodeURIComponent(rest);
	} catch {
		// 非法百分号序列：按原文返回
	}
	return rest;
}

// ---------- 归一化结果 ----------

/** 归一化后的位置（0 基行列，渲染层转 1 基）。 */
export interface NormalizedLocation {
	uri: string;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

export type LspNavigationOperation = "goToDefinition" | "findReferences" | "goToImplementation";

export interface LspNavigationResult {
	operation: LspNavigationOperation;
	locations: NormalizedLocation[];
	/** 截断前总数。 */
	totalLocations: number;
	/** 因 maxLocations 被省略的数量。 */
	omittedLocations: number;
	truncated: boolean;
	/** 按文件分组的渲染文本（≤ maxResultChars）。 */
	rendered: string;
}

export interface LspHoverResult {
	operation: "hover";
	/** 服务器是否返回了 Hover 信息。 */
	found: boolean;
	contents: string;
	/** MarkedString 的语言标注（若有）。 */
	language?: string;
	/** MarkupContent 的 kind（markdown/plaintext，若有）。 */
	markupKind?: string;
	range?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
	truncated: boolean;
	/** 渲染文本（≤ maxResultChars）。 */
	rendered: string;
}

// ---------- 客户端 ----------

export type LspPositionEncoding = "utf-8" | "utf-16" | "utf-32";

export interface LspWorkspaceFolder {
	uri: string;
	name?: string;
}

export interface LspClientOptions {
	/** 服务器可执行命令。与 transport 注入二选一。 */
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	/** 测试注入：使用既有传输（调用方自行 start()），跳过 spawn。 */
	transport?: LspStdioTransport;
	rootUri?: string;
	rootPath?: string;
	workspaceFolders?: LspWorkspaceFolder[];
	/** 常规请求超时毫秒，默认 30000。 */
	requestTimeoutMs?: number;
	/** close() 中 shutdown 的超时毫秒，默认 2000（避免卡死关闭）。 */
	closeTimeoutMs?: number;
	/** 客户端名称与版本。 */
	clientInfo?: { name: string; version: string };
	/** 单次导航返回的位置上限，默认 100。 */
	maxLocations?: number;
	/** 渲染文本上限（UTF-16 码元），默认 16000。 */
	maxResultChars?: number;
}

export interface LspInitializeInfo {
	serverName?: string;
	serverVersion?: string;
	capabilities: Record<string, unknown>;
	positionEncoding: LspPositionEncoding;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_LOCATIONS = 100;
const DEFAULT_MAX_RESULT_CHARS = 16_000;
const DEFAULT_CLIENT_INFO = { name: "@bi/lsp-client", version: "0.1.0" };

const VALID_POSITION_ENCODINGS: ReadonlySet<string> = new Set(["utf-8", "utf-16", "utf-32"]);

type ClientState = "idle" | "ready" | "closed";

interface RawLspLocationLike {
	uri?: unknown;
	range?: unknown;
	targetUri?: unknown;
	targetSelectionRange?: unknown;
	targetRange?: unknown;
}

function isLspRange(value: unknown): value is LspRange {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	const start = record["start"];
	const end = record["end"];
	return (
		typeof start === "object" &&
		start !== null &&
		typeof (start as Record<string, unknown>)["line"] === "number" &&
		typeof (start as Record<string, unknown>)["character"] === "number" &&
		typeof end === "object" &&
		end !== null &&
		typeof (end as Record<string, unknown>)["line"] === "number" &&
		typeof (end as Record<string, unknown>)["character"] === "number"
	);
}

/** Location / LocationLink → 归一化 Location；缺 uri/range 的畸形条目跳过。 */
function normalizeLocationEntry(entry: unknown): NormalizedLocation | null {
	if (typeof entry !== "object" || entry === null) {
		return null;
	}
	const record = entry as RawLspLocationLike;
	if (typeof record["uri"] === "string" && isLspRange(record["range"])) {
		const range = record["range"];
		return {
			uri: record["uri"],
			startLine: range.start.line,
			startCharacter: range.start.character,
			endLine: range.end.line,
			endCharacter: range.end.character,
		};
	}
	if (typeof record["targetUri"] === "string") {
		const range = isLspRange(record["targetSelectionRange"])
			? record["targetSelectionRange"]
			: isLspRange(record["targetRange"])
				? record["targetRange"]
				: null;
		if (range !== null) {
			return {
				uri: record["targetUri"],
				startLine: range.start.line,
				startCharacter: range.start.character,
				endLine: range.end.line,
				endCharacter: range.end.character,
			};
		}
	}
	return null;
}

/** definition/implementation/references 的返回形态归一：Location | LocationLink | 数组 | null → Location[]。 */
export function normalizeLocations(raw: unknown): NormalizedLocation[] {
	if (raw === null || raw === undefined) {
		return [];
	}
	const entries = Array.isArray(raw) ? raw : [raw];
	const result: NormalizedLocation[] = [];
	for (const entry of entries) {
		const normalized = normalizeLocationEntry(entry);
		if (normalized !== null) {
			result.push(normalized);
		}
	}
	return result;
}

/** 按文件分组渲染（文件名字典序、组内按行列升序），1 基行列。 */
export function renderLocationGroups(locations: readonly NormalizedLocation[]): string {
	const groups = new Map<string, NormalizedLocation[]>();
	for (const location of locations) {
		const group = groups.get(location.uri);
		if (group !== undefined) {
			group.push(location);
		} else {
			groups.set(location.uri, [location]);
		}
	}
	const lines: string[] = [];
	for (const uri of [...groups.keys()].sort()) {
		const group = groups.get(uri);
		if (group === undefined) {
			continue;
		}
		group.sort(
			(a, b) => a.startLine - b.startLine || a.startCharacter - b.startCharacter,
		);
		lines.push(uriToPath(uri));
		for (const location of group) {
			lines.push(
				`  L${location.startLine + 1}:${location.startCharacter + 1}-L${location.endLine + 1}:${location.endCharacter + 1}`,
			);
		}
	}
	return lines.join("\n");
}

interface RawHoverContents {
	markupKind?: string;
	language?: string;
	value: string;
}

function normalizeHoverContents(raw: unknown): RawHoverContents {
	if (typeof raw === "string") {
		return { value: raw };
	}
	if (Array.isArray(raw)) {
		const parts: string[] = [];
		let language: string | undefined;
		let markupKind: string | undefined;
		for (const item of raw) {
			const part = normalizeHoverContents(item);
			parts.push(part.value);
			if (language === undefined && part.language !== undefined) {
				language = part.language;
			}
			if (markupKind === undefined && part.markupKind !== undefined) {
				markupKind = part.markupKind;
			}
		}
		return { value: parts.join("\n\n"), language, markupKind };
	}
	if (typeof raw === "object" && raw !== null) {
		const record = raw as Record<string, unknown>;
		if (typeof record["value"] === "string") {
			if (typeof record["language"] === "string") {
				return { value: record["value"], language: record["language"] };
			}
			if (typeof record["kind"] === "string") {
				return { value: record["value"], markupKind: record["kind"] };
			}
			return { value: record["value"] };
		}
	}
	return { value: "" };
}

/** LSP 符号级导航客户端。 */
export class LspClient {
	private readonly options: LspClientOptions;
	private readonly ownedTransport: LspStdioTransport | null;
	private readonly transport: LspStdioTransport;
	private readonly requestTimeoutMs: number;
	private readonly closeTimeoutMs: number;
	private readonly maxLocations: number;
	private readonly maxResultChars: number;

	private state: ClientState = "idle";
	private capabilities: Record<string, unknown> = {};
	private positionEncoding: LspPositionEncoding = "utf-16";
	private initializeInfo: LspInitializeInfo | null = null;

	constructor(options: LspClientOptions) {
		this.options = options;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
		this.maxLocations = options.maxLocations ?? DEFAULT_MAX_LOCATIONS;
		this.maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
		if (options.transport !== undefined) {
			this.ownedTransport = null;
			this.transport = options.transport;
		} else {
			if (typeof options.command !== "string" || options.command.length === 0) {
				throw new LspError("invalid-state", "LspClient 需要 command 或注入 transport");
			}
			this.ownedTransport = new LspStdioTransport({
				command: options.command,
				args: options.args,
				cwd: options.cwd,
				env: options.env,
				requestTimeoutMs: this.requestTimeoutMs,
			});
			this.transport = this.ownedTransport;
		}
	}

	/** initialize 握手 + 能力协商；成功后进入 ready 态。 */
	async connect(): Promise<LspInitializeInfo> {
		if (this.state !== "idle") {
			throw new LspError("invalid-state", `connect() 只能调用一次（当前态: ${this.state}）`);
		}
		if (this.ownedTransport !== null) {
			await this.ownedTransport.start();
		}
		const params: Record<string, unknown> = {
			processId: typeof process !== "undefined" ? process.pid : null,
			capabilities: {},
			clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
		};
		if (this.options.rootUri !== undefined) {
			params["rootUri"] = this.options.rootUri;
		}
		if (this.options.rootPath !== undefined) {
			params["rootPath"] = this.options.rootPath;
		}
		if (this.options.workspaceFolders !== undefined) {
			params["workspaceFolders"] = this.options.workspaceFolders;
		}
		const raw = await this.transport.request("initialize", params, {
			timeoutMs: this.requestTimeoutMs,
		});
		if (typeof raw !== "object" || raw === null) {
			throw new LspError("protocol-error", "initialize 结果不是对象");
		}
		const record = raw as Record<string, unknown>;
		this.capabilities =
			typeof record["capabilities"] === "object" && record["capabilities"] !== null
				? (record["capabilities"] as Record<string, unknown>)
				: {};
		this.positionEncoding = resolvePositionEncoding(this.capabilities);
		const serverInfo =
			typeof record["serverInfo"] === "object" && record["serverInfo"] !== null
				? (record["serverInfo"] as Record<string, unknown>)
				: undefined;
		this.initializeInfo = {
			serverName: typeof serverInfo?.["name"] === "string" ? serverInfo["name"] : undefined,
			serverVersion: typeof serverInfo?.["version"] === "string" ? serverInfo["version"] : undefined,
			capabilities: this.capabilities,
			positionEncoding: this.positionEncoding,
		};
		await this.transport.notify("initialized", {});
		this.state = "ready";
		return this.initializeInfo;
	}

	/** 服务器能力快照（connect 后有效）。 */
	getServerCapabilities(): Record<string, unknown> {
		return this.capabilities;
	}

	/** 协商出的位置编码（缺省 utf-16）。 */
	getPositionEncoding(): LspPositionEncoding {
		return this.positionEncoding;
	}

	/** connect 返回的握手信息（观测用）。 */
	getInitializeInfo(): LspInitializeInfo | null {
		return this.initializeInfo;
	}

	/** 关闭：shutdown（尽力而为，超时不阻塞）→ exit 通知 → 传输关闭。幂等。 */
	async close(): Promise<void> {
		if (this.state === "closed") {
			return;
		}
		const wasReady = this.state === "ready";
		this.state = "closed";
		if (wasReady) {
			try {
				await this.transport.request("shutdown", undefined, { timeoutMs: this.closeTimeoutMs });
			} catch {
				// shutdown 失败不阻塞退出
			}
			try {
				await this.transport.notify("exit");
			} catch {
				// 同上
			}
		}
		await this.transport.close();
	}

	/** 注册传输关闭事件（透传底层终态）。 */
	onClose(callback: (event: LspCloseEvent) => void): void {
		this.transport.onClose(callback);
	}

	/** 跳转到定义。 */
	async goToDefinition(filePath: string, line: number, character: number): Promise<LspNavigationResult> {
		return this.navigate("goToDefinition", "textDocument/definition", "definitionProvider", filePath, line, character);
	}

	/** 查找引用（默认包含声明本身）。 */
	async findReferences(
		filePath: string,
		line: number,
		character: number,
		opts?: { includeDeclaration?: boolean },
	): Promise<LspNavigationResult> {
		return this.navigate(
			"findReferences",
			"textDocument/references",
			"referencesProvider",
			filePath,
			line,
			character,
			{ context: { includeDeclaration: opts?.includeDeclaration ?? true } },
		);
	}

	/** 跳转到实现。 */
	async goToImplementation(
		filePath: string,
		line: number,
		character: number,
	): Promise<LspNavigationResult> {
		return this.navigate(
			"goToImplementation",
			"textDocument/implementation",
			"implementationProvider",
			filePath,
			line,
			character,
		);
	}

	/** 悬停信息。 */
	async hover(filePath: string, line: number, character: number): Promise<LspHoverResult> {
		this.requireReady("textDocument/hover");
		this.requireCapability("hoverProvider", "textDocument/hover");
		const raw = await this.transport.request("textDocument/hover", textDocumentParams(filePath, line, character));
		return this.protectHover(raw);
	}

	// ---------- 内部 ----------

	private async navigate(
		operation: LspNavigationOperation,
		method: string,
		capability: string,
		filePath: string,
		line: number,
		character: number,
		extraParams?: Record<string, unknown>,
	): Promise<LspNavigationResult> {
		this.requireReady(method);
		this.requireCapability(capability, method);
		const raw = await this.transport.request(method, {
			...textDocumentParams(filePath, line, character),
			...extraParams,
		});
		const locations = normalizeLocations(raw);
		return this.protectNavigation(operation, locations);
	}

	private requireReady(method: string): void {
		if (this.state !== "ready") {
			throw new LspError("not-connected", `请先调用 connect() 完成 initialize 握手（${method}）`);
		}
	}

	private requireCapability(capability: string, method: string): void {
		const value = this.capabilities[capability];
		if (value === undefined || value === null || value === false) {
			throw new LspError(
				"capability-unsupported",
				`服务器未声明 ${capability} 能力，无法执行 ${method}`,
				{ capability, method },
			);
		}
	}

	private protectNavigation(
		operation: LspNavigationOperation,
		locations: NormalizedLocation[],
	): LspNavigationResult {
		const totalLocations = locations.length;
		const kept = locations.slice(0, this.maxLocations);
		const omittedLocations = totalLocations - kept.length;
		let rendered = renderLocationGroups(kept);
		let truncated = omittedLocations > 0;
		if (rendered.length > this.maxResultChars) {
			rendered = `${rendered.slice(0, this.maxResultChars)}\n…[结果超限截断]`;
			truncated = true;
		}
		return { operation, locations: kept, totalLocations, omittedLocations, truncated, rendered };
	}

	private protectHover(raw: unknown): LspHoverResult {
		if (typeof raw !== "object" || raw === null) {
			return { operation: "hover", found: false, contents: "", rendered: "", truncated: false };
		}
		const record = raw as Record<string, unknown>;
		const contents = normalizeHoverContents(record["contents"]);
		let range: LspHoverResult["range"];
		if (isLspRange(record["range"])) {
			const value = record["range"];
			range = {
				startLine: value.start.line,
				startCharacter: value.start.character,
				endLine: value.end.line,
				endCharacter: value.end.character,
			};
		}
		let rendered = contents.value;
		let truncated = false;
		if (rendered.length > this.maxResultChars) {
			rendered = `${rendered.slice(0, this.maxResultChars)}\n…[结果超限截断]`;
			truncated = true;
		}
		return {
			operation: "hover",
			found: true,
			contents: contents.value,
			language: contents.language,
			markupKind: contents.markupKind,
			range,
			truncated,
			rendered,
		};
	}
}

function textDocumentParams(filePath: string, line: number, character: number): Record<string, unknown> {
	return {
		textDocument: { uri: pathToUri(filePath) },
		position: { line, character },
	};
}

function resolvePositionEncoding(capabilities: Record<string, unknown>): LspPositionEncoding {
	const raw = capabilities["positionEncoding"];
	return typeof raw === "string" && VALID_POSITION_ENCODINGS.has(raw)
		? (raw as LspPositionEncoding)
		: "utf-16";
}

/** LSP 错误码重导出（lsp-tool 与调用方判别用）。 */
export type { LspCloseEvent, LspErrorCode };
