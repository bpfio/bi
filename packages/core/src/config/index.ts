/**
 * @bi/core 配置域公共出口（`@bi/core/config` 子路径导出）。
 *
 * 三级 TOML 配置系统：路径拓扑（paths）、强类型 Schema 与默认值（schema）、
 * 多源优先级合并与热重载（config-service）、注释保留原子回写（writeback）、
 * 密钥脱敏（redact）、hooks 分区 → hook-runner 装载适配（hooks-adapter）。
 */

export * from "./paths";
export * from "./schema";
export * from "./config-service";
export * from "./writeback";
export * from "./redact";
export * from "./hooks-adapter";
