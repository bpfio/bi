/**
 * @bi/core —— BI 平台核心域。
 * 提供跨包共享的基础工具与底层能力（原子写、通用工具、基础类型）。
 */
export const VERSION = "0.3.0";

export const PACKAGE = {
  name: "@bi/core",
  version: VERSION,
  description: "BI 平台核心域：跨包共享的基础工具与底层能力。",
} as const;
