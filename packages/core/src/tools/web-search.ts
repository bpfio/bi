/**
 * BI-07.15 —— Web 搜索工具链（webSearch）。
 *
 * 合约要点：
 * - ProviderPort 可插拔：{ name, search(q, opts) }，注册表解析（名字或实例）。
 * - SearchResult = { title, url, snippet, provider }。
 * - 结果缓存：Map + TTL（缺省 5 分钟），命中不过网。
 * - 令牌桶限速：按 provider 维度，rps 可配（缺省 1），时钟/睡眠可注入便于
 *   离屏确定性测试。
 * - 白名单优先排序：命中权威源域名（精确域或子域）的结果置顶，组内保持
 *   provider 原始顺序（稳定分区）。
 * - 一切失败路径只抛结构化 SearchError，绝不抛裸异常。
 */

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** 单条搜索结果。 */
export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	/** 产出该结果的 provider 名。 */
	provider: string;
}

/** 传给 provider 的搜索选项。 */
export interface ProviderSearchOptions {
	limit: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** 搜索 Provider 端口：可插拔实现契约。 */
export interface ProviderPort {
	readonly name: string;
	search(query: string, opts: ProviderSearchOptions): Promise<SearchResult[]>;
}

/** 限速器端口（可注入替代实现）。 */
export interface RateLimiterPort {
	acquire(): Promise<void>;
}

/** 结果缓存端口（可注入替代实现）。 */
export interface SearchCachePort {
	get(key: string): SearchResult[] | undefined;
	set(key: string, results: SearchResult[]): void;
}

/** 时钟端口：令牌桶/缓存可注入假时钟做确定性测试。 */
export interface ClockPort {
	now(): number;
	sleep(ms: number): Promise<void>;
}

/** SearchError 结构化错误种类。 */
export type SearchErrorKind =
	| "invalid-query"
	| "no-provider"
	| "provider-not-found"
	| "timeout"
	| "provider-error";

/** 结构化搜索错误。 */
export class SearchError extends Error {
	readonly kind: SearchErrorKind;
	readonly provider?: string;
	readonly status?: number;

	constructor(
		kind: SearchErrorKind,
		message: string,
		details: { provider?: string; status?: number; cause?: unknown } = {},
	) {
		super(message);
		this.name = "SearchError";
		this.kind = kind;
		this.provider = details.provider;
		this.status = details.status;
		if (details.cause !== undefined) this.cause = details.cause;
	}

	static is(e: unknown): e is SearchError {
		return e instanceof SearchError;
	}
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const DEFAULT_SEARCH_LIMIT = 8;
export const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
export const DEFAULT_SEARCH_RPS = 1;
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

const MAX_SEARCH_LIMIT = 100;

// ---------------------------------------------------------------------------
// 时钟
// ---------------------------------------------------------------------------

/** 真实时钟（缺省）。 */
export const realClock: ClockPort = {
	now: () => Date.now(),
	sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

/** Provider 注册表：按名字注册/解析，首注册者为缺省。 */
export class ProviderRegistry {
	private providers = new Map<string, ProviderPort>();
	private defaultName?: string;

	register(p: ProviderPort): this {
		this.providers.set(p.name, p);
		if (this.defaultName === undefined) this.defaultName = p.name;
		return this;
	}

	unregister(name: string): boolean {
		const removed = this.providers.delete(name);
		if (removed && this.defaultName === name) {
			this.defaultName = this.providers.keys().next().value;
		}
		return removed;
	}

	get(name: string): ProviderPort | undefined {
		return this.providers.get(name);
	}

	has(name: string): boolean {
		return this.providers.has(name);
	}

	list(): string[] {
		return [...this.providers.keys()];
	}

	setDefault(name: string): this {
		if (!this.providers.has(name)) {
			throw new SearchError("provider-not-found", `未知 provider: ${name}`);
		}
		this.defaultName = name;
		return this;
	}

	getDefault(): ProviderPort | undefined {
		return this.defaultName === undefined ? undefined : this.providers.get(this.defaultName);
	}
}

/** 模块级缺省注册表（可插拔 provider 由此挂载）。 */
export const defaultSearchRegistry = new ProviderRegistry();

// ---------------------------------------------------------------------------
// TTL 缓存
// ---------------------------------------------------------------------------

/** 缓存键：provider|query|limit。 */
export function searchCacheKey(provider: string, query: string, limit: number): string {
	return `${provider}|${query}|${limit}`;
}

/** Map + TTL 结果缓存（LRU 式按容量驱逐最旧条目）。 */
export class TtlResultCache implements SearchCachePort {
	private readonly entries = new Map<string, { at: number; results: SearchResult[] }>();

	constructor(
		readonly ttlMs: number = DEFAULT_CACHE_TTL_MS,
		private readonly clock: ClockPort = realClock,
		readonly maxEntries = 256,
	) {}

	get(key: string): SearchResult[] | undefined {
		const hit = this.entries.get(key);
		if (hit === undefined) return undefined;
		if (this.clock.now() - hit.at > this.ttlMs) {
			this.entries.delete(key);
			return undefined;
		}
		return hit.results;
	}

	set(key: string, results: SearchResult[]): void {
		if (this.entries.size >= this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		this.entries.set(key, { at: this.clock.now(), results });
	}

	get size(): number {
		return this.entries.size;
	}

	clear(): void {
		this.entries.clear();
	}
}

/** 模块级缺省缓存（TTL 5min）。 */
export const defaultSearchCache = new TtlResultCache();

// ---------------------------------------------------------------------------
// 令牌桶限速
// ---------------------------------------------------------------------------

/** 简单令牌桶：容量 = max(1, rps)（一秒突发量），按 rps 速率回填。 */
export class TokenBucketRateLimiter implements RateLimiterPort {
	private tokens: number;
	private lastRefill: number;
	readonly capacity: number;
	readonly rps: number;

	constructor(rps: number, private readonly clock: ClockPort = realClock) {
		const rate = Number.isFinite(rps) ? Math.max(rps, 0.001) : DEFAULT_SEARCH_RPS;
		this.rps = rate;
		this.capacity = Math.max(1, rate);
		this.tokens = this.capacity;
		this.lastRefill = clock.now();
	}

	async acquire(): Promise<void> {
		for (;;) {
			const now = this.clock.now();
			const elapsedMs = Math.max(0, now - this.lastRefill);
			this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs * this.rps) / 1000);
			this.lastRefill = now;
			if (this.tokens >= 1) {
				this.tokens -= 1;
				return;
			}
			const waitMs = Math.ceil(((1 - this.tokens) / this.rps) * 1000);
			await this.clock.sleep(waitMs);
		}
	}
}

/** 模块级按 provider 维度的缺省限速器（rps 缺省 1）。 */
const providerLimiters = new Map<string, TokenBucketRateLimiter>();

function resolveLimiter(providerName: string, rps: number | undefined): RateLimiterPort {
	if (rps === undefined) {
		let limiter = providerLimiters.get(providerName);
		if (limiter === undefined) {
			limiter = new TokenBucketRateLimiter(DEFAULT_SEARCH_RPS);
			providerLimiters.set(providerName, limiter);
		}
		return limiter;
	}
	return new TokenBucketRateLimiter(rps);
}

// ---------------------------------------------------------------------------
// 白名单优先排序
// ---------------------------------------------------------------------------

/** 主机名是否等于权威域或其子域。 */
export function domainMatches(host: string, domain: string): boolean {
	const h = host.toLowerCase();
	const d = domain.toLowerCase().trim();
	if (d === "") return false;
	return h === d || h.endsWith(`.${d}`);
}

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * 稳定分区排序：命中权威域白名单的结果置顶，组内保持原相对顺序。
 * 白名单为空时原样返回。
 */
export function prioritizeByDomains(
	results: readonly SearchResult[],
	domains: readonly string[] | undefined,
): SearchResult[] {
	if (!domains || domains.length === 0) return [...results];
	const decorated = results.map((r, i) => ({
		r,
		i,
		hit: domains.some((d) => domainMatches(hostnameOf(r.url), d)),
	}));
	decorated.sort((a, b) => {
		if (a.hit !== b.hit) return a.hit ? -1 : 1;
		return a.i - b.i;
	});
	return decorated.map((d) => d.r);
}

// ---------------------------------------------------------------------------
// 公共入口
// ---------------------------------------------------------------------------

/** webSearch 选项。 */
export interface WebSearchOptions {
	/** provider 名（经注册表解析）或直接给 ProviderPort 实例；缺省用注册表默认。 */
	provider?: string | ProviderPort;
	/** 结果条数上限；缺省 8。 */
	limit?: number;
	/** 单次搜索超时（毫秒）；缺省 15000。 */
	timeoutMs?: number;
	/** 限速 rps（提供时用独立令牌桶）；缺省走模块级限速器（rps=1）。 */
	rps?: number;
	/** 权威源域名白名单：命中的结果置顶。 */
	authoritativeDomains?: readonly string[];
	/** 自定义注册表；缺省 defaultSearchRegistry。 */
	registry?: ProviderRegistry;
	/** 注入限速器；缺省按 provider 维度的模块级令牌桶。 */
	limiter?: RateLimiterPort;
	/** 注入缓存；缺省 defaultSearchCache，显式传 null 关闭缓存。 */
	cache?: SearchCachePort | null;
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	onTimeout: () => Error,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

/**
 * Web 搜索统一入口：provider 解析 → 缓存查询 → 限速 → 调 provider →
 * 白名单优先排序 → 写缓存。失败一律抛结构化 SearchError。
 */
export async function webSearch(query: string, options: WebSearchOptions = {}): Promise<SearchResult[]> {
	const q = query.trim();
	if (q === "") {
		throw new SearchError("invalid-query", "搜索词不能为空");
	}
	const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DEFAULT_SEARCH_LIMIT)), MAX_SEARCH_LIMIT);
	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);

	// —— provider 解析 ——
	const registry = options.registry ?? defaultSearchRegistry;
	let provider: ProviderPort | undefined;
	if (typeof options.provider === "string") {
		provider = registry.get(options.provider);
		if (provider === undefined) {
			throw new SearchError("provider-not-found", `未注册的 provider: ${options.provider}`);
		}
	} else if (options.provider !== undefined) {
		provider = options.provider;
	} else {
		provider = registry.getDefault();
		if (provider === undefined) {
			throw new SearchError("no-provider", "未指定 provider 且注册表无缺省 provider");
		}
	}

	// —— 缓存（命中不过网）——
	const resolved: ProviderPort = provider;
	const cache = options.cache === undefined ? defaultSearchCache : options.cache;
	const key = searchCacheKey(resolved.name, q, limit);
	const cached = cache?.get(key);
	if (cached !== undefined) {
		return prioritizeByDomains(cached, options.authoritativeDomains);
	}

	// —— 限速 → 调 provider（带超时）——
	const limiter = options.limiter ?? resolveLimiter(resolved.name, options.rps);
	await limiter.acquire();

	const controller = new AbortController();
	const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
	let pending: Promise<SearchResult[]>;
	try {
		pending = resolved.search(q, { limit, timeoutMs, signal: controller.signal });
	} catch (e) {
		clearTimeout(abortTimer);
		throw new SearchError("provider-error", `provider ${resolved.name} 同步失败: ${e instanceof Error ? e.message : String(e)}`, { provider: resolved.name, cause: e });
	}
	let results: SearchResult[];
	try {
		results = await withTimeout(pending, timeoutMs, () => new SearchError("timeout", `搜索超时（${timeoutMs}ms）: ${q}`, { provider: resolved.name }));
	} catch (e) {
		clearTimeout(abortTimer);
		if (controller.signal.aborted) {
			// 超时 abort 先于/后于 provider 自身拒绝都统一归为 timeout
			throw new SearchError("timeout", `搜索超时（${timeoutMs}ms）: ${q}`, {
				provider: resolved.name,
				cause: e,
			});
		}
		if (SearchError.is(e)) throw e;
		throw new SearchError("provider-error", `provider ${resolved.name} 搜索失败: ${e instanceof Error ? e.message : String(e)}`, { provider: resolved.name, cause: e });
	}
	clearTimeout(abortTimer);

	results = results.slice(0, limit);
	cache?.set(key, results);
	return prioritizeByDomains(results, options.authoritativeDomains);
}
