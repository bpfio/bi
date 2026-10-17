/**
 * BI-07.12 —— 高性能流式 HTML → Markdown 抽取引擎（合约级重实现）。
 *
 * 设计铁律：
 * - 零外部 npm 依赖：内置 htmlparser2 语义的手写 SAX 状态机（单遍扫描，O(n)）。
 * - 零浏览器依赖：纯字符串状态机，非 DOM；不触碰 document/Blob/Buffer。
 * - 字符切分安全：全程以 UTF-16 码元为索引推进，代理对只在完整码元边界上
 *   切片/解码（fromCodePoint 输出完整代理对），绝不按字节切断多字节字符。
 * - 硬内存预算：累计输出超过 maxBytes（默认 5MiB，以 UTF-16 码元近似字节计量）
 *   即截断并产生 warning，绝不抛异常炸掉调用方。
 *
 * 模块分两层：
 * 1. tokenizeSax —— 手写 SAX 词法状态机：开标签/闭标签/属性（三种引号态）/
 *   文本/注释/doctype；script|style|noscript 进入 rawtext 整块吞噬（事件级剥离）。
 * 2. renderMarkdown —— 块级上下文栈渲染器：块级映射（标题/段落/列表/引用/
 *   围栏代码/GFM 表格）+ 行内映射（粗斜/删除/行内码/链接/图片/换行）。
 */

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** htmlToMarkdown 选项。 */
export interface HtmlToMarkdownOptions {
	/**
	 * 累计输出硬内存预算（以 UTF-16 码元数近似 UTF-8 字节计量）。
	 * 超出后立即停止解析：已产出内容截断返回 + 追加 warning，不抛错。
	 * 缺省 5 MiB（5 * 1024 * 1024）。
	 */
	maxBytes?: number;
	/**
	 * 额外整树剥离的标签名（小写）。用于上层抽取器主内容降噪
	 * （如 nav/footer/aside），缺省仅剥离 head/title/svg/template 等。
	 */
	dropTags?: readonly string[];
}

/** htmlToMarkdown 结果。 */
export interface HtmlToMarkdownResult {
	/** 转换后的 Markdown 文本（永不为 undefined；空输入得空串）。 */
	markdown: string;
	/** 非致命告警（预算截断、畸形容错说明等）；正常转换为空数组。 */
	warnings: string[];
}

/** 输出预算缺省值：5 MiB。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

/** SAX 事件接收器（渲染器实现）。 */
interface SaxHandlers {
	onOpenTag(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
	onCloseTag(name: string): void;
	onText(text: string): void;
	onComment(text: string): void;
}

/** 渲染器块级上下文帧种类。 */
type FrameKind =
	| "root" // 文档根，永不出栈
	| "para" // p / h1-h6 / div 等段落容器（marker 为前缀标记，"" 即普通段落）
	| "list" // ul / ol
	| "item" // li
	| "quote" // blockquote
	| "pre" // pre（原文捕获 → 围栏）
	| "table" // table（收口时渲染 GFM）
	| "row" // tr
	| "cell"; // td / th（行内捕获）

interface Frame {
	kind: FrameKind;
	/** 产生本帧的标签名（小写），用于隐式收口的同类判定。 */
	tag: string;
	/** para：行首标记（"# " / "## " / ""）；item："- " / "1. "。 */
	marker: string;
	/** item：续行缩进（与 marker 等宽空格）。 */
	indent: string;
	/** list：有序表下一个序号（支持 ol start 属性）。 */
	index: number;
	/** list：是否有序。 */
	ordered: boolean;
	/** pre：围栏语言（pre 自身 class 或内部 code class）。 */
	lang: string;
	/** 块级帧：累计行（空串行 = 段内硬换行）。 */
	lines: string[];
	/** pre：原文捕获（不折叠空白）。 */
	raw: string;
	/** table：行集合。 */
	rows: TableRow[];
	/** row：单元格集合（cell 收口时逐列推入）。 */
	cells: string[];
	/** row：各列对齐（与 cells 等长）。 */
	aligns: Align[];
	/** cell：是否表头单元格（th）。 */
	header: boolean;
	/** cell：colspan（容错：多出的列以空单元格补齐，上限 16）。 */
	colspan: number;
	/** cell：列对齐属性。 */
	align: Align;
}

interface TableRow {
	cells: string[];
	aligns: Align[];
	header: boolean;
}

type Align = "" | "left" | "right" | "center";

/** 行内包裹栈项（strong/em/del/anchor 等成对标记）。 */
interface Wrap {
	/** 开标记（"**" / "*" / "~~" / "["）；空串 = 透明包裹（无 href 锚点）。 */
	marker: string;
	/** 开标记写入 lineBuf 时的位置（用于空内容回退与内容重写）。 */
	pos: number;
	/** 闭合时要追加的尾巴（"**" / "](href)"）。 */
	suffix: string;
}

/** 行内 code 捕获态。 */
interface CodeCapture {
	buf: string;
}

/** 元素栈项：帧/包裹/捕获/skip 之一（可组合）。 */
interface OpenEl {
	name: string;
	/** skip 子树：内容整体丢弃（head/title/svg/…）。 */
	skip?: boolean;
	wrap?: Wrap;
	code?: CodeCapture;
	frame?: Frame;
}

// ---------------------------------------------------------------------------
// 常量表
// ---------------------------------------------------------------------------

/** HTML void 元素（无闭合标签）。 */
const VOID_TAGS = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
	"param", "source", "track", "wbr",
]);

/** rawtext 元素：内容整块吞噬（事件级剥离，永不进入渲染器文本事件）。 */
const RAWTEXT_TAGS = new Set(["script", "style", "noscript"]);

/** 渲染器基底 skip 集合（子树丢弃）。 */
const BASE_SKIP_TAGS = new Set([
	"head", "title", "template", "svg", "math", "iframe",
	"select", "datalist", "option", "textarea", "object",
]);

/** 块级标签（开标签需打断当前行内上下文）。 */
const BLOCK_TAGS = new Set([
	"address", "article", "aside", "blockquote", "body", "caption", "center",
	"dd", "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption",
	"figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
	"hgroup", "html", "legend", "li", "main", "menu", "nav", "ol", "p", "pre",
	"section", "summary", "table", "tbody", "tfoot", "thead", "tr", "td", "th", "ul",
]);

const HEADING_MARKERS: Record<string, string> = {
	h1: "# ", h2: "## ", h3: "### ", h4: "#### ", h5: "##### ", h6: "###### ",
};

/**
 * 隐式收口（HTML implied end tags）：块级开标签前，自栈顶向下收口满足判定的帧。
 * 关键：p/h1-h6 同类互斥可收口；div/section 等容器帧合法嵌套 p，不可被 p 拆开。
 */
const PARA_SIBLING_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);

function closableFor(tag: string): (f: Frame) => boolean {
	const paraSibling = (f: Frame): boolean =>
		f.kind === "para" && PARA_SIBLING_TAGS.has(f.tag);
	switch (tag) {
		case "li":
			return (f) => f.kind === "item" || paraSibling(f);
		case "td":
		case "th":
			return (f) => f.kind === "cell" || paraSibling(f);
		case "tr":
			return (f) => f.kind === "row" || f.kind === "cell" || paraSibling(f);
		default:
			// p/h*/div/section/ul/ol/table/blockquote/pre/hr/…：只收口同类段落
			return paraSibling;
	}
}

/** 行内文本可落帧的块种类（list 收纳 li 间隙散文本）。 */
const INLINE_ACCEPT = new Set<FrameKind>(["root", "para", "item", "cell", "quote", "list"]);

/** 预算超限哨兵：仅在渲染管线内部抛/接，绝不外泄。 */
const BUDGET_EXCEEDED = Symbol("bi.html-markdown.budget-exceeded");

// ---------------------------------------------------------------------------
// 实体表与解码
// ---------------------------------------------------------------------------

/** 常用命名实体表（覆盖研报/公文高频子集，未收录实体原样保留）。 */
const ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
	nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍",
	copy: "©", reg: "®", trade: "™",
	mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’",
	ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•", middot: "·",
	deg: "°", plusmn: "±", times: "×", divide: "÷", minus: "−", frac12: "½",
	frac14: "¼", frac34: "¾", sup1: "¹", sup2: "²", sup3: "³", micro: "µ",
	para: "¶", sect: "§", dagger: "†", Dagger: "‡", permil: "‰",
	euro: "€", pound: "£", yen: "¥", cent: "¢", curren: "¤",
	larr: "←", uarr: "↑", rarr: "→", darr: "↓", harr: "↔",
	lowast: "∗", radic: "√", infin: "∞", ang: "∠",
	and: "∧", or: "∨", cap: "∩", cup: "∪", int: "∫", there4: "∴",
	sim: "∼", cong: "≅", asymp: "≈", ne: "≠", equiv: "≡", le: "≤", ge: "≥",
	sub: "⊂", sup: "⊃", sube: "⊆", supe: "⊇", oplus: "⊕", otimes: "⊗",
	perp: "⊥", sdot: "⋅",
	alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ",
	eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν",
	xi: "ξ", omicron: "ο", pi: "π", rho: "ρ", sigma: "σ", tau: "τ",
	upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
	Alpha: "Α", Beta: "Β", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
	Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
	aacute: "á", agrave: "à", acirc: "â", aring: "å", auml: "ä", ccedil: "ç",
	eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", iacute: "í", igrave: "ì",
	icirc: "î", iuml: "ï", ntilde: "ñ", oacute: "ó", ograve: "ò", ocirc: "ô",
	ouml: "ö", uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü", yacute: "ý",
	oslash: "ø", szlig: "ß", Aacute: "Á", Agrave: "À", Ccedil: "Ç", Eacute: "É",
	Ntilde: "Ñ", Ouml: "Ö", Uuml: "Ü",
};

/**
 * 解码 HTML 实体（命名 + 十进制/十六进制数字）。
 * 未识别实体原样保留；数字引用拒绝越界码点；
 * 代理对安全：拆写成两个数字引用的高低代理自动合并，孤立代理以 U+FFFD 兜底。
 */
export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	let out = "";
	let pendingHi = -1;
	const flushHi = (): void => {
		if (pendingHi >= 0) {
			out += "�";
			pendingHi = -1;
		}
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (ch !== "&") {
			flushHi();
			out += ch;
			continue;
		}
		const semi = text.indexOf(";", i + 1);
		if (semi < 0 || semi - i > 12) {
			out += ch;
			continue;
		}
		const body = text.slice(i + 1, semi);
		let decoded: string | null = null;
		if (body[0] === "#") {
			const num = body[1] === "x" || body[1] === "X"
				? Number.parseInt(body.slice(2), 16)
				: Number.parseInt(body.slice(1), 10);
			if (Number.isInteger(num) && num >= 0 && num <= 0x10ffff) {
				decoded = String.fromCodePoint(num);
			}
		} else {
			const named = ENTITIES[body];
			if (named !== undefined) decoded = named;
		}
		if (decoded === null) {
			out += ch;
			continue;
		}
		i = semi;
		const cu = decoded.codePointAt(0)!;
		if (cu >= 0xd800 && cu <= 0xdbff && decoded.length === 1) {
			flushHi();
			pendingHi = cu;
			continue;
		}
		if (cu >= 0xdc00 && cu <= 0xdfff && decoded.length === 1 && pendingHi >= 0) {
			out += String.fromCodePoint(0x10000 + ((pendingHi - 0xd800) << 10) + (cu - 0xdc00));
			pendingHi = -1;
			continue;
		}
		flushHi();
		out += decoded;
	}
	flushHi();
	return out;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isWhitespace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/** 从 class 属性提取围栏语言（language-x / lang-x）。 */
function langFromClass(cls: string): string {
	const m = cls.match(/(?:^|\s)(?:language|lang)-([A-Za-z0-9_#+.-]+)/);
	return m ? m[1]! : "";
}

/** 从 align 属性 / style 片段解析列对齐。 */
function parseAlign(spec: string): Align {
	const s = spec.toLowerCase();
	if (s.includes("center")) return "center";
	if (s.includes("right")) return "right";
	if (s.includes("left")) return "left";
	return "";
}

/** 行内 code → 反引号 span；内容含反引号时按 CommonMark 加长围栏。 */
function codeSpan(content: string): string {
	const runs = content.match(/`+/g);
	const maxRun = runs ? Math.max(...runs.map((r) => r.length)) : 0;
	const fence = "`".repeat(maxRun + 1);
	const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return fence + pad + content + pad + fence;
}

// ---------------------------------------------------------------------------
// 第一层：手写 SAX 词法状态机
// ---------------------------------------------------------------------------

/** 在 from 之后寻找 `</tag`（大小写不敏感、仅整标签匹配）。 */
function findRawtextEnd(src: string, from: number, tag: string): { contentEnd: number; after: number } {
	const n = src.length;
	let i = from;
	while (i < n) {
		const lt = src.indexOf("</", i);
		if (lt < 0) return { contentEnd: n, after: n };
		let k = lt + 2;
		let m = 0;
		while (m < tag.length && k + m < n && src[k + m]!.toLowerCase() === tag[m]!) m++;
		if (m === tag.length) {
			const next = k + m < n ? src[k + m]! : ">";
			if (next === ">" || next === "/" || isWhitespace(next)) {
				const gt = src.indexOf(">", k + m);
				return { contentEnd: lt, after: gt < 0 ? n : gt + 1 };
			}
		}
		i = lt + 2;
	}
	return { contentEnd: n, after: n };
}

/** 单遍 SAX 扫描：文本/注释/doctype/开闭标签/属性三引号态/rawtext 吞噬。 */
function tokenizeSax(src: string, h: SaxHandlers): void {
	const n = src.length;
	let i = 0;
	while (i < n) {
		const lt = src.indexOf("<", i);
		if (lt < 0) {
			h.onText(src.slice(i));
			return;
		}
		if (lt > i) h.onText(src.slice(i, lt));
		if (src.startsWith("<!--", lt)) {
			const end = src.indexOf("-->", lt + 4);
			h.onComment(end < 0 ? src.slice(lt + 4) : src.slice(lt + 4, end));
			i = end < 0 ? n : end + 3;
			continue;
		}
		const c1 = src[lt + 1];
		if (c1 === "!" || c1 === "?") {
			// doctype / 处理指令 / CDATA 壳：跳到 '>'
			const end = src.indexOf(">", lt);
			i = end < 0 ? n : end + 1;
			continue;
		}
		if (c1 === "/") {
			const end = src.indexOf(">", lt);
			const name = end < 0 ? "" : src.slice(lt + 2, end).trim().toLowerCase();
			if (name) h.onCloseTag(name);
			i = end < 0 ? n : end + 1;
			continue;
		}
		// 开标签：标签名
		let j = lt + 1;
		let s = j;
		while (j < n && !isWhitespace(src[j]!) && src[j] !== "/" && src[j] !== ">") j++;
		const name = src.slice(s, j).toLowerCase();
		if (!name) {
			// '<' 后接非法字符：按字面文本容错
			h.onText("<");
			i = lt + 1;
			continue;
		}
		// 属性循环（双引号/单引号/无引号三态 + 裸属性）
		const attrs: Record<string, string> = {};
		let selfClosing = false;
		while (j < n) {
			while (j < n && isWhitespace(src[j]!)) j++;
			if (j >= n) break;
			const c = src[j]!;
			if (c === ">") {
				j++;
				break;
			}
			if (c === "/") {
				if (src[j + 1] === ">") {
					selfClosing = true;
					j += 2;
					break;
				}
				j++;
				continue;
			}
			s = j;
			while (j < n && !isWhitespace(src[j]!) && src[j] !== "=" && src[j] !== "/" && src[j] !== ">") j++;
			const aname = src.slice(s, j).toLowerCase();
			let k = j;
			while (k < n && isWhitespace(src[k]!)) k++;
			let aval = "";
			if (src[k] === "=") {
				k++;
				while (k < n && isWhitespace(src[k]!)) k++;
				const q = src[k];
				if (q === '"' || q === "'") {
					const e = src.indexOf(q, k + 1);
					aval = e < 0 ? src.slice(k + 1) : src.slice(k + 1, e);
					j = e < 0 ? n : e + 1;
				} else {
					s = k;
					while (k < n && !isWhitespace(src[k]!) && src[k] !== ">") k++;
					aval = src.slice(s, k);
					j = k;
				}
			} else {
				j = k;
			}
			if (aname) attrs[aname] = decodeEntities(aval);
		}
		h.onOpenTag(name, attrs, selfClosing);
		if (!selfClosing && RAWTEXT_TAGS.has(name)) {
			// rawtext 整块吞噬（script/style/noscript 事件级剥离）
			const end = findRawtextEnd(src, j, name);
			h.onCloseTag(name);
			i = end.after;
			continue;
		}
		i = j;
	}
}

// ---------------------------------------------------------------------------
// 第二层：块级上下文栈渲染器
// ---------------------------------------------------------------------------

function mkFrame(tag: string, kind: FrameKind, marker = ""): Frame {
	return {
		kind,
		tag,
		marker,
		indent: kind === "item" ? " ".repeat(marker.length) : "",
		index: 1,
		ordered: false,
		lang: "",
		lines: [],
		raw: "",
		rows: [],
		cells: [],
		aligns: [],
		header: false,
		colspan: 1,
		align: "",
	};
}

class Renderer implements SaxHandlers {
	readonly warnings: string[] = [];
	private readonly maxBytes: number;
	private readonly dropSet: ReadonlySet<string>;
	private readonly rootFrame: Frame = mkFrame("#document", "root");
	private readonly elStack: OpenEl[] = [{ name: "#document", frame: this.rootFrame }];
	private lineBuf = "";
	private pendingSpace = false;
	private budget = 0;
	private truncated = false;
	private finished = false;

	constructor(maxBytes: number, dropTags?: readonly string[]) {
		this.maxBytes = maxBytes;
		this.dropSet = dropTags && dropTags.length > 0
			? new Set([...BASE_SKIP_TAGS, ...dropTags])
			: BASE_SKIP_TAGS;
	}

	get markdown(): string {
		return this.rootFrame.lines.join("\n");
	}

	// ---- 预算 ----

	private out(chars: number): void {
		if (this.truncated || chars <= 0) return;
		this.budget += chars;
		if (this.budget > this.maxBytes) {
			this.truncated = true;
			throw BUDGET_EXCEEDED;
		}
	}

	// ---- 栈基元 ----

	private topFrame(): Frame {
		for (let i = this.elStack.length - 1; i >= 0; i--) {
			const f = this.elStack[i]!.frame;
			if (f) return f;
		}
		return this.rootFrame;
	}

	/** 自栈顶向下找第一个属于给定种类的帧（跳过中间包裹/普通项）。 */
	private closestFrame(kinds: ReadonlySet<FrameKind>): Frame | null {
		for (let i = this.elStack.length - 1; i >= 0; i--) {
			const f = this.elStack[i]!.frame;
			if (f && kinds.has(f.kind)) return f;
		}
		return null;
	}

	/** 行内内容落点：最近的行内可接纳帧。 */
	private inlineTarget(): Frame {
		return this.closestFrame(INLINE_ACCEPT) ?? this.rootFrame;
	}

	private skipDepth(): number {
		let d = 0;
		for (const el of this.elStack) if (el.skip) d++;
		return d;
	}

	private topIsPre(): boolean {
		return this.topFrame().kind === "pre";
	}

	private topCode(): CodeCapture | null {
		for (let i = this.elStack.length - 1; i >= 0; i--) {
			const el = this.elStack[i]!;
			if (el.frame) return null;
			if (el.code) return el.code;
		}
		return null;
	}

	// ---- 行内写入 ----

	private appendInline(s: string): void {
		if (s === "") return;
		this.out(s.length);
		if (this.lineBuf === "") {
			this.lineBuf += s;
		} else if ((this.pendingSpace || s.startsWith(" ")) && !this.lineBuf.endsWith(" ")) {
			this.lineBuf += " " + s;
		} else {
			this.lineBuf += s;
		}
		this.pendingSpace = false;
	}

	/** 收尾所有未闭合行内包裹/捕获（块级开闭前调用），LIFO 逐一解析。 */
	private resolveInlineTail(): void {
		for (let i = this.elStack.length - 1; i > 0; i--) {
			const el = this.elStack[i]!;
			if (el.frame || el.skip) break;
			if (el.wrap) {
				this.elStack.splice(i, 1);
				this.closeWrap(el.wrap);
			} else if (el.code) {
				this.elStack.splice(i, 1);
				this.closeCode(el.code);
			}
		}
	}

	private closeWrap(w: Wrap): void {
		// 内容区从 w.pos 起（marker 并未物理写入 lineBuf，重建时才落笔）
		const raw = w.pos <= this.lineBuf.length ? this.lineBuf.slice(w.pos) : "";
		const content = raw.trim();
		if (content === "") {
			// 空内容回退：摘除开标记
			this.lineBuf = this.lineBuf.slice(0, w.pos);
			return;
		}
		const tailHadSpace = /\s$/.test(raw);
		const leadHadSpace = /^\s/.test(raw);
		const prefix = this.lineBuf.slice(0, w.pos);
		const gap = leadHadSpace && prefix !== "" && !prefix.endsWith(" ") ? " " : "";
		this.lineBuf = prefix + gap + w.marker + content + w.suffix;
		if (tailHadSpace) this.pendingSpace = true;
		this.out(w.marker.length + w.suffix.length + gap.length);
	}

	private closeCode(cap: CodeCapture): void {
		const content = cap.buf.replace(/\s+/g, " ").trim();
		if (content === "") return;
		this.appendInline(codeSpan(content));
	}

	// ---- 行推送 ----

	private pushLines(f: Frame, lines: readonly string[], blank: boolean): void {
		if (lines.length === 0) return;
		this.out(lines.join("\n").length + (f.lines.length > 0 && blank ? 1 : 0));
		if (f.lines.length > 0 && blank) f.lines.push("");
		for (const l of lines) f.lines.push(l);
	}

	private flushLine(target?: Frame): void {
		this.resolveInlineTail();
		const line = this.lineBuf;
		this.lineBuf = "";
		this.pendingSpace = false;
		if (line.trim() === "") return;
		this.pushLines(target ?? this.inlineTarget(), [line], false);
	}

	// ---- 帧生命周期 ----

	/** 块级开标签的隐式收口（implied end tags + 行内残留清理）。 */
	private popFramesWhile(closable: (f: Frame) => boolean): void {
		for (;;) {
			const top = this.elStack[this.elStack.length - 1]!;
			if (top.name === "#document") return;
			if (!top.frame) {
				if (top.skip) return;
				// 透明容器/包裹/捕获：清掉继续向下看
				this.elStack.pop();
				if (top.wrap) this.closeWrap(top.wrap);
				else if (top.code) this.closeCode(top.code);
				continue;
			}
			if (closable(top.frame)) {
				this.elStack.pop();
				this.closeFrame(top.frame);
				continue;
			}
			return;
		}
	}

	private popAndResolve(): void {
		const el = this.elStack.pop()!;
		if (el.wrap) this.closeWrap(el.wrap);
		else if (el.code) this.closeCode(el.code);
		else if (el.frame) this.closeFrame(el.frame);
	}

	/** 帧收口：先收自身散文本（落回本帧），再渲染进父帧。 */
	private closeFrame(f: Frame): void {
		this.flushLine(f);
		const parent = this.closestFrame(
			new Set<FrameKind>(["root", "para", "item", "cell", "quote", "list", "table"]),
		) ?? this.rootFrame;
		switch (f.kind) {
			case "para": {
				const lines = f.lines.map((l) => l.trim());
				if (lines.every((l) => l === "")) return;
				const marked = f.marker
					? lines.map((l, idx) => (idx === 0 ? f.marker + l : l))
					: lines;
				this.pushLines(parent, marked, true);
				return;
			}
			case "item": {
				const lines = f.lines.map((l) => l.trim()).filter((l) => l !== "");
				if (lines.length === 0) {
					this.pushLines(parent, [f.marker.trimEnd() || "-"], false);
					return;
				}
				const rendered = lines.map((l, idx) => (idx === 0 ? f.marker + l : f.indent + l));
				this.pushLines(parent, rendered, false);
				return;
			}
			case "list": {
				if (f.lines.every((l) => l.trim() === "")) return;
				this.pushLines(parent, f.lines, parent.kind !== "item");
				return;
			}
			case "quote": {
				const lines = f.lines.map((l) => l.trim());
				if (lines.every((l) => l === "")) return;
				const quoted = lines.map((l) => (l === "" ? ">" : "> " + l));
				this.pushLines(parent, quoted, true);
				return;
			}
			case "pre": {
				const content = f.raw.replace(/\n+$/, "");
				if (content.trim() === "") return;
				const runs = content.match(/`{3,}/g);
				const maxRun = runs ? Math.max(...runs.map((r) => r.length)) : 0;
				const fence = "`".repeat(Math.max(3, maxRun + 1));
				this.pushLines(parent, [fence + f.lang, ...content.split("\n"), fence], true);
				return;
			}
			case "row": {
				const table = this.closestFrame(new Set<FrameKind>(["table"]));
				if (table && f.cells.length > 0) {
					table.rows.push({ cells: f.cells, aligns: f.aligns, header: f.header });
				}
				return;
			}
			case "cell": {
				const row = this.closestFrame(new Set<FrameKind>(["row", "table"]));
				if (!row) return;
				const content = f.lines.map((l) => l.trim()).filter((l) => l !== "").join(" ");
				if (row.kind === "row") {
					row.cells.push(content);
					row.aligns.push(f.align);
					row.header = row.header || f.header;
					for (let k = 1; k < f.colspan; k++) {
						row.cells.push("");
						row.aligns.push("");
					}
				} else {
					// 表下散置 td：合成单行
					const cells = [content];
					for (let k = 1; k < f.colspan; k++) cells.push("");
					row.rows.push({ cells, aligns: [f.align], header: f.header });
				}
				return;
			}
			case "table": {
				const capLines = f.lines.map((l) => l.trim()).filter((l) => l !== "");
				if (capLines.length > 0) this.pushLines(parent, capLines, true);
				this.renderGfmTable(f, parent);
				return;
			}
			default:
				return;
		}
	}

	private renderGfmTable(f: Frame, parent: Frame): void {
		const rows = f.rows;
		if (rows.length === 0) return;
		let colCount = 0;
		for (const r of rows) colCount = Math.max(colCount, r.cells.length);
		if (colCount === 0) return;
		const headerRow = rows[0]!;
		const aligns: Align[] = [];
		for (let c = 0; c < colCount; c++) aligns.push(headerRow.aligns[c] ?? "");
		const fmt = (cells: readonly string[]): string => {
			const parts: string[] = [];
			for (let c = 0; c < colCount; c++) parts.push((cells[c] ?? "").trim());
			return "| " + parts.join(" | ") + " |";
		};
		const sep =
			"| " +
			aligns
				.map((a) => (a === "right" ? "---:" : a === "center" ? ":---:" : a === "left" ? ":---" : "---"))
				.join(" | ") +
			" |";
		const outLines = [fmt(headerRow.cells), sep, ...rows.slice(1).map((r) => fmt(r.cells))];
		this.pushLines(parent, outLines, true);
	}

	// ---- SAX 事件 ----

	onOpenTag(name: string, attrs: Record<string, string>, selfClosing: boolean): void {
		if (this.skipDepth() > 0) {
			if (!VOID_TAGS.has(name) && !selfClosing) this.elStack.push({ name });
			return;
		}
		if (this.dropSet.has(name)) {
			if (!VOID_TAGS.has(name) && !selfClosing) {
				this.elStack.push({ name, skip: true });
			}
			return;
		}
		if (name === "br") {
			this.resolveInlineTail();
			this.pushLines(this.inlineTarget(), [this.lineBuf], false);
			this.lineBuf = "";
			this.pendingSpace = false;
			return;
		}
		if (name === "img") {
			const alt = attrs["alt"] ?? "";
			const src = attrs["src"] ?? "";
			this.appendInline("![" + alt + "](" + src + ")");
			return;
		}
		if (name === "hr") {
			this.resolveInlineTail();
			this.flushLine();
			this.pushLines(this.inlineTarget(), ["---"], true);
			return;
		}
		if (VOID_TAGS.has(name) || selfClosing) return;

		if (!BLOCK_TAGS.has(name)) {
			// 行内元素
			switch (name) {
				case "strong":
				case "b":
					this.elStack.push({ name, wrap: { marker: "**", pos: this.lineBuf.length, suffix: "**" } });
					return;
				case "em":
				case "i":
					this.elStack.push({ name, wrap: { marker: "*", pos: this.lineBuf.length, suffix: "*" } });
					return;
				case "del":
				case "s":
				case "strike":
					this.elStack.push({ name, wrap: { marker: "~~", pos: this.lineBuf.length, suffix: "~~" } });
					return;
				case "a": {
					const href = attrs["href"] ?? "";
					const wrap: Wrap = href
						? { marker: "[", pos: this.lineBuf.length, suffix: "](" + href + ")" }
						: { marker: "", pos: this.lineBuf.length, suffix: "" };
					this.elStack.push({ name, wrap });
					return;
				}
				case "code": {
					if (this.topIsPre()) {
						const lang = langFromClass(attrs["class"] ?? "");
						if (lang) this.topFrame().lang = lang;
						this.elStack.push({ name });
						return;
					}
					this.elStack.push({ name, code: { buf: "" } });
					return;
				}
				default:
					// span/u/mark/sub/sup/… 及未知行内标签：透明
					this.elStack.push({ name });
					return;
			}
		}

		// 块级元素：隐式收口 → 冲刷悬置行（如 li 内嵌列表前的散文本）→ 建帧
		this.popFramesWhile(closableFor(name));
		this.flushLine();
		switch (name) {
			case "p":
			case "h1":
			case "h2":
			case "h3":
			case "h4":
			case "h5":
			case "h6":
				this.elStack.push({ name, frame: mkFrame(name, "para", HEADING_MARKERS[name] ?? "") });
				return;
			case "ul":
			case "ol": {
				const f = mkFrame(name, "list");
				f.ordered = name === "ol";
				if (f.ordered) {
					const start = Number.parseInt(attrs["start"] ?? "", 10);
					f.index = Number.isFinite(start) ? start : 1;
				}
				this.elStack.push({ name, frame: f });
				return;
			}
			case "li": {
				const parent = this.topFrame();
				let marker = "- ";
				if (parent.kind === "list" && parent.ordered) marker = parent.index++ + ". ";
				this.elStack.push({ name, frame: mkFrame(name, "item", marker) });
				return;
			}
			case "blockquote":
				this.elStack.push({ name, frame: mkFrame(name, "quote") });
				return;
			case "pre": {
				const f = mkFrame(name, "pre");
				f.lang = langFromClass(attrs["class"] ?? "");
				this.elStack.push({ name, frame: f });
				return;
			}
			case "table":
				this.elStack.push({ name, frame: mkFrame(name, "table") });
				return;
			case "tr":
				this.elStack.push({ name, frame: mkFrame(name, "row") });
				return;
			case "td":
			case "th": {
				const f = mkFrame(name, "cell");
				f.header = name === "th";
				f.align = parseAlign(attrs["align"] ?? "") || parseAlign(attrs["style"] ?? "");
				const cs = Number.parseInt(attrs["colspan"] ?? "1", 10);
				f.colspan = Number.isFinite(cs) ? Math.min(Math.max(cs, 1), 16) : 1;
				this.elStack.push({ name, frame: f });
				return;
			}
			default:
				// div/section/body/… 段落容器
				this.elStack.push({ name, frame: mkFrame(name, "para") });
				return;
		}
	}

	onCloseTag(name: string): void {
		let idx = -1;
		for (let i = this.elStack.length - 1; i >= 1; i--) {
			if (this.elStack[i]!.name === name) {
				idx = i;
				break;
			}
		}
		if (idx < 0) return; // 无匹配开标签的散闭标签：容错忽略
		while (this.elStack.length > idx) this.popAndResolve();
	}

	onText(text: string): void {
		if (this.skipDepth() > 0) return;
		if (this.topIsPre()) {
			const decoded = decodeEntities(text);
			this.out(decoded.length);
			this.topFrame().raw += decoded;
			return;
		}
		const cap = this.topCode();
		if (cap) {
			this.out(text.length);
			cap.buf += decodeEntities(text);
			return;
		}
		const t = decodeEntities(text).replace(/\s+/g, " ");
		if (t === "") return;
		if (t.trim() === "") {
			if (this.lineBuf !== "") this.pendingSpace = true;
			return;
		}
		this.out(t.length);
		if (this.lineBuf === "") {
			this.lineBuf += t.replace(/^ +/, "");
		} else if (this.pendingSpace || t.startsWith(" ")) {
			if (!this.lineBuf.endsWith(" ")) this.lineBuf += " ";
			this.lineBuf += t.replace(/^ +/, "");
		} else {
			this.lineBuf += t;
		}
		this.pendingSpace = false;
	}

	onComment(_text: string): void {
		// 注释整体丢弃
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		while (this.elStack.length > 1) this.popAndResolve();
		this.flushLine();
	}
}

// ---------------------------------------------------------------------------
// 公共入口
// ---------------------------------------------------------------------------

/**
 * 流式 HTML → GitHub-flavored Markdown 转换。
 * 永不抛错（预算超限截断并以 warning 说明）；空输入得空串。
 */
export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions = {}): HtmlToMarkdownResult {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const renderer = new Renderer(maxBytes, options.dropTags);
	try {
		tokenizeSax(html, renderer);
		renderer.finish();
	} catch (e) {
		if (e === BUDGET_EXCEEDED) {
			renderer.warnings.push(
				"输出预算已达上限 " + maxBytes + " 码元，转换提前终止，输出已截断。",
			);
			renderer.finish();
		} else {
			throw e;
		}
	}
	return { markdown: renderer.markdown, warnings: renderer.warnings };
}
