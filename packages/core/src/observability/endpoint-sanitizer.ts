/**
 * BI-11.1 —— 端点与错误负载脱敏器（endpoint-sanitizer）。
 *
 * 零数据外泄铁律：任何进入遥测/日志的端点与错误文本，先经本模块脱敏。
 * - sanitizeEndpoint：保留 scheme + host + 端口 + path 前段，抹 path 深处
 *   与 query 值（白名单参数可配保留）；userinfo 与 fragment 一律丢弃。
 * - sanitizeErrorPayload：抹 Authorization/Bearer/api_key/token/secret 等
 *   模式、sk- 形态密钥、JWT、IPv4 尾段；模式表可注入扩展或整体替换。
 *
 * 全模块无 I/O、无全局状态，纯函数可组合。
 */

// ---------------------------------------------------------------------------
// 端点脱敏
// ---------------------------------------------------------------------------

/** sanitizeEndpoint 选项。 */
export interface SanitizeEndpointOptions {
	/** query 参数白名单：命中的参数保留原值，其余值抹为 "…"；缺省全抹。 */
	allowQueryParams?: readonly string[];
	/** 保留的 path 前段数量（≥0），更深的段抹为 "…"；缺省 1。 */
	keepPathDepth?: number;
}

/** 不可解析端点的安全占位（零泄漏：原串一个字符都不带出）。 */
export const INVALID_ENDPOINT_PLACEHOLDER = "[invalid-endpoint]";

/** query 值与 path 深段的统一掩码。 */
export const REDACTED_SEGMENT = "…";

function maskQuery(search: string, allow: ReadonlySet<string>): string {
	if (search === "" || search === "?") return "";
	const sp = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
	const parts: string[] = [];
	for (const [k, v] of sp) {
		parts.push(allow.has(k.toLowerCase()) ? `${k}=${v}` : `${k}=${REDACTED_SEGMENT}`);
	}
	return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function maskPath(pathname: string, keepDepth: number): string {
	if (keepDepth <= 0) return ""; // 0 段语义：仅保留 host
	const segments = pathname.split("/").filter((s) => s !== "");
	if (segments.length === 0) return "";
	const kept = segments.slice(0, keepDepth);
	const tail = segments.length > kept.length ? `/${REDACTED_SEGMENT}` : "";
	const head = `/${kept.join("/")}`;
	return `${head}${tail}`;
}

/** 解析端点：要求得到非空 host（特 scheme），否则按 https:// 前缀兜底。 */
function parseEndpoint(url: string): URL | null {
	try {
		const u = new URL(url);
		if (u.host !== "") return u;
	} catch {
		/* 继续兜底 */
	}
	try {
		const u2 = new URL(`https://${url}`);
		if (u2.host !== "") return u2;
	} catch {
		/* 不可解析 */
	}
	return null;
}

/**
 * 端点脱敏：保留 scheme://host[:port] 与 path 前段，深处路径段与 query 值
 * 一律掩码；userinfo（user:pass@）与 fragment 直接丢弃。
 * 无 scheme 的 host:port 形态按 https 补全解析；不可解析返回安全占位。
 */
export function sanitizeEndpoint(url: string, options: SanitizeEndpointOptions = {}): string {
	const u = parseEndpoint(url.trim());
	if (u === null) return INVALID_ENDPOINT_PLACEHOLDER;

	const hostPart = u.host; // 已含显式端口；默认端口由 URL 规范化
	const path = maskPath(u.pathname, options.keepPathDepth ?? 1);
	const query = maskQuery(u.search, new Set((options.allowQueryParams ?? []).map((k) => k.toLowerCase())));
	return `${u.protocol}//${hostPart}${path}${query}`;
}

// ---------------------------------------------------------------------------
// 错误负载脱敏
// ---------------------------------------------------------------------------

/** 单条脱敏模式：pattern 需含 g 语义（应用时自动补 g 并重建，避免 lastIndex 污染）。 */
export interface RedactionPattern {
	/** 模式名（调试/审计用）。 */
	name: string;
	/** 全局正则。 */
	pattern: RegExp;
	/** 替换串（可用 $1 组引用）或替换函数。 */
	replacement: string | ((match: string, ...groups: string[]) => string);
}

/** 掩码占位。 */
export const REDACTED = "…";

/** 内建模式表（按序应用，先长后短、先具体后宽泛）。 */
export const DEFAULT_REDACTION_PATTERNS: readonly RedactionPattern[] = [
	{
		// Authorization / Proxy-Authorization 头整值（含 Bearer 混合形态）
		name: "authorization-header",
		pattern: /\b(proxy-)?authorization\s*:\s*[^,\r\n};]+/gi,
		replacement: (m) => (m.toLowerCase().startsWith("proxy") ? "proxy-authorization: " : "authorization: ") + REDACTED,
	},
	{
		// 独立 Bearer 凭据
		name: "bearer",
		pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
		replacement: "Bearer " + REDACTED,
	},
	{
		// JSON 形态敏感键（"token":"abc" / "api_key":"abc"）
		name: "quoted-secret-keys",
		pattern: /("(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|session[_-]?id|authorization|cookie)"\s*:\s*")[^"]*(")/gi,
		replacement: "$1" + REDACTED + "$2",
	},
	{
		// 裸 kv 形态（?token=abc& / token: abc / token=abc）
		name: "bare-secret-kv",
		pattern: /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|session[_-]?id)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&'"}\]]+)/gi,
		replacement: "$1=" + REDACTED,
	},
	{
		// sk- 形态平台密钥
		name: "sk-key",
		pattern: /\bsk-[A-Za-z0-9_-]{12,}/g,
		replacement: "sk-" + REDACTED,
	},
	{
		// JWT 三段式
		name: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
		replacement: "eyJ" + REDACTED,
	},
	{
		// IPv4 尾段（内网拓扑零泄漏）
		name: "ipv4-tail-octet",
		pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
		replacement: (m) => `${m.slice(0, m.lastIndexOf("."))}.` + REDACTED,
	},
];

/** sanitizeErrorPayload 选项。 */
export interface SanitizePayloadOptions {
	/** 整体替换内建模式表（提供时 DEFAULT 不参与）。 */
	patterns?: readonly RedactionPattern[];
	/** 在模式表之后追加的扩展模式。 */
	extraPatterns?: readonly RedactionPattern[];
}

function applyPattern(text: string, p: RedactionPattern): string {
	// 重建带 g 的正则，杜绝共享 RegExp 的 lastIndex 状态泄漏
	const flags = p.pattern.flags.includes("g") ? p.pattern.flags : p.pattern.flags + "g";
	const re = new RegExp(p.pattern.source, flags);
	const replacement = p.replacement;
	if (typeof replacement === "function") {
		return text.replace(re, (m, ...groups) => replacement(m, ...(groups as string[])));
	}
	return text.replace(re, replacement);
}

/**
 * 错误负载脱敏：按模式表顺序抹除凭据/密钥/IP 尾段。
 * 模式表可整体替换或追加扩展；多遍应用保证模式间不互相复活。
 */
export function sanitizeErrorPayload(text: string, options: SanitizePayloadOptions = {}): string {
	const patterns = [...(options.patterns ?? DEFAULT_REDACTION_PATTERNS), ...(options.extraPatterns ?? [])];
	let out = text;
	for (const p of patterns) {
		if (out === "") break;
		out = applyPattern(out, p);
	}
	return out;
}
