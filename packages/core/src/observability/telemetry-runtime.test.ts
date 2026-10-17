import { describe, expect, test } from "bun:test";
import {
	AgentExecutionTelemetryRuntime,
	LocalBufferExporter,
	OtlpHttpExporter,
	type ExporterPort,
	type TraceSpan,
} from "./telemetry-runtime";
import type { FetchExecutor } from "../tools/web-fetch";

// ---------------------------------------------------------------------------
// 测试底座
// ---------------------------------------------------------------------------

/** 可推进假时钟。 */
function fakeClock(start = 1000): { now: () => number; advance: (ms: number) => void } {
	let t = start;
	return { now: () => t, advance: (ms) => void (t += ms) };
}

/** 收集型 spy exporter。 */
function spyExporter(): ExporterPort & { spans: TraceSpan[] } {
	const spans: TraceSpan[] = [];
	return { spans, export: (s) => void spans.push(s) };
}

/** 注入捕获型伪 fetch（OTLP 离屏）。 */
function captureFetch(status = 200): { fetchImpl: FetchExecutor; bodies: string[]; urls: string[] } {
	const bodies: string[] = [];
	const urls: string[] = [];
	const fetchImpl: FetchExecutor = async (url, init) => {
		urls.push(url);
		bodies.push(String(init?.body ?? ""));
		return new Response("{}", { status, headers: { "content-type": "application/json" } });
	};
	return { fetchImpl, bodies, urls };
}

// ---------------------------------------------------------------------------
// span 树与时长
// ---------------------------------------------------------------------------

describe("AgentExecutionTelemetryRuntime · span 树", () => {
	test("父子关系与 durationMs（注入时钟确定性）", () => {
		const clock = fakeClock();
		const rt = new AgentExecutionTelemetryRuntime({ now: clock.now });
		const root = rt.startSpan("agent.run", { step: 1 });
		clock.advance(10);
		const child = rt.startSpan("tool.fetch");
		clock.advance(35);
		rt.endSpan(child, "ok");
		clock.advance(5);
		rt.endSpan(root, "ok");

		expect(rt.spanCount).toBe(2);
		expect(root.parentId).toBeNull();
		expect(child.parentId).toBe(root.id);
		expect(child.traceId).toBe(root.traceId);
		expect(child.durationMs).toBe(35);
		expect(root.durationMs).toBe(50);
		expect(root.status).toBe("ok");
		expect(rt.childrenOf(root.id).map((s) => s.name)).toEqual(["tool.fetch"]);
		expect(rt.rootSpans().map((s) => s.id)).toEqual([root.id]);
	});

	test("兄弟 span 与多级嵌套", () => {
		const rt = new AgentExecutionTelemetryRuntime({ now: () => 0 });
		const a = rt.startSpan("a");
		const b1 = rt.startSpan("b1");
		rt.endSpan(b1, "ok");
		const b2 = rt.startSpan("b2");
		const c = rt.startSpan("c");
		rt.endSpan(c, "ok");
		rt.endSpan(b2, "ok");
		rt.endSpan(a, "ok");

		expect(rt.childrenOf(a.id).map((s) => s.name)).toEqual(["b1", "b2"]);
		expect(c.parentId).toBe(b2.id);
		expect(b1.parentId).toBe(a.id);
		expect(rt.allSpans().every((s) => s.traceId === a.traceId)).toBe(true);
	});

	test("独立根 span 开新 trace", () => {
		const rt = new AgentExecutionTelemetryRuntime({ now: () => 0 });
		const r1 = rt.startSpan("r1");
		rt.endSpan(r1, "ok");
		const r2 = rt.startSpan("r2");
		rt.endSpan(r2, "ok");
		expect(r1.traceId).not.toBe(r2.traceId);
		expect(rt.rootSpans()).toHaveLength(2);
	});

	test("error 状态与 statusMessage；running span 无 duration", () => {
		const rt = new AgentExecutionTelemetryRuntime({ now: () => 42 });
		const s = rt.startSpan("op");
		expect(s.status).toBe("running");
		expect(s.durationMs).toBeNull();
		rt.endSpan(s, "error", "HTTP 503: upstream Bearer abcdeadbeef expired");
		expect(s.status).toBe("error");
		expect(s.statusMessage).not.toContain("abcdeadbeef");
		expect(s.statusMessage).toContain("Bearer …");
	});
});

// ---------------------------------------------------------------------------
// 采样
// ---------------------------------------------------------------------------

describe("AgentExecutionTelemetryRuntime · 采样", () => {
	test("采样率 0：不入树、不导出", () => {
		const spy = spyExporter();
		const rt = new AgentExecutionTelemetryRuntime({ exporter: spy, samplingRate: 0 });
		const a = rt.startSpan("x");
		rt.endSpan(a, "ok");
		expect(rt.spanCount).toBe(0);
		expect(spy.spans).toHaveLength(0);
		expect(rt.rootSpans()).toHaveLength(0);
	});

	test("采样率 1（缺省）全采", () => {
		const spy = spyExporter();
		const rt = new AgentExecutionTelemetryRuntime({ exporter: spy });
		for (let i = 0; i < 5; i++) {
			const s = rt.startSpan(`s${i}`);
			rt.endSpan(s, "ok");
		}
		expect(rt.spanCount).toBe(5);
		expect(spy.spans).toHaveLength(5);
	});

	test("rng 注入判定边界：rng()=0.9 > 0.5 不采，0.1 ≤ 0.5 采", () => {
		const spy = spyExporter();
		let v = 0.9;
		const rt = new AgentExecutionTelemetryRuntime({ exporter: spy, samplingRate: 0.5, rng: () => v });
		const a = rt.startSpan("drop");
		rt.endSpan(a, "ok");
		expect(rt.spanCount).toBe(0);
		v = 0.1;
		const b = rt.startSpan("keep");
		rt.endSpan(b, "ok");
		expect(rt.spanCount).toBe(1);
		expect(spy.spans).toHaveLength(1);
	});

	test("父采样传播：根未采样则整棵子树不采", () => {
		const spy = spyExporter();
		const seq = [0.9, 0.1]; // 根 rng 0.9（>0.5 不采），子 rng 0.1
		let i = 0;
		const rt = new AgentExecutionTelemetryRuntime({
			exporter: spy,
			samplingRate: 0.5,
			rng: () => seq[Math.min(i++, seq.length - 1)]!,
		});
		const root = rt.startSpan("root");
		const child = rt.startSpan("child");
		rt.endSpan(child, "ok");
		rt.endSpan(root, "ok");
		expect(rt.spanCount).toBe(0);
		expect(spy.spans).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// LocalBufferExporter 环形缓冲
// ---------------------------------------------------------------------------

describe("LocalBufferExporter · 环形缓冲", () => {
	test("容量 3：push 5 条淘汰最旧 2 条", () => {
		const buf = new LocalBufferExporter(3);
		const rt = new AgentExecutionTelemetryRuntime({ exporter: buf, now: () => 0 });
		for (let i = 1; i <= 5; i++) {
			const s = rt.startSpan(`s${i}`);
			rt.endSpan(s, "ok");
		}
		expect(buf.size).toBe(3);
		expect(buf.snapshot().map((s) => s.name)).toEqual(["s3", "s4", "s5"]);
	});

	test("缺省容量 500", () => {
		const rt = new AgentExecutionTelemetryRuntime({ now: () => 0 });
		const buf = rt.exporters[0]!;
		expect(buf).toBeInstanceOf(LocalBufferExporter);
		for (let i = 0; i < 505; i++) {
			const s = rt.startSpan(`s${i}`);
			rt.endSpan(s, "ok");
		}
		expect((buf as LocalBufferExporter).size).toBe(500);
		expect((buf as LocalBufferExporter).capacity).toBe(500);
		expect((buf as LocalBufferExporter).snapshot()[0]!.name).toBe("s5");
	});
});

// ---------------------------------------------------------------------------
// 端点脱敏（复用 endpoint-sanitizer）
// ---------------------------------------------------------------------------

describe("AgentExecutionTelemetryRuntime · 零数据外泄脱敏", () => {
	test("url 形态 attr：path 深处与 query 值掩码", () => {
		const spy = spyExporter();
		const rt = new AgentExecutionTelemetryRuntime({ exporter: spy, now: () => 0 });
		const s = rt.startSpan("http", { url: "https://api.example.com/v1/users/42?token=abc&page=2" });
		rt.endSpan(s, "ok");
		expect(s.attrs["url"]).toBe("https://api.example.com/v1/…?token=…&page=…");
		expect(spy.spans[0]!.attrs["url"]).toBe("https://api.example.com/v1/…?token=…&page=…");
	});

	test("endpoint 类属性键（键名命中）脱敏，普通串不动", () => {
		const spy = spyExporter();
		const rt = new AgentExecutionTelemetryRuntime({ exporter: spy, now: () => 0 });
		const s = rt.startSpan("op", {
			endpoint: "http://collector.internal:4318/v1/traces?x=1",
			note: "普通说明文本",
			count: 7,
		});
		rt.endSpan(s, "ok");
		expect(s.attrs["endpoint"]).toBe("http://collector.internal:4318/v1/…?x=…");
		expect(s.attrs["note"]).toBe("普通说明文本");
		expect(s.attrs["count"]).toBe(7);
	});

	test("error message 中端点与凭据双重脱敏", () => {
		const rt = new AgentExecutionTelemetryRuntime({ now: () => 0 });
		const s = rt.startSpan("post");
		rt.endSpan(
			s,
			"error",
			"POST https://api.example.com/v1/chat?api_key=sklive123456 failed: ECONNREFUSED 10.0.3.7",
		);
		expect(s.statusMessage).not.toContain("sklive123456");
		expect(s.statusMessage).toContain("api_key=…");
		expect(s.statusMessage).toContain("10.0.3.…");
	});

	test("sanitizeEndpoint 注入覆写", () => {
		const spy = spyExporter();
		const rt = new AgentExecutionTelemetryRuntime({
			exporter: spy,
			now: () => 0,
			sanitizeEndpoint: () => "[masked]",
		});
		const s = rt.startSpan("op", { url: "https://secret.example.com/a/b" });
		rt.endSpan(s, "ok");
		expect(s.attrs["url"]).toBe("[masked]");
	});
});

// ---------------------------------------------------------------------------
// exporter 故障隔离
// ---------------------------------------------------------------------------

describe("AgentExecutionTelemetryRuntime · exporter 隔离", () => {
	test("同步抛错不拖垮 runtime，其余 exporter 正常收数", () => {
		const bad: ExporterPort = {
			export: () => {
				throw new Error("exporter exploded");
			},
		};
		const good = spyExporter();
		const rt = new AgentExecutionTelemetryRuntime({ exporter: bad, now: () => 0 });
		rt.addExporter(good);
		const s = rt.startSpan("op");
		rt.endSpan(s, "ok");
		expect(s.durationMs).not.toBeNull();
		expect(good.spans).toHaveLength(1);
		expect(rt.spanCount).toBe(1);
		expect(rt.droppedExports).toBe(1);
	});

	test("异步拒绝同样隔离", async () => {
		const badAsync: ExporterPort = { export: () => Promise.reject(new Error("async boom")) };
		const good = spyExporter();
		const rt = new AgentExecutionTelemetryRuntime({ exporter: badAsync, now: () => 0 });
		rt.addExporter(good);
		const s = rt.startSpan("op");
		rt.endSpan(s, "ok");
		await new Promise((r) => setTimeout(r, 5)); // 等待异步拒绝落地
		expect(good.spans).toHaveLength(1);
		expect(rt.droppedExports).toBe(1);
	});

	test("endSpan 幂等：重复 end 不重复导出", () => {
		const spy = spyExporter();
		const rt = new AgentExecutionTelemetryRuntime({ exporter: spy, now: () => 0 });
		const s = rt.startSpan("op");
		rt.endSpan(s, "ok");
		rt.endSpan(s, "ok");
		expect(spy.spans).toHaveLength(1);
	});

	test("record() 直接入树并派发导出", () => {
		const spy = spyExporter();
		const rt = new AgentExecutionTelemetryRuntime({ exporter: spy, now: () => 0 });
		const span: TraceSpan = {
			id: "f".repeat(16),
			traceId: "e".repeat(32),
			parentId: null,
			name: "manual",
			attrs: {},
			startedAt: 0,
			endedAt: 5,
			durationMs: 5,
			status: "ok",
		};
		rt.record(span);
		expect(rt.getSpan(span.id)).toBe(span);
		expect(spy.spans).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// OTLP 导出器：缺省不启用、fetch 可注入
// ---------------------------------------------------------------------------

describe("OtlpHttpExporter · 缺省不启用 / 可注入", () => {
	test("缺省 runtime 无任何网络导出器（只有本地缓冲）", () => {
		const rt = new AgentExecutionTelemetryRuntime({ now: () => 0 });
		expect(rt.exporters).toHaveLength(1);
		expect(rt.exporters[0]).toBeInstanceOf(LocalBufferExporter);
	});

	test("未 flush 前零出网：攒批不发送", () => {
		const { fetchImpl, urls } = captureFetch();
		const otlp = new OtlpHttpExporter({ endpoint: "http://collector:4318/v1/traces", fetchImpl, batchSize: 100 });
		const rt = new AgentExecutionTelemetryRuntime({ exporter: otlp, now: () => 0 });
		for (let i = 0; i < 5; i++) {
			const s = rt.startSpan(`s${i}`);
			rt.endSpan(s, "ok");
		}
		expect(urls).toEqual([]); // 未 flush → 零请求
		expect(otlp.pendingCount).toBe(5);
	});

	test("flush 后 POST OTLP/JSON 结构：端点、批次、脱敏后 attrs", async () => {
		const { fetchImpl, bodies, urls } = captureFetch();
		const otlp = new OtlpHttpExporter({
			endpoint: "http://collector:4318/v1/traces",
			fetchImpl,
			batchSize: 2,
		});
		const rt = new AgentExecutionTelemetryRuntime({ exporter: otlp, now: () => 0 });
		const s = rt.startSpan("call", { url: "https://api.example.com/v1/x?token=abc" });
		rt.endSpan(s, "error", "Bearer abcdef123456 rejected");
		await otlp.flush();
		expect(urls).toEqual(["http://collector:4318/v1/traces"]);
		const body = JSON.parse(bodies[0]!) as {
			resourceSpans: Array<{
				resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
				scopeSpans: Array<{ scope: { name: string }; spans: Array<Record<string, unknown>> }>;
			}>;
		};
		const rs = body.resourceSpans[0]!;
		expect(rs.resource.attributes[0]!.key).toBe("service.name");
		const span = rs.scopeSpans[0]!.spans[0]!;
		expect(span["name"]).toBe("call");
		expect(span["traceId"]).toBe(s.traceId);
		expect(span["spanId"]).toBe(s.id);
		expect(span["parentSpanId"]).toBeUndefined();
		expect(span["startTimeUnixNano"]).toMatch(/^\d+$/);
		const attrs = span["attributes"] as Array<{ key: string; value: { stringValue?: string } }>;
		expect(attrs[0]!.value.stringValue).toBe("https://api.example.com/v1/…?token=…");
		const status = span["status"] as { code: number; message?: string };
		expect(status.code).toBe(2);
		expect(status.message).not.toContain("abcdef123456");
	});

	test("发送失败：flush 返回 false + dropped 计数，不抛裸异常", async () => {
		const fetchImpl: FetchExecutor = async () => new Response("err", { status: 503 });
		const otlp = new OtlpHttpExporter({ endpoint: "http://collector:4318/v1/traces", fetchImpl });
		const rt = new AgentExecutionTelemetryRuntime({ exporter: otlp, now: () => 0 });
		const s = rt.startSpan("op");
		rt.endSpan(s, "ok");
		await expect(otlp.flush()).resolves.toBe(false);
		expect(otlp.droppedCount).toBe(1);
		// runtime 主流程不受影响
		const s2 = rt.startSpan("op2");
		rt.endSpan(s2, "ok");
		expect(rt.spanCount).toBe(2);
	});

	test("空批次 flush 直接近似成功且零请求", async () => {
		const { fetchImpl, urls } = captureFetch();
		const otlp = new OtlpHttpExporter({ endpoint: "http://collector:4318/v1/traces", fetchImpl });
		await expect(otlp.flush()).resolves.toBe(true);
		expect(urls).toEqual([]);
	});

	test("batchSize 达阈值自动 flush（异步派发，不阻塞 endSpan）", async () => {
		const { fetchImpl, urls } = captureFetch();
		const otlp = new OtlpHttpExporter({ endpoint: "http://collector:4318/v1/traces", fetchImpl, batchSize: 2 });
		const rt = new AgentExecutionTelemetryRuntime({ exporter: otlp, now: () => 0 });
		for (let i = 0; i < 2; i++) {
			const s = rt.startSpan(`s${i}`);
			rt.endSpan(s, "ok");
		}
		await new Promise((r) => setTimeout(r, 10));
		expect(urls.length).toBeGreaterThanOrEqual(1);
		expect(otlp.droppedCount).toBe(0);
	});
});
