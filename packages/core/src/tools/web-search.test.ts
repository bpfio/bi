import { describe, expect, test } from "bun:test";
import {
	DEFAULT_SEARCH_LIMIT,
	ProviderRegistry,
	SearchError,
	TokenBucketRateLimiter,
	TtlResultCache,
	domainMatches,
	prioritizeByDomains,
	webSearch,
	type ClockPort,
	type ProviderPort,
	type ProviderSearchOptions,
	type RateLimiterPort,
	type SearchErrorKind,
	type SearchResult,
} from "./web-search";

// ---------------------------------------------------------------------------
// 测试底座
// ---------------------------------------------------------------------------

function ok(results: SearchResult[]): ProviderPort & { callCount: number } {
	const calls: { query: string; opts: ProviderSearchOptions }[] = [];
	return {
		name: "fake",
		get callCount(): number {
			return calls.length;
		},
		search(query: string, opts: ProviderSearchOptions): Promise<SearchResult[]> {
			calls.push({ query, opts });
			return Promise.resolve(results);
		},
	};
}

function assertError(e: unknown, kind: SearchErrorKind): SearchError {
	expect(SearchError.is(e)).toBe(true);
	const err = e as SearchError;
	expect(err.kind).toBe(kind);
	return err;
}

async function expectError(p: Promise<unknown>, kind: SearchErrorKind): Promise<SearchError> {
	try {
		await p;
		expect.unreachable();
		throw new Error("unreachable");
	} catch (e) {
		return assertError(e, kind);
	}
}

const hit = (title: string, url: string, snippet = "…"): SearchResult => ({
	title,
	url,
	snippet,
	provider: "fake",
});

/** 假时钟：now 手动推进，sleep 记录请求并同步推进时钟。 */
function fakeClock(): ClockPort & { t: number; sleeps: number[] } {
	let t = 0;
	const sleeps: number[] = [];
	return {
		get t(): number {
			return t;
		},
		sleeps,
		now: () => t,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			t += ms;
		},
	};
}

/** 可推进时钟。 */
function mutableClock(): { clock: ClockPort; advance: (ms: number) => void } {
	let t = 0;
	return {
		clock: { now: () => t, sleep: async (ms: number) => void (t += ms) },
		advance: (ms: number) => void (t += ms),
	};
}

// ---------------------------------------------------------------------------
// Provider 解析与调用
// ---------------------------------------------------------------------------

describe("webSearch · provider 解析", () => {
	test("按名字解析注册表 provider，结果打上 provider 标签", async () => {
		const p = ok([hit("标题", "https://x.example.com/")]);
		const registry = new ProviderRegistry().register(p);
		const r = await webSearch("测试词", { provider: "fake", registry, cache: null, limiter: { acquire: async () => {} } });
		expect(r).toEqual([{ title: "标题", url: "https://x.example.com/", snippet: "…", provider: "fake" }]);
	});

	test("未注册名字 → provider-not-found", async () => {
		const err = await expectError(
			webSearch("q", { provider: "nope", registry: new ProviderRegistry(), cache: null }),
			"provider-not-found",
		);
		expect(err.message).toContain("nope");
	});

	test("无 provider 且注册表无缺省 → no-provider", async () => {
		await expectError(
			webSearch("q", { registry: new ProviderRegistry(), cache: null }),
			"no-provider",
		);
	});

	test("注册表首个注册者即缺省 provider", async () => {
		const p = ok([hit("默认", "https://d.example.com/")]);
		const registry = new ProviderRegistry().register(p);
		const r = await webSearch("q", { registry, cache: null, limiter: { acquire: async () => {} } });
		expect(r[0]!.provider).toBe("fake");
	});

	test("limit 透传给 provider 并做切片兜底", async () => {
		const p = ok([hit("1", "https://1.example.com/"), hit("2", "https://2.example.com/"), hit("3", "https://3.example.com/"), hit("4", "https://4.example.com/")]);
		const registry = new ProviderRegistry().register(p);
		const r = await webSearch("q", { provider: "fake", registry, limit: 2, cache: null, limiter: { acquire: async () => {} } });
		expect(r.length).toBe(2);
		expect(DEFAULT_SEARCH_LIMIT).toBe(8);
	});

	test("空查询词 → invalid-query", async () => {
		await expectError(webSearch("   ", { cache: null }), "invalid-query");
	});
});

// ---------------------------------------------------------------------------
// 缓存与限速
// ---------------------------------------------------------------------------

describe("webSearch · 缓存命中不过网", () => {
	test("同 (provider,query,limit) 第二次命中缓存：provider 只调一次", async () => {
		const p = ok([hit("c", "https://c.example.com/")]);
		const registry = new ProviderRegistry().register(p);
		const cache = new TtlResultCache(60_000);
		const limiter: RateLimiterPort & { count: number } = Object.assign(
			{ count: 0 },
			{ acquire: async () => void (limiter.count++) },
		);
		const r1 = await webSearch("热词", { provider: "fake", registry, cache, limiter });
		const r2 = await webSearch("热词", { provider: "fake", registry, cache, limiter });
		expect(r2).toEqual(r1);
		expect(p.callCount).toBe(1);
		expect(limiter.count).toBe(1); // 命中缓存不限速
	});

	test("显式 cache:null 关闭缓存：两次都过网", async () => {
		const p = ok([hit("n", "https://n.example.com/")]);
		const registry = new ProviderRegistry().register(p);
		await webSearch("q1", { provider: "fake", registry, cache: null, limiter: { acquire: async () => {} } });
		await webSearch("q1", { provider: "fake", registry, cache: null, limiter: { acquire: async () => {} } });
		expect(p.callCount).toBe(2);
	});
});

describe("TtlResultCache", () => {
	test("TTL 内命中，过期后失效", () => {
		const { clock, advance } = mutableClock();
		const cache = new TtlResultCache(1000, clock);
		cache.set("k", [hit("t", "https://t.example.com/")]);
		expect(cache.get("k")).toHaveLength(1);
		advance(1001);
		expect(cache.get("k")).toBeUndefined();
	});

	test("容量上限按插入序驱逐最旧条目", () => {
		const cache = new TtlResultCache(60_000, fakeClock(), 2);
		cache.set("a", [hit("a", "https://a.example.com/")]);
		cache.set("b", [hit("b", "https://b.example.com/")]);
		cache.set("c", [hit("c", "https://c.example.com/")]);
		expect(cache.size).toBe(2);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("c")).toBeDefined();
	});
});

describe("TokenBucketRateLimiter", () => {
	test("突发额度内即时获取（rps=2 → 容量 2）", async () => {
		const clock = fakeClock();
		const limiter = new TokenBucketRateLimiter(2, clock);
		await limiter.acquire();
		await limiter.acquire();
		expect(clock.sleeps).toEqual([]); // 两次即时
	});

	test("超出突发后按 1/rps 等待回填（确定性假时钟）", async () => {
		const clock = fakeClock();
		const limiter = new TokenBucketRateLimiter(2, clock);
		await limiter.acquire();
		await limiter.acquire();
		await limiter.acquire(); // 需等待 0.5s 回填 1 个令牌
		expect(clock.sleeps).toEqual([500]);
		expect(clock.t).toBe(500);
	});

	test("webSearch 缺省 rps=1：第二个不同查询被节流（真实时钟 ≥900ms）", async () => {
		const registry = new ProviderRegistry().register(ok([hit("t", "https://t.example.com/")]));
		const start = Date.now();
		await webSearch("节流-1", { registry, cache: null });
		await webSearch("节流-2", { registry, cache: null });
		expect(Date.now() - start).toBeGreaterThanOrEqual(900);
	}, 10_000);
});

// ---------------------------------------------------------------------------
// 白名单优先排序
// ---------------------------------------------------------------------------

describe("白名单优先排序", () => {
	test("权威域命中置顶，组内保持原顺序", () => {
		const results = [
			hit("博客", "https://blog.example.org/post"),
			hit("权威", "https://www.nature.com/articles/x"),
			hit("论坛", "https://forum.example.org/t"),
			hit("权威2", "https://nature.com/y"),
		];
		const sorted = prioritizeByDomains(results, ["nature.com"]);
		expect(sorted.map((r) => r.url)).toEqual([
			"https://www.nature.com/articles/x",
			"https://nature.com/y",
			"https://blog.example.org/post",
			"https://forum.example.org/t",
		]);
	});

	test("空白名单原样返回", () => {
		const results = [hit("a", "https://a.com/"), hit("b", "https://b.com/")];
		expect(prioritizeByDomains(results, [])).toEqual(results);
	});

	test("domainMatches：精确域与子域命中，前缀伪装不命中", () => {
		expect(domainMatches("nature.com", "nature.com")).toBe(true);
		expect(domainMatches("www.nature.com", "nature.com")).toBe(true);
		expect(domainMatches("fakenature.com", "nature.com")).toBe(false);
		expect(domainMatches("nature.com.evil.io", "nature.com")).toBe(false);
	});

	test("webSearch 集成：白名单结果置顶", async () => {
		const p = ok([
			hit("杂", "https://misc.example.net/1"),
			hit("权威", "https://sub.imf.org/report"),
		]);
		const registry = new ProviderRegistry().register(p);
		const r = await webSearch("q", { provider: "fake", registry, cache: null, limiter: { acquire: async () => {} }, authoritativeDomains: ["imf.org"] });
		expect(r[0]!.url).toBe("https://sub.imf.org/report");
	});
});

// ---------------------------------------------------------------------------
// 超时与错误包装
// ---------------------------------------------------------------------------

describe("webSearch · 超时与错误", () => {
	test("provider 挂起 → timeout 结构化错误（不真等 provider）", async () => {
		const hanging: ProviderPort = {
			name: "hanging",
			search: (_q, opts) =>
				new Promise<SearchResult[]>((_, reject) => {
					opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		};
		const registry = new ProviderRegistry().register(hanging);
		await expectError(
			webSearch("q", { provider: "hanging", registry, cache: null, timeoutMs: 40 }),
			"timeout",
		);
	});

	test("provider 抛错 → provider-error 包装", async () => {
		const bad: ProviderPort = {
			name: "bad",
			search: () => Promise.reject(new Error("boom")),
		};
		const registry = new ProviderRegistry().register(bad);
		const err = await expectError(
			webSearch("q", { provider: "bad", registry, cache: null, limiter: { acquire: async () => {} } }),
			"provider-error",
		);
		expect(err.provider).toBe("bad");
		expect(err.message).toContain("boom");
	});
});
