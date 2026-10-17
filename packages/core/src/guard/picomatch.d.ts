/**
 * picomatch ^4.0.3 最小环境模块类型声明（仅声明本包实际用到的面）。
 *
 * 背景：picomatch 4.x 为纯 JS 包，官方不随包分发 .d.ts（package.json 无
 * types/typings 字段），故在此以 ambient module 补齐最小类型。
 * 运行时 bun 以 CJS-ESM 互操作将 module.exports（picomatch 函数本体）
 * 作为 default 导出提供，类型层与运行时行为一致。
 */
declare module "picomatch" {
  /** picomatch 编译选项。本引擎仅启用 dot（权限匹配宁可多命中多询问，不可漏配）。 */
  export interface PicomatchOptions {
    /** 通配符是否命中点开头的路径段（dotfile）。 */
    readonly dot?: boolean;
  }

  /** 编译后的匹配器：对输入串做一次性判定。 */
  export type PicomatchMatcher = (input: string) => boolean;

  /**
   * 将 glob 模式编译为匹配器。
   * 注意：`picomatch("*")("")` 返回 false（picomatch 语义），全匹配短路
   * 由上层 matchRule 显式处理，不依赖此函数。
   */
  export default function picomatch(
    glob: string | readonly string[],
    options?: PicomatchOptions,
  ): PicomatchMatcher;
}
