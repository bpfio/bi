/** @bi/plugins —— 插件域：研报插件的加载、注册与运行时管理。 */
export const DESCRIPTION = "插件域：研报插件的加载、注册与运行时管理。";

// BI-17：官方插件双协议加载器（声明层）与 Marketplace（索引/安装）
export * from './loader';
export * from './marketplace';
