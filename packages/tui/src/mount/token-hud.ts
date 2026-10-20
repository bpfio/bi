/**
 * BI-11 接线 —— TokenHud 状态跟踪：适配器 usage 读数 → 状态行 HUD 片段。
 *
 * 数据源（现成事件面）：deepseek-adapter 的 `usage` 流事件（StreamUsage：
 * inputTokens / outputTokens / cachedInputTokens / reasoningTokens）——TUI 会话
 * 回路逐事件消费本卡在同一点把读数喂进 TokenHud 门面（tui/src/hud.ts，器官零改动）。
 *
 * 语义（与 HUD 渲染契约对齐）：
 * - promptTokens = 最近一次 usage.inputTokens（请求侧提示词占用）；
 * - cacheHitRate = cachedInputTokens / inputTokens（两者齐备且 inputTokens > 0
 *   时才有；缺省则整段省略 Cache——TokenHud 渲染契约钉死）；
 * - 尚未收到 usage 读数 → HUD 片段为空串（状态行保持原样，绝不冒充 0/0）；
 * - maxTokens = 上下文窗口（会话装配面注入，缺省 DEFAULT_CONTEXT_TOKENS）。
 */

import { TokenHud, type TokenHudState } from "../hud";
import type { StreamUsage } from "../../../core/src/adapters/deepseek-adapter";

/** 缺省上下文窗口（HUD 分母；宿主可按模型 context_limit 覆盖）。 */
export const DEFAULT_CONTEXT_TOKENS = 128_000;

/** usage 读数跟踪器：喂 usage 事件，出状态行 HUD 片段。 */
export class TokenHudTracker {
	readonly #hud = new TokenHud();
	readonly #maxTokens: number;
	#promptTokens = 0;
	#cacheHitRate: number | undefined;
	#hasReading = false;

	constructor(maxTokens: number = DEFAULT_CONTEXT_TOKENS) {
		this.#maxTokens = maxTokens > 0 ? maxTokens : DEFAULT_CONTEXT_TOKENS;
	}

	/** 喂一次适配器 usage 读数（无 inputTokens 的读数忽略，保留上一次读数）。 */
	update(usage: StreamUsage): void {
		const input = usage.inputTokens;
		if (input === undefined) return;
		this.#hasReading = true;
		this.#promptTokens = input;
		const cached = usage.cachedInputTokens;
		this.#cacheHitRate = cached !== undefined && input > 0 ? cached / input : undefined;
	}

	/** 是否已收到 usage 读数（无读数则状态行不挂 HUD 段）。 */
	get hasReading(): boolean {
		return this.#hasReading;
	}

	/** 当前 HUD 状态（断言/复用面）。 */
	get state(): TokenHudState {
		return {
			promptTokens: this.#promptTokens,
			maxTokens: this.#maxTokens,
			...(this.#cacheHitRate !== undefined ? { cacheHitRate: this.#cacheHitRate } : {}),
		};
	}

	/** 状态行 HUD 片段（无读数 = 空串；渲染单一来源）。 */
	get line(): string {
		return this.#hasReading ? this.#hud.render(this.state) : "";
	}
}
