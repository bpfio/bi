/**
 * BI-20.5 接线 —— bi vis 访问令牌轮转权威（tui 侧装配件）。
 *
 * 器官：token-rotator.ts（TokenRotator：128-bit 随机令牌 / 5 分钟轮转 /
 * 60 秒宽限双活）。本模块只做装配，不改器官：
 *   - 把 TokenRotator 包成「令牌权威端口」（core 侧只认端口：current + validate）；
 *   - 轮转发生时回调通知（宿主据此重印访问链接——旧链接的令牌过期后靠它拿新的）。
 *
 * 依赖方向：轮转引擎在 tui 侧，core 不得依赖 tui（不许倒置依赖）——core 侧
 * 的 vis 处理器只接受「令牌权威端口」，由宿主（bin/bi.ts）把本模块的产物
 * 注入进去；env 门（BI_VIS_TOKEN_ROTATE=1）由 core 侧装配链判定。
 *
 * 零 npm 依赖；确定性可测（时钟/随机源均可注入）。
 */

import {
  TokenRotator,
  type TokenRotatorOptions,
} from "./token-rotator";

/**
 * 令牌权威端口（与 core/web/vis-handler.ts 的 TokenAuthority 结构等价：
 * current 取当前令牌，validate 判候选令牌——轮转后旧令牌在宽限期内仍为真）。
 */
export interface VisTokenAuthority {
  current(): string;
  validate(token: string | null | undefined): boolean;
}

/** 轮转权威构造选项（缺省走器官默认：5 分钟轮转 / 60 秒宽限 / 128-bit 令牌）。 */
export interface VisTokenAuthorityOptions extends TokenRotatorOptions {
  /** 轮转发生时的回调（收到新令牌；宿主据此重印带令牌的访问链接）。 */
  onRotate?: (token: string) => void;
}

/**
 * 轮转权威实现：包 TokenRotator，惰性轮转的副作用在此转成 onRotate 回调
 * （器官本身无监听面；轮转由 current()/validate() 触发）。
 */
class RotatingTokenAuthority implements VisTokenAuthority {
  #lastToken: string;

  constructor(
    private readonly rotator: TokenRotator,
    private readonly onRotate: ((token: string) => void) | undefined,
  ) {
    this.#lastToken = rotator.current();
  }

  /** 当前有效令牌（触发惰性轮转；轮转后回调通知）。 */
  current(): string {
    const token = this.rotator.current();
    this.#notice(token);
    return token;
  }

  /** 校验候选令牌：当前令牌恒真；上一代令牌在宽限期内（双活）为真。 */
  validate(token: string | null | undefined): boolean {
    this.current(); // 先推进惰性轮转（轮转后 current 与 grace 口径一致）
    return this.rotator.validate(token);
  }

  #notice(token: string): void {
    if (token === this.#lastToken) return;
    this.#lastToken = token;
    this.onRotate?.(token);
  }
}

/**
 * 造轮转令牌权威：128-bit 随机令牌、默认 5 分钟轮转、默认 60 秒宽限双活。
 * 可注入时钟/随机源（测试零等待、确定性）。
 */
export function createVisTokenAuthority(options: VisTokenAuthorityOptions = {}): VisTokenAuthority {
  const { onRotate, ...rotatorOptions } = options;
  const rotator = new TokenRotator(rotatorOptions);
  return new RotatingTokenAuthority(rotator, onRotate);
}
