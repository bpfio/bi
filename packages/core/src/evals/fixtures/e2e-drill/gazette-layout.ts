/**
 * BI-21 工位 H 演练夹具 —— 双栏公报版面 JSON 生成器(pdf_extract.py 的输入)。
 *
 * 内置真实公报版面结构:
 * - 页眉带(y1 ≤ header_ratio×页高)与页脚带(y0 ≥ footer_ratio×页高)噪声 + 页码块;
 * - 通栏块:红头大标题 / 文号 / 指标导语(块宽 > 页宽÷栏数×90%);
 * - 左右双栏正文块:中心 x 分别落在第 0 / 第 1 等分。
 * 期望阅读序:通栏(按 y0)→ 左栏自上而下 → 右栏自上而下,指标数字逐字保真。
 */

import { GAZETTE_META, GAZETTE_INDICATORS } from "./drill-data";

/** 版面块(pdftotext -bbox 惯例:左上原点,y 向下增长)。 */
export interface LayoutBlock {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	text: string;
}

/** 单页版面。 */
export interface LayoutPage {
	page: number;
	width: number;
	height: number;
	blocks: LayoutBlock[];
}

/** 页面几何:A4 高分辨率近似(页宽 840 / 页高 1188)。 */
export const PAGE_WIDTH = 840;
export const PAGE_HEIGHT = 1188;

const g = GAZETTE_INDICATORS;
const gdpText = `${g.gdp.label} ${g.gdp.current} 亿元,同比增长 ${g.gdp.growthPct}%`;
const retailText = `${g.retail.label} ${g.retail.current} 亿元,同比增长 ${g.retail.growthPct}%`;

/** 构造单页双栏公报版面(页眉/页脚/页码噪声 + 通栏 + 双栏)。 */
export function buildGazetteLayout(): { pages: LayoutPage[] } {
	const blocks: LayoutBlock[] = [
		// —— 页眉带(y1 ≤ 0.06×1188 = 71.28)应被剥离 ——
		{ x0: 60, y0: 20, y1: 44, x1: 420, text: "国家统计局公报" },
		// —— 通栏块(宽 > 378):红头大标题 / 文号 / 指标导语 ——
		{ x0: 120, y0: 100, y1: 144, x1: 720, text: GAZETTE_META.title },
		{ x0: 200, y0: 156, y1: 186, x1: 640, text: GAZETTE_META.docNumber },
		{
			x0: 120,
			y0: 200,
			y1: 252,
			x1: 720,
			text: `主要指标:${gdpText};${retailText}。`,
		},
		// —— 左栏(中心 x < 420)自上而下 ——
		{ x0: 60, y0: 280, y1: 312, x1: 360, text: "一、总体运行平稳" },
		{
			x0: 60,
			y0: 324,
			y1: 420,
			x1: 372,
			text: `初步核算,前三季度${gdpText}。分产业看,生产供给稳步增加。`,
		},
		{ x0: 60, y0: 432, y1: 464, x1: 360, text: "二、工业生产加快" },
		{
			x0: 60,
			y0: 476,
			y1: 560,
			x1: 372,
			text: `全国${g.industry.label}同比增长 ${g.industry.growthPct}%,装备制造业增长较快。`,
		},
		// —— 右栏(中心 x ≥ 420)自上而下 ——
		{ x0: 470, y0: 280, y1: 312, x1: 770, text: "三、市场销售回暖" },
		{
			x0: 470,
			y0: 324,
			y1: 420,
			x1: 782,
			text: `${retailText}。消费对经济增长的拉动稳步增强。`,
		},
		{ x0: 470, y0: 432, y1: 464, x1: 770, text: "四、投资结构优化" },
		{
			x0: 470,
			y0: 476,
			y1: 560,
			x1: 782,
			text: `${g.investment.label}(不含农户)同比增长 ${g.investment.growthPct}%,高技术产业投资较快增长。`,
		},
		// —— 页脚带(y0 ≥ 0.94×1188 = 1116.7)与页码块应被剥离 ——
		{ x0: 60, y0: 1128, y1: 1152, x1: 500, text: "国家统计局版权所有" },
		{ x0: 404, y0: 1120, y1: 1146, x1: 436, text: "3" },
	];
	return {
		pages: [{ page: 1, width: PAGE_WIDTH, height: PAGE_HEIGHT, blocks }],
	};
}

/** 期望的阅读序全文(通栏 → 左栏 → 右栏,逐行;用于 0 误差顺序断言)。 */
export function expectedReadingOrderLines(): string[] {
	const layout = buildGazetteLayout().pages[0]!.blocks;
	// 与 pdf_extract.py 同构的期望序:先通栏(y0 升序),再左右栏各自 y0 升序。
	const HEADER_LINE = PAGE_HEIGHT * 0.06;
	const FOOTER_LINE = PAGE_HEIGHT * 0.94;
	const PAGE_NO = /^(\d+|\d+\s*[-—–]\s*\d+|第\s*\d+\s*页|\d+\s*\/\s*\d+)$/;
	const kept = layout.filter((b) => {
		if (b.y1 <= HEADER_LINE || b.y0 >= FOOTER_LINE) return false;
		return !PAGE_NO.test(b.text.trim());
	});
	const colWidth = PAGE_WIDTH / 2;
	const spanning = kept
		.filter((b) => b.x1 - b.x0 > colWidth * 0.9)
		.sort((a, b) => a.y0 - b.y0);
	const left = kept
		.filter((b) => b.x1 - b.x0 <= colWidth * 0.9 && (b.x0 + b.x1) / 2 < colWidth)
		.sort((a, b) => a.y0 - b.y0);
	const right = kept
		.filter((b) => b.x1 - b.x0 <= colWidth * 0.9 && (b.x0 + b.x1) / 2 >= colWidth)
		.sort((a, b) => a.y0 - b.y0);
	return [...spanning, ...left, ...right].map((b) => b.text.trim());
}
