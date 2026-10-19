/**
 * transcript-search —— BI-19.1-search 转录内搜索（快赢提案 A 实现单）。
 *
 * 吸收机制（仅阅读锚点，bi 侧重实现；不引新依赖）：
 * - kimi alt-screen-search.ts 的 buildSearchCorpus(:34-106) → 本文件
 *   buildSearchCorpus + stripAnsi（语料构建与 ANSI 剥离）；
 * - findSearchCorpusMatches(:116-148) → 本文件 findSearchCorpusMatches（正则
 *   命中，giu 标志、零宽保护）；
 * - AltScreenSearchIndex(:156-184) → 本文件 TranscriptSearchIndex（源行/查询
 *   不变时复用语料与命中，增量缓存）。
 *
 * 全部为纯函数 / 纯状态机，零 TTY 依赖，可离屏单测（transcript-search.test.ts）。
 * UI 钩子（搜索条 overlay + 按键路由）落 agent-tui.ts，本文件不触渲染面。
 */

/** 单个命中：源行索引（0 基，对齐传入语料行序）+ 显示列区间（左闭右开）。 */
export interface SearchMatch {
	readonly row: number;
	readonly startCol: number;
	readonly endCol: number;
}

/** 可搜索语料：逐行 ANSI 剥离后的纯文本。 */
export interface SearchCorpus {
	readonly lines: readonly string[];
}

/**
 * 剥离 ANSI/终端转义序列，仅保留可见文本。覆盖：CSI/SGR（ESC[…m）、OSC
 * （ESC]…ST）、字符集选择（ESC(0 等）、终端模式切换（ESC=/>）、其余 C0 控制
 * 字节。用于把渲染后的转录行还原为可搜索文本面。
 */
export function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI ... final byte
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC ... BEL/ST
		.replace(/\x1b[()][AB0-2]/g, "") // 字符集选择
		.replace(/\x1b[>=]/g, "") // 终端模式切换
		.replace(/[\x00-\x08\x0b-\x1f]/g, ""); // 其余 C0 控制字节
}

/** 查询归一化：连续空白折叠为单空格并去两端。 */
export function normalizeQuery(query: string): string {
	return query.replace(/\s+/gu, " ").trim();
}

/** 正则特殊字符转义。 */
export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 由转录原始行构建语料（逐行剥离 ANSI）。 */
export function buildSearchCorpus(lines: readonly string[]): SearchCorpus {
	return { lines: lines.map((line) => stripAnsi(line)) };
}

/**
 * 在语料上按字面查询做正则查找（giu 标志，大小写不敏感、Unicode）。不跨行——
 * 转录内搜索多为行内定位，逐行匹配使命中→(row,col) 映射确定且零宽安全。
 * 返回空查询或空语料时回吐空数组。
 */
export function findSearchCorpusMatches(corpus: SearchCorpus, query: string): SearchMatch[] {
	const normalized = normalizeQuery(query);
	if (!normalized) return [];
	const expression = new RegExp(escapeRegExp(normalized), "giu");
	const matches: SearchMatch[] = [];
	for (let row = 0; row < corpus.lines.length; row++) {
		const line = corpus.lines[row]!;
		expression.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = expression.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			matches.push({ row, startCol: start, endCol: end });
			if (match[0].length === 0) expression.lastIndex++; // 防零宽死循环
		}
	}
	return matches;
}

/**
 * 增量缓存：源行引用或归一化查询不变时复用语料与命中结果，避免逐键重建。
 * search() 回吐 { matches, changed }——changed 供调用方判定是否需重绘命中高亮。
 */
export class TranscriptSearchIndex {
	#sourceLines: readonly string[] | undefined;
	#corpus: SearchCorpus | undefined;
	#query: string | undefined;
	#matches: SearchMatch[] = [];

	search(lines: readonly string[], query: string): { matches: SearchMatch[]; changed: boolean } {
		let sourceChanged = this.#sourceLines?.length !== lines.length;
		if (!sourceChanged && this.#sourceLines) {
			for (let index = 0; index < lines.length; index++) {
				if (this.#sourceLines[index] !== lines[index]) {
					sourceChanged = true;
					break;
				}
			}
		}
		if (sourceChanged || !this.#corpus) {
			this.#sourceLines = Array.from(lines);
			this.#corpus = buildSearchCorpus(lines);
		}
		const normalized = normalizeQuery(query);
		const queryChanged = normalized !== this.#query;
		if (queryChanged) {
			this.#query = normalized;
			this.#matches = findSearchCorpusMatches(this.#corpus, normalized);
		}
		return { matches: this.#matches, changed: sourceChanged || queryChanged };
	}
}

/**
 * 搜索会话控制器（纯状态机，零 TTY）：开合 / 查询 / next·prev 循环。
 * 命中高亮与转录滚回由 agent-tui.ts 消费 currentMatch + matchCount 实现。
 */
export class TranscriptSearch {
	#active = false;
	#query = "";
	#matches: SearchMatch[] = [];
	#index = -1;
	readonly #cache = new TranscriptSearchIndex();

	/** 是否处于搜索激活态（搜索条可见、按键被拦截）。 */
	get active(): boolean {
		return this.#active;
	}

	/** 当前查询串（实时回显）。 */
	get query(): string {
		return this.#query;
	}

	/** 命中总数。 */
	get matchCount(): number {
		return this.#matches.length;
	}

	/** 当前选中命中下标（-1 = 无命中）。 */
	get currentIndex(): number {
		return this.#index;
	}

	/** 当前选中命中（无则 undefined）。 */
	get currentMatch(): SearchMatch | undefined {
		return this.#index >= 0 ? this.#matches[this.#index] : undefined;
	}

	/** 打开搜索条：清空既有查询与命中，进入激活态。 */
	open(): void {
		this.#active = true;
		this.#query = "";
		this.#matches = [];
		this.#index = -1;
	}

	/**
	 * 关闭：清零查询、命中与下标，退出激活态。转录复原（滚回偏移复位）由
	 * 调用方（agent-tui 按键路由）在 Esc/close 时负责——纯控制器不持渲染面。
	 */
	close(): void {
		this.#active = false;
		this.#query = "";
		this.#matches = [];
		this.#index = -1;
	}

	/**
	 * 设置查询并重算命中；选中首个命中（无命中则下标 -1）。语料经增量缓存，
	 * 仅当源行或归一化查询变化时才重建/重算。
	 */
	setQuery(lines: readonly string[], query: string): void {
		this.#query = query;
		const { matches } = this.#cache.search(lines, query);
		this.#matches = matches;
		this.#index = matches.length > 0 ? 0 : -1;
	}

	/** 下一命中（wrap-around；无命中 no-op）。 */
	next(): void {
		if (this.#matches.length === 0) return;
		this.#index = (this.#index + 1) % this.#matches.length;
	}

	/** 上一命中（wrap-around；无命中 no-op）。 */
	prev(): void {
		if (this.#matches.length === 0) return;
		this.#index = (this.#index - 1 + this.#matches.length) % this.#matches.length;
	}
}
