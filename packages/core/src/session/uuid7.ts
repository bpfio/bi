/**
 * UUIDv7 生成器（RFC 9562），零外部依赖。
 *
 * 布局（共 128 位，大端）：
 *   -  48 位：unix_ts_ms   —— Unix 毫秒时间戳（2^48 - 1 ms 内不溢出）
 *   -   4 位：ver = 0b0111 —— 版本号 7
 *   -  12 位：rand_a       —— 单调计数器（每毫秒随机播种，同毫秒内递增）
 *   -   2 位：var = 0b10   —— RFC 4122 变体
 *   -  62 位：rand_b       —— node:crypto 随机位
 *
 * 单调性（RFC 9562 §6.2 方法 1）：同毫秒内复用时间戳并递增 rand_a 计数器，
 * 计数器溢出（>4096 条/毫秒）时将时间戳伪推进 1ms；注入早于内部状态的时间戳时
 * 沿用内部较大时间戳。由此保证同进程内生成的 id 严格递增——
 * 字典序比较即时间序，可直接用于索引排序。
 */
import { randomBytes } from "node:crypto";

/** 12 位计数器上限（rand_a 容量）。 */
const COUNTER_MAX = 0xfff;
/** 时间戳上限：2^48 - 1 ms。 */
const TS_MAX = 2 ** 48 - 1;

/** 进程内单调状态：上次使用的毫秒时间戳与计数器。 */
let lastMs = -1;
let counter = 0;

/**
 * 生成一个 UUIDv7 字符串（小写、含连字符的标准 8-4-4-4-12 格式）。
 *
 * @param timeMs 可选的毫秒时间戳（默认 Date.now()），仅测试/回放场景注入；
 *               注入值小于内部单调状态时输出仍保持严格递增（时间戳沿用内部值）。
 */
export function uuid7(timeMs: number = Date.now()): string {
  const ms = Math.floor(timeMs);
  if (!Number.isFinite(ms)) {
    throw new RangeError(`uuid7: 时间戳必须是有限数值，收到 ${timeMs}`);
  }
  if (ms < 0 || ms > TS_MAX) {
    throw new RangeError(`uuid7: 时间戳 ${ms} 超出 48 位可表示范围 [0, ${TS_MAX}]`);
  }

  let effMs: number;
  if (ms <= lastMs) {
    // 同毫秒（或注入的回退时间戳）：递增计数器保持单调，时间戳沿用内部状态。
    counter += 1;
    if (counter > COUNTER_MAX) {
      // 计数器溢出：时间戳伪推进 1ms（RFC 9562 §6.2 允许）。
      counter = 0;
      lastMs += 1;
    }
    effMs = lastMs;
  } else {
    // 新毫秒：随机播种计数器（rand_a 本质仍是随机位，播种仅抗同毫秒内可预测）。
    lastMs = ms;
    counter = randomBytes(2).readUInt16BE(0) & COUNTER_MAX;
    effMs = ms;
  }

  const rand = randomBytes(8); // rand_b 的 62 位 + b[8] 高 2 位补变体
  const bytes = Buffer.alloc(16);
  // 48 位大端时间戳（用除法而非移位：JS 位运算仅 32 位安全）。
  bytes.writeUInt8(Math.floor(effMs / 2 ** 40) & 0xff, 0);
  bytes.writeUInt8(Math.floor(effMs / 2 ** 32) & 0xff, 1);
  bytes.writeUInt8(Math.floor(effMs / 2 ** 24) & 0xff, 2);
  bytes.writeUInt8(Math.floor(effMs / 2 ** 16) & 0xff, 3);
  bytes.writeUInt8(Math.floor(effMs / 2 ** 8) & 0xff, 4);
  bytes.writeUInt8(effMs & 0xff, 5);
  // ver=7 占 b[6] 高 4 位，rand_a 计数器占低 12 位（b[6] 低 4 位 + b[7] 全部）。
  bytes.writeUInt8(0x70 | ((counter >> 8) & 0x0f), 6);
  bytes.writeUInt8(counter & 0xff, 7);
  // var=0b10 占 b[8] 高 2 位，其余 62 位为随机。
  bytes.set(rand, 8);
  bytes.writeUInt8(0x80 | (rand.readUInt8(0) & 0x3f), 8);

  return formatUuid(bytes);
}

/**
 * 从 UUIDv7 提取内嵌的 unix 毫秒时间戳。
 * 非法格式或非 v7 版本位时返回 null（不做半猜测解析）。
 */
export function uuid7TimestampMs(id: string): number | null {
  if (typeof id !== "string" || id.length !== 36) return null;
  if (id.charAt(8) !== "-" || id.charAt(13) !== "-" || id.charAt(18) !== "-" || id.charAt(23) !== "-") {
    return null;
  }
  const hex = id.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  // 版本位（第 13 个 hex 字符）必须为 7，变体位（第 17 个）必须为 8/9/a/b。
  if (hex.charAt(12) !== "7") return null;
  if (!"89ab".includes(hex.charAt(16))) return null;
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  // 48 位整数 < 2^53，Number 解析精确无歧义。
  return Number.isSafeInteger(ms) ? ms : null;
}

function formatUuid(bytes: Buffer): string {
  let out = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += "-";
    out += bytes.readUInt8(i).toString(16).padStart(2, "0");
  }
  return out;
}
