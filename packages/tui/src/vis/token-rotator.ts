/**
 * BI-20.5 — bi vis 访问令牌轮转引擎。
 *
 * 职责：
 * - 生成 128-bit 随机 hex 访问令牌（32 字符）；
 * - 按可配置周期（默认 5 分钟）轮转令牌，时钟可注入以便确定性测试；
 * - 旧令牌在轮转后保留宽限期（默认 60 秒）双活，过期即失效；
 * - 构造本地访问 URL 列表（127.0.0.1 形态优先），网络接口枚举可注入 stub。
 *
 * 约束：零 npm 依赖；仅依赖 node:os 与 Web Crypto（Bun 内建）。
 */

import { networkInterfaces as osNetworkInterfaces } from "node:os";

/** 可注入时钟接口。 */
export interface VisClock {
  now(): number;
}

/** 系统真实时钟。 */
export class SystemVisClock implements VisClock {
  now(): number {
    return Date.now();
  }
}

/** 默认轮转周期：5 分钟。 */
export const DEFAULT_ROTATION_MS = 5 * 60_000;

/**
 * 旧令牌宽限期（双活窗口）：60 秒。
 * 宽限期按半开区间 [轮转时刻, 轮转时刻 + graceMs) 计：
 * 有效时长恰好等于 graceMs，graceMs=0 表示轮转即失效。
 */
export const DEFAULT_GRACE_MS = 60_000;

export interface TokenRotatorOptions {
  /** 轮转周期毫秒数，默认 5 分钟，必须为正。 */
  rotationMs?: number;
  /** 旧令牌宽限期毫秒数，默认 60 秒，不得为负；0 表示轮转即失效。 */
  graceMs?: number;
  /** 时钟注入，缺省系统时钟。 */
  clock?: VisClock;
  /** 随机令牌源注入（测试用），缺省 crypto.getRandomValues 生成 128-bit hex。 */
  randomToken?: () => string;
}

/** 生成 128-bit 随机 hex 令牌（32 字符）。 */
export function randomToken128(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * 访问令牌轮转引擎。
 *
 * 轮转采用惰性推进：current()/validate() 时若已到周期则先轮转，
 * 配合注入时钟可在测试中零等待、确定性地验证双活窗口。
 */
export class TokenRotator {
  private readonly rotationMs: number;
  private readonly graceMs: number;
  private readonly clock: VisClock;
  private readonly nextToken: () => string;

  private activeToken: string;
  private graceToken: string | null = null;
  private lastRotationAt: number;

  constructor(options: TokenRotatorOptions = {}) {
    const rotationMs = options.rotationMs ?? DEFAULT_ROTATION_MS;
    if (!Number.isFinite(rotationMs) || rotationMs <= 0) {
      throw new RangeError("rotationMs 必须为正数");
    }
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw new RangeError("graceMs 不得为负数");
    }
    this.rotationMs = rotationMs;
    this.graceMs = graceMs;
    this.clock = options.clock ?? new SystemVisClock();
    this.nextToken = options.randomToken ?? randomToken128;
    this.lastRotationAt = this.clock.now();
    this.activeToken = this.nextToken();
  }

  /** 当前有效令牌；若已到轮转周期则先惰性轮转。 */
  current(): string {
    this.maybeRotate();
    return this.activeToken;
  }

  /**
   * 校验候选令牌：当前令牌恒真；
   * 上一代令牌在宽限期内（双活窗口）为真，过期即假；其余一律假。
   */
  validate(token: string | null | undefined): boolean {
    if (typeof token !== "string" || token.length === 0) {
      return false;
    }
    this.maybeRotate();
    if (token === this.activeToken) {
      return true;
    }
    if (this.graceToken !== null && token === this.graceToken) {
      return this.clock.now() - this.lastRotationAt < this.graceMs;
    }
    return false;
  }

  /** 上一代令牌是否仍在宽限期内（双活窗口探针，测试与诊断用）。 */
  graceActive(): boolean {
    if (this.graceToken === null) {
      return false;
    }
    return this.clock.now() - this.lastRotationAt < this.graceMs;
  }

  /** 立即轮转一次，返回新令牌；旧令牌进入宽限期。 */
  rotate(now: number = this.clock.now()): string {
    this.graceToken = this.activeToken;
    this.lastRotationAt = now;
    this.activeToken = this.nextToken();
    return this.activeToken;
  }

  private maybeRotate(): void {
    if (this.clock.now() - this.lastRotationAt >= this.rotationMs) {
      this.rotate();
    }
  }
}

/** 单个网络地址信息（与 node:os networkInterfaces 条目对齐的最小结构面）。 */
export interface NetAddressInfo {
  address: string;
  family?: string | number;
  internal?: boolean;
}

/** 网络接口枚举器：缺省 node:os.networkInterfaces，测试可注入 stub。 */
export type InterfacesProvider = () => Record<string, NetAddressInfo[] | undefined>;

const defaultInterfaces: InterfacesProvider = () =>
  osNetworkInterfaces() as Record<string, NetAddressInfo[] | undefined>;

export interface AccessUrlsOptions {
  /** 接口枚举注入（测试 stub），缺省 node:os。 */
  interfaces?: InterfacesProvider;
  /** 页面路径，缺省 "/"。 */
  path?: string;
}

function isIPv4Address(addr: NetAddressInfo): boolean {
  if (addr.family === 4 || String(addr.family).toLowerCase() === "ipv4") {
    return true;
  }
  if (addr.family === 6 || String(addr.family).toLowerCase() === "ipv6") {
    return false;
  }
  // family 缺省时按地址形态兜底判定
  return !addr.address.includes(":");
}

/**
 * 构造本地访问 URL 列表（127.0.0.1 形态）：
 * 首项恒为 http://127.0.0.1:<port><path>?t=<token>；
 * 其后按接口枚举追加非 internal 的 IPv4 地址（跳过回环与 IPv6），并去重。
 */
export function accessUrls(
  port: number,
  token: string,
  options: AccessUrlsOptions = {},
): string[] {
  const path = options.path ?? "/";
  const query = "?t=" + encodeURIComponent(token);
  const urls: string[] = ["http://127.0.0.1:" + String(port) + path + query];
  const seen = new Set<string>(urls);
  const tables = (options.interfaces ?? defaultInterfaces)();
  for (const addrs of Object.values(tables ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.internal) {
        continue;
      }
      if (!isIPv4Address(addr)) {
        continue;
      }
      const url = "http://" + addr.address + ":" + String(port) + path + query;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }
  return urls;
}
