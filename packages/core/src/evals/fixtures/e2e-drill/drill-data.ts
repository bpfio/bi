/**
 * BI-21 工位 H 终局演练 —— 全链路单一数字源(canonical data)。
 *
 * 演练链 2(web)/3(pdf)/4(xlsx)的夹具与本断言文件共用同一组指标数值,
 * 研报组装与 0 误差比对全部以此为基准:任一环节丢字/改数都会被逐字断言击穿。
 */

/** 公报元信息(标题 / 文号 / 发布机构)。 */
export const GAZETTE_META = {
	/** 公报标题(HTML <title>、PDF 通栏大标题、研报章题三处同源)。 */
	title: "2026年前三季度国民经济运行情况",
	/** 文号(红头公报结构要素,逐字保真断言对象)。 */
	docNumber: "国统字〔2026〕87 号",
	/** 发布机构(红头)。 */
	agency: "国家统计局",
} as const;

/** 核心指标(GDP 数值三链同源,同比须满足 (本期-上期)/上期 = 4.8% 精确成立)。 */
export const GAZETTE_INDICATORS = {
	/** 国内生产总值:上期 910000 × 1.048 = 953680(整数精确,0 误差)。 */
	gdp: { label: "国内生产总值", current: 953_680, prior: 910_000, growthPct: 4.8 },
	/** 规模以上工业增加值:仅增速口径。 */
	industry: { label: "规模以上工业增加值", growthPct: 5.9 },
	/** 社会消费品零售总额。 */
	retail: { label: "社会消费品零售总额", current: 353_564, growthPct: 3.2 },
	/** 固定资产投资(不含农户):仅增速口径。 */
	investment: { label: "固定资产投资", growthPct: 2.1 },
} as const;

/** 财报勾稽夹具(三张表:合计 / 借贷 / 同比)的账面数字。 */
export const LEDGER = {
	/** 合计表:数据行同列之和必须精确等于合计行(容差 0.01,账面全整数)。 */
	total: {
		rows: [
			{ item: "税收收入", amount: 65_000 },
			{ item: "非税收入", amount: 25_000 },
		],
		subtotalLabel: "合计",
		subtotal: 90_000,
	},
	/** 借贷表:∑借方 = ∑贷方 = 90000(与合计表勾稽)。 */
	debitCredit: {
		rows: [
			{ voucher: "记0001", summary: "拨付转移支付", debit: 12_000, credit: 12_000 },
			{ voucher: "记0002", summary: "国债发行收款", debit: 8_000, credit: 8_000 },
			{ voucher: "记0003", summary: "税款入库", debit: 70_000, credit: 70_000 },
		],
	},
	/** 同比表:同比列与重算值精确一致(4.8% 与公报 GDP 增速同源勾稽)。 */
	yoy: {
		rows: [
			// (953680 - 910000) / 910000 × 100 = 4.8 整数精确
			{ metric: "国内生产总值(亿元)", current: 953_680, prior: 910_000, yoyPct: 4.8 },
			// (65500 - 62500) / 62500 × 100 = 4.8 整数精确
			{ metric: "全社会用电量(亿千瓦时)", current: 65_500, prior: 62_500, yoyPct: 4.8 },
		],
	},
} as const;

/** 注错账:合计行 90000 → 90050(差额 50 ≫ 容差 0.01,必须 exit=1 且定位到第 4 行)。 */
export const CORRUPTION = {
	/** 注错后合计行金额。 */
	subtotalTampered: 90_050,
	/** 注错所在行(1 基:表头 1 + 数据 2 行 → 合计行第 4 行)。 */
	expectRow: 4,
	/** 注错所在列(1 基:第 2 列金额列)。 */
	expectColumn: 2,
} as const;

/** 全部指标数字的逐字字面量(研报与各链输出逐一 includes 断言用)。 */
export const CANONICAL_LITERALS = [
	String(GAZETTE_INDICATORS.gdp.current), // "953680"
	String(GAZETTE_INDICATORS.retail.current), // "353564"
	`${GAZETTE_INDICATORS.gdp.growthPct}%`, // "4.8%"
	`${GAZETTE_INDICATORS.industry.growthPct}%`, // "5.9%"
	`${GAZETTE_INDICATORS.retail.growthPct}%`, // "3.2%"
	`${GAZETTE_INDICATORS.investment.growthPct}%`, // "2.1%"
	GAZETTE_META.docNumber, // "国统字〔2026〕87 号"
	GAZETTE_META.title,
] as const;
