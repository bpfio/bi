/**
 * BI-10.5 · 日期跨越感知器（host 时钟跨 00:00 披露）。
 *
 * DateChangeSensor.check(nowMs, state?)：把注入时钟（nowMs）按注入时区
 * （缺省 Asia/Shanghai，与 time-context 对齐）换算墙钟日期（YYYY-MM-DD），
 * 与上次登记日期比较：
 *  - 首次登记（无 lastDate）→ 只建立基线，不触发（裁定：无前值无可披露）；
 *  - 日期未变 → null；
 *  - 日期变化（跨 00:00，含时钟回拨导致的倒退——裁定：日期假设失效即披露）
 *    → 生成 `date_change` 披露标记 { kind, previousDate, currentDate, note }，
 *    并把 lastDate 推进到当前日期——每自然日至多一次由此天然保证；
 *  - 跨多个自然日的间隔只触发一次（披露 latest 跳变，不逐日补发）。
 *
 * 双态模式：check 传入 state（外部持久化态）时纯函数式求值——以 state 为
 * 前值、返回推进后的 state，不触碰实例内部态；省略 state 时用实例内部态。
 * 注入时钟即 nowMs 参数（纯计算，无 Date.now 依赖）。
 *
 * 无外部依赖：墙钟日期由 Intl formatToParts 手工拼装（与 time-context 同
 * 法，免 region 序列化差异）。非法 nowMs（非有限数）与非法时区抛 RangeError。
 */

export const DEFAULT_DATE_TIMEZONE = "Asia/Shanghai";

/** `date_change` 披露标记。 */
export interface DateChangeMarker {
  kind: "date_change";
  /** 上一次登记的墙钟日期（YYYY-MM-DD，注入时区） */
  previousDate: string;
  /** 当前墙钟日期（YYYY-MM-DD，注入时区） */
  currentDate: string;
  /** 给模型的披露说明 */
  note: string;
}

/** 日期感知外部态（可持久化；lastDate=null 表示尚未建立基线）。 */
export interface DateSensorState {
  lastDate: string | null;
}

export interface DateCheckResult {
  /** 仅在日期跨越时非 null */
  marker: DateChangeMarker | null;
  /** 推进后的状态（内部模式即新内部态的镜像；外部模式为纯函数输出） */
  state: DateSensorState;
}

export interface DateChangeSensorOpts {
  /** IANA 时区。缺省 Asia/Shanghai。 */
  timezone?: string;
}

/** 按注入时区取墙钟日期（YYYY-MM-DD）。 */
function wallDate(epochMs: number, tz: string): string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new RangeError(`invalid IANA timezone: ${tz}`);
  }
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export class DateChangeSensor {
  readonly timezone: string;
  private internalLastDate: string | null = null;

  constructor(opts: DateChangeSensorOpts = {}) {
    const tz = opts.timezone ?? DEFAULT_DATE_TIMEZONE;
    wallDate(0, tz); // 构造期校验时区（非法即 RangeError）
    this.timezone = tz;
  }

  /**
   * 检查注入时钟：日期跨越 → 披露标记（每自然日至多一次）。
   *
   * @param nowMs 注入时钟（epoch 毫秒，须为有限数）
   * @param state 可选外部态；传入则纯函数式求值，不触碰内部态
   * @throws RangeError nowMs 非有限数，或时区非法（构造期已校验则不会）
   */
  check(nowMs: number, state?: DateSensorState): DateCheckResult {
    if (!Number.isFinite(nowMs)) {
      throw new RangeError(`nowMs must be a finite epoch ms, got ${String(nowMs)}`);
    }
    const external = state !== undefined;
    const previous = external ? state.lastDate : this.internalLastDate;
    const currentDate = wallDate(nowMs, this.timezone);

    let marker: DateChangeMarker | null = null;
    if (previous !== null && previous !== currentDate) {
      marker = {
        kind: "date_change",
        previousDate: previous,
        currentDate,
        note:
          `主机时钟已跨过 00:00（${this.timezone}）：日期由 ${previousDateOf(previous)} 变为 ${currentDate}。` +
          `涉及时间敏感的判断请以新日期为准。`,
      };
    }
    const nextState: DateSensorState = { lastDate: currentDate };
    if (!external) this.internalLastDate = currentDate;
    return { marker, state: nextState };
  }

  /** 重置内部基线（下一 check 重新登记，不触发）。 */
  reset(): void {
    this.internalLastDate = null;
  }
}

/** previousDate 兜底（防 lastDate 被外部态污染为非字符串）。 */
function previousDateOf(previous: string): string {
  return typeof previous === "string" && previous !== "" ? previous : "unknown";
}
