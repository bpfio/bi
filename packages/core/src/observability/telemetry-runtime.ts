/**
 * BI-11.1 —— 可观测性底座（AgentExecutionTelemetryRuntime）。
 *
 * 合约要点：
 * - startSpan/endSpan/record 生成内存 TraceSpan 树（id/parent/duration/attrs）。
 * - ExporterPort 可注入；缺省 LocalBufferExporter 环形缓冲 500 条。
 * - 采样率可配（1.0 全采，0 不记录；父子按父采样传播，OTel parent-based 语义）。
 * - 复用 endpoint-sanitizer：span attrs 中的端点统一脱敏，error message 走
 *   错误负载脱敏（零数据外泄）。
 * - OTLP HTTP 导出器为 ExporterPort 的 POST 实现，fetch 可注入，缺省不启用
 *   （不配置就不出网）；批满或手动 flush 才发送。
 * - 单 exporter 抛错不拖垮 runtime（同步/异步错误均隔离计数）。
 */

import type { FetchExecutor } from "../tools/web-fetch";
import {
	sanitizeEndpoint as defaultSanitizeEndpoint,
	sanitizeErrorPayload as defaultSanitizeError,
} from "./endpoint-sanitizer";

// ---------------------------------------------------------------------------
// TraceSpan 模型
// ---------------------------------------------------------------------------

/** Span 状态机。 */
export type SpanStatus = "running" | "ok" | "error";

/** 内存 TraceSpan 树节点。 */
export interface TraceSpan {
	/** 跨 runtime 唯一的 16 位 hex span id。 */
	id: string;
	/** 所属 trace 的 32 位 hex id（根 span 开新 trace）。 */
	traceId: string;
	/** 父 span id（根为 null）。 */
	parentId: string | null;
	name: string;
	/** 已脱敏属性（端点/凭据不外泄）。 */
	attrs: Record<string, unknown>;
	startedAt: number;
	endedAt: number | null;
	durationMs: number | null;
	status: SpanStatus;
	/** 失败信息（已脱敏）。 */
	statusMessage?: string;
}

/** 导出器端口：可注入（LocalBuffer / OTLP / 测试 spy）。 */
export interface ExporterPort {
	export(span: TraceSpan): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// LocalBufferExporter：环形缓冲
// ---------------------------------------------------------------------------

/** 缺省环形缓冲容量。 */
export const DEFAULT_BUFFER_CAPACITY = 500;

/** 内存环形缓冲导出器（满则淘汰最旧）。 */
export class LocalBufferExporter implements ExporterPort {
	private readonly buf: TraceSpan[] = [];

	constructor(readonly capacity: number = DEFAULT_BUFFER_CAPACITY) {
		if (!Number.isFinite(capacity) || capacity < 1) {
			throw new Error(`LocalBufferExporter capacity 非法: ${capacity}`);
		}
	}

	export(span: TraceSpan): void {
		if (this.buf.length >= this.capacity) this.buf.shift();
		this.buf.push(span);
	}

	/** 快照（旧→新）。 */
	snapshot(): TraceSpan[] {
		return [...this.buf];
	}

	get size(): number {
		return this.buf.length;
	}

	clear(): void {
		this.buf.length = 0;
	}
}

// ---------------------------------------------------------------------------
// OTLP HTTP 导出器（缺省不启用；fetch 可注入）
// ---------------------------------------------------------------------------

export interface OtlpExporterOptions {
	/** OTLP/HTTP JSON 接收端点（如 http://collector:4318/v1/traces）。 */
	endpoint: string;
	/** 注入 fetch 执行器（测试离屏）；缺省全局 fetch。 */
	fetchImpl?: FetchExecutor;
	/** 附加请求头（如鉴权；由调用方显式提供）。 */
	headers?: Record<string, string>;
	/** 单次 POST 超时（毫秒）；缺省 10000。 */
	timeoutMs?: number;
	/** 批大小：pending 达到即自动 flush；缺省 50。 */
	batchSize?: number;
	/** resource 属性 service.name；缺省 "bi-core"。 */
	serviceName?: string;
}

interface OtlpAnyValue {
	stringValue?: string;
	doubleValue?: number;
	boolValue?: boolean;
}

function toAnyValue(v: unknown): OtlpAnyValue {
	if (typeof v === "string") return { stringValue: v };
	if (typeof v === "number") return Number.isFinite(v) ? { doubleValue: v } : { stringValue: String(v) };
	if (typeof v === "boolean") return { boolValue: v };
	try {
		return { stringValue: JSON.stringify(v) ?? String(v) };
	} catch {
		return { stringValue: String(v) };
	}
}

function toUnixNano(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0";
	return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

function serializeOtlpSpan(span: TraceSpan): Record<string, unknown> {
	const out: Record<string, unknown> = {
		traceId: span.traceId,
		spanId: span.id,
		name: span.name,
		kind: 1, // SPAN_KIND_INTERNAL
		startTimeUnixNano: toUnixNano(span.startedAt),
		attributes: Object.entries(span.attrs).map(([key, value]) => ({
			key,
			value: toAnyValue(value),
		})),
		status: { code: span.status === "error" ? 2 : 1 },
	};
	if (span.parentId !== null) out["parentSpanId"] = span.parentId;
	if (span.endedAt !== null) out["endTimeUnixNano"] = toUnixNano(span.endedAt);
	if (span.statusMessage) out["status"] = { code: span.status === "error" ? 2 : 1, message: span.statusMessage };
	return out;
}

/**
 * OTLP/HTTP(JSON) POST 导出器：攒批发送，flush/单次失败吞错计数，
 * 永不拖垮 runtime。仅在被显式构造时才会出网。
 */
export class OtlpHttpExporter implements ExporterPort {
	private pending: TraceSpan[] = [];
	private dropped = 0;

	constructor(private readonly opts: OtlpExporterOptions) {
		if (opts.endpoint === "") throw new Error("OtlpHttpExporter 需要 endpoint");
	}

	export(span: TraceSpan): void {
		this.pending.push(span);
		if (this.pending.length >= (this.opts.batchSize ?? 50)) {
			void this.flush();
		}
	}

	get pendingCount(): number {
		return this.pending.length;
	}

	get droppedCount(): number {
		return this.dropped;
	}

	/** 发送当前批次；失败吞错并累计 dropped，返回是否全部发送成功。 */
	async flush(): Promise<boolean> {
		if (this.pending.length === 0) return true;
		const batch = this.pending;
		this.pending = [];
		try {
			await this.send(batch);
			return true;
		} catch {
			this.dropped += batch.length;
			return false;
		}
	}

	clearPending(): void {
		this.pending = [];
	}

	private async send(spans: TraceSpan[]): Promise<void> {
		const fetchImpl: FetchExecutor = this.opts.fetchImpl ?? ((input, init) => fetch(input, init));
		const timeoutMs = this.opts.timeoutMs ?? 10_000;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const body = {
			resourceSpans: [
				{
					resource: {
						attributes: [{ key: "service.name", value: { stringValue: this.opts.serviceName ?? "bi-core" } }],
					},
					scopeSpans: [
						{
							scope: { name: "bi.telemetry" },
							spans: spans.map(serializeOtlpSpan),
						},
					],
				},
			],
		};
		try {
			const res = await fetchImpl(this.opts.endpoint, {
				method: "POST",
				headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!res.ok) {
				void res.body?.cancel().catch(() => {});
				throw new Error(`OTLP HTTP ${res.status}`);
			}
		} finally {
			clearTimeout(timer);
		}
	}
}

// ---------------------------------------------------------------------------
// AgentExecutionTelemetryRuntime
// ---------------------------------------------------------------------------

/** runtime 选项。 */
export interface TelemetryRuntimeOptions {
	/** 主导出器（替换缺省 LocalBufferExporter）。 */
	exporter?: ExporterPort;
	/** 多导出器（优先于 exporter）。 */
	exporters?: readonly ExporterPort[];
	/** 采样率 0..1；缺省 1.0 全采。 */
	samplingRate?: number;
	/** 采样随机源（测试注入）；缺省 Math.random。 */
	rng?: () => number;
	/** 时钟（测试注入）；缺省 Date.now。 */
	now?: () => number;
	/** 缺省 LocalBufferExporter 的容量；缺省 500。 */
	bufferCapacity?: number;
	/** 端点脱敏函数注入；缺省 endpoint-sanitizer.sanitizeEndpoint。 */
	sanitizeEndpoint?: (url: string) => string;
	/** 错误文本脱敏函数注入；缺省 endpoint-sanitizer.sanitizeErrorPayload。 */
	sanitizeError?: (text: string) => string;
}

/** 端点类属性键（命中即脱敏）。 */
const ENDPOINT_ATTR_KEY = /(url|endpoint|uri|host|peer|server|address|origin)/i;

interface ActiveFrame {
	spanId: string;
	traceId: string;
	sampled: boolean;
}

/** Agent 执行遥测 runtime：内存 span 树 + 可插拔导出 + 采样 + 端点脱敏。 */
export class AgentExecutionTelemetryRuntime {
	private readonly exportersList: ExporterPort[];
	private readonly samplingRate: number;
	private readonly rng: () => number;
	private readonly now: () => number;
	private readonly sanitizeEndpointFn: (url: string) => string;
	private readonly sanitizeErrorFn: (text: string) => string;
	private readonly spanIndex = new Map<string, TraceSpan>();
	private readonly activeStack: ActiveFrame[] = [];
	private readonly sampledSpans = new WeakSet<TraceSpan>();
	private spanCounter = 0;
	private traceCounter = 0;
	private dropped = 0;

	constructor(options: TelemetryRuntimeOptions = {}) {
		if (options.exporters !== undefined) {
			this.exportersList = [...options.exporters];
		} else if (options.exporter !== undefined) {
			this.exportersList = [options.exporter];
		} else {
			this.exportersList = [new LocalBufferExporter(options.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY)];
		}
		const rate = options.samplingRate ?? 1;
		this.samplingRate = Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 1) : 1;
		this.rng = options.rng ?? Math.random;
		this.now = options.now ?? (() => Date.now());
		this.sanitizeEndpointFn = options.sanitizeEndpoint ?? defaultSanitizeEndpoint;
		this.sanitizeErrorFn = options.sanitizeError ?? defaultSanitizeError;
	}

	// ---- 导出器管理 ----

	get exporters(): readonly ExporterPort[] {
		return this.exportersList;
	}

	addExporter(e: ExporterPort): void {
		this.exportersList.push(e);
	}

	removeExporter(e: ExporterPort): boolean {
		const idx = this.exportersList.indexOf(e);
		if (idx < 0) return false;
		this.exportersList.splice(idx, 1);
		return true;
	}

	/** 导出失败（同步抛错/异步拒绝）累计次数。 */
	get droppedExports(): number {
		return this.dropped;
	}

	get spanCount(): number {
		return this.spanIndex.size;
	}

	// ---- span 生命周期 ----

	/**
	 * 开启 span：采样判定（父采样传播）→ attrs 端点脱敏 → 压入活跃栈。
	 * 未采样的 span 返回可 endSpan 的句柄，但不入树、不导出。
	 */
	startSpan(name: string, attrs?: Record<string, unknown>): TraceSpan {
		this.spanCounter++;
		const parent = this.activeStack[this.activeStack.length - 1];
		const sampled = parent !== undefined
			? parent.sampled && this.rng() < this.samplingRate
			: this.rng() < this.samplingRate;
		const traceId = parent !== undefined ? parent.traceId : this.nextTraceId();
		const span: TraceSpan = {
			id: this.nextSpanId(),
			traceId,
			parentId: parent !== undefined ? parent.spanId : null,
			name,
			attrs: this.sanitizeAttrs(attrs),
			startedAt: this.now(),
			endedAt: null,
			durationMs: null,
			status: "running",
		};
		if (sampled) {
			this.sampledSpans.add(span);
		}
		this.activeStack.push({ spanId: span.id, traceId, sampled });
		return span;
	}

	/**
	 * 结束 span：写 endedAt/duration/status，采样命中的 span 落树并派发导出。
	 * status="error" 时 message 走错误负载脱敏。
	 */
	endSpan(span: TraceSpan, status: Exclude<SpanStatus, "running">, message?: string): void {
		// 弹活跃栈（无论是否采样，栈帧都存在）
		const top = this.activeStack[this.activeStack.length - 1];
		if (top !== undefined && top.spanId === span.id) this.activeStack.pop();

		if (!this.sampledSpans.has(span)) return; // 未采样：不入树不导出
		if (span.endedAt !== null) return; // 幂等：重复 end 忽略
		span.endedAt = this.now();
		span.durationMs = Math.max(0, span.endedAt - span.startedAt);
		span.status = status;
		if (message !== undefined) {
			span.statusMessage = this.sanitizeErrorFn(message);
		}
		this.record(span);
	}

	/**
	 * 直接落树并派发导出（endSpan 内部亦走此路径）。
	 * exporter 同步抛错/异步拒绝均被隔离计数，绝不向上传播。
	 */
	record(span: TraceSpan): void {
		this.spanIndex.set(span.id, span);
		for (const ex of this.exportersList) {
			try {
				const r = ex.export(span);
				if (r instanceof Promise) {
					r.catch(() => {
						this.dropped++;
					});
				}
			} catch {
				this.dropped++;
			}
		}
	}

	/** 清空树与活跃栈（导出器由调用方自行管理）。 */
	reset(): void {
		this.spanIndex.clear();
		this.activeStack.length = 0;
	}

	// ---- 树访问 ----

	getSpan(id: string): TraceSpan | undefined {
		return this.spanIndex.get(id);
	}

	allSpans(): TraceSpan[] {
		return [...this.spanIndex.values()];
	}

	rootSpans(): TraceSpan[] {
		return this.allSpans().filter((s) => s.parentId === null);
	}

	childrenOf(id: string): TraceSpan[] {
		return this.allSpans().filter((s) => s.parentId === id);
	}

	// ---- 内部 ----

	private nextSpanId(): string {
		return this.spanCounter.toString(16).padStart(16, "0");
	}

	private nextTraceId(): string {
		this.traceCounter++;
		return this.traceCounter.toString(16).padStart(32, "0");
	}

	private sanitizeAttrs(attrs: Record<string, unknown> | undefined): Record<string, unknown> {
		if (attrs === undefined) return {};
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(attrs)) {
			if (typeof v === "string" && (ENDPOINT_ATTR_KEY.test(k) || /^https?:\/\//i.test(v))) {
				out[k] = this.sanitizeEndpointFn(v);
			} else {
				out[k] = v;
			}
		}
		return out;
	}
}
