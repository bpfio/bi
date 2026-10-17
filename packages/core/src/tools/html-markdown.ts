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
	| "para" // p / h1-h6（marker 为前缀标记，"" 即普通段落）
	| "list" // ul / ol
	| "item" // li
	| "quote" // blockquote
	| "pre" // pre（rawtext 捕获 → 围栏）
	| "table" // table（收口时渲染 GFM）
	| "row" // tr
	| "cell"; // td / th（行内捕获）

interface Frame {
	kind: FrameKind;
	/** para：行首标记（"# " / "## " / ""）；item："- " / "1. "。 */
	marker: string;
	/** item：续行缩进（与 marker 等宽空格）。 */
	indent: string;
	/** item：首行标记是否已消费。 */
	firstUsed: boolean;
	/** list：有序表下一个序号（支持 ol start 属性）。 */
	index: number;
	/** pre：围栏语言 + 原文捕获。 */
	lang: string;
	buf: string;
	/** table：行集合。 */
	rows: TableRow[];
	/** table：列对齐（来自表头单元格 align 属性）。 */
	aligns: Align[];
	/** row：行内容 + 是否表头。 */
	cells: string[];
	header: boolean;
	/** cell：colspan（容错：多出的列以空单元格补齐）。 */
	colspan: number;
	/** cell/th：列对齐属性。 */
	align: Align;
}

type Align = "" | "left" | "right" | "center";

interface TableRow {
	cells: string[];
	aligns: Align[];
	header: boolean;
}

/** 行内包裹栈项（strong/em/del/anchor 等成对标记）。 */
interface Wrap {
	/** 开标记（"**" / "*" / "~~" / "["）。 */
	marker: string;
	/** 开标记写入 lineBuf 时的位置（用于空内容回退）。 */
	pos: number;
	/** anchor 专用：闭合时要追加的 "](href)"。 */
	hrefSuffix: string;
}

/** 行内 code 捕获态。 */
interface CodeCapture {
	buf: string;
}

// TODO(impl): 实体表、tokenizer、渲染器、公共入口。
