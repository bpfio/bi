/**
 * BI-07.12 —— 网页主内容抽取器（web-extractor）。
 *
 * 以 html-markdown 流式引擎为底座，提供无 DOM 的主内容降噪抽取：
 * 1. extractTitle —— 提取 <title> 文本（实体解码，无 <title> 时返回空串）。
 * 2. extractReadable —— 先剥离页面镀铬（nav/header/footer/aside/form 等整树），
 *    再走 htmlToMarkdown 输出主内容 Markdown；预算沿用 5MiB 硬上限。
 */
import { decodeEntities, htmlToMarkdown } from "./html-markdown";

/** 页面镀铬标签：主内容抽取时整树剥离。 */
const CHROME_TAGS: readonly string[] = [
	"nav", "aside", "footer", "header", "form", "button",
	"script", "style", "noscript", "svg", "template", "iframe",
];

/** 无 DOM 提取 <title> 文本（实体解码 + 空白折叠）。 */
export function extractTitle(html: string): string {
	const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!m) return "";
	return decodeEntities(m[1]!.replace(/\s+/g, " ").trim());
}

export interface ExtractReadableOptions {
	/** 透传 htmlToMarkdown 输出预算（缺省 5 MiB）。 */
	maxBytes?: number;
	/** 在镀铬标签之上追加整树剥离的标签。 */
	extraDropTags?: readonly string[];
}

export interface ReadableResult {
	/** 页面 <title>（无则为空串）。 */
	title: string;
	/** 主内容 Markdown。 */
	markdown: string;
	/** 非致命告警（预算截断等）。 */
	warnings: string[];
}

/** 主内容 Markdown 抽取：镀铬剥离 → htmlToMarkdown。 */
export function extractReadable(html: string, options: ExtractReadableOptions = {}): ReadableResult {
	const title = extractTitle(html);
	const dropTags = options.extraDropTags
		? [...CHROME_TAGS, ...options.extraDropTags]
		: CHROME_TAGS;
	const result = htmlToMarkdown(html, { maxBytes: options.maxBytes, dropTags });
	return { title, markdown: result.markdown, warnings: result.warnings };
}
