/**
 * BI-15.1 · A2A 邮件私密信令网关 (Control Plane) —— 自研核心创新轮子。
 *
 * 设计依据：工单卡 BI-15.1。零外部 npm 依赖：协议面手写最小实现
 * （生产走 node:net/node:tls，测试经注入的 socket 双工桩，零真实网络）。
 *
 * 协议边界声明（v1 PICTURE 化最小子集，边界即契约）：
 * - SMTP 发送面：EHLO →（隐式 TLS 465 直连；明文口 STARTTLS 被拒则回退隐式 TLS 465）→
 *   AUTH LOGIN（base64 凭据，日志/trace 脱敏）→ MAIL FROM → RCPT TO（to + ccHuman）→
 *   DATA（MIME 文本，点 stuffing，"\r\n.\r\n" 终止）→ QUIT。
 * - IMAP 接收面（v1 仅轮询级）：LOGIN → SELECT INBOX → SEARCH HEADER "X-BI-A2A" "v1" UNSEEN →
 *   FETCH (BODY.PEEK[]) → 逐封 \Seen → LOGOUT。
 *   完整 IMAP IDLE（长连接服务器推送）、UID SEARCH/UID FETCH、多邮箱、附件/HTML
 *   归后续增强卡；本卡只认 HEADER 过滤 + 序号 + 单一 INBOX。
 * - A2A 载荷即邮件体：正文内容 = JSON 化 SignedEnvelope（BI-15.3 信封为协议面，
 *   邮件只是 binding）。为规避 SMTP 1000 字符行长限制与 8bit 通路不确定性，
 *   正文以 MIME base64 CTE（RFC 2045）承载，解码后即 JSON 信封；
 *   邮件头 `X-BI-A2A: v1` 为过滤标记，主题 `[BI-A2A] <from>→<to>`（非 ASCII 走 RFC 2047）。
 *
 * 安全语义（零数据外泄红线）：
 * - 日志/trace/error.raw 全部经 redact()：SMTP base64 凭据、IMAP LOGIN 参数以 `***` 落盘；
 * - 收件双层 fail-closed：邮件 From 头白名单（本卡）+ verifyEnvelope 信封白名单（BI-15.3）；
 * - 验签失败信封：仍标 \Seen（工单裁定：防重复处理）+ 审计事件（可注入 auditSink）；
 *   无 X-BI-A2A 标记的邮件视为非 A2A 资产：跳过、不标 \Seen、不审计；
 * - 同一 nonce 重复投递由 BI-15.3 ReplayStore 天然去重（第二次 → replayed 审计）。
 * - 收发件地址经注入防护校验（拒绝 CR/LF 与分隔符，防 SMTP/MIME 头注入）。
 */

import {
  MemoryReplayStore,
  verifyEnvelope,
  type A2aSharedSecret,
  type ReplayStore,
  type SignedEnvelope,
} from "../auth";
import type { Socket as NetSocket } from "node:net";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const A2A_MAIL_MARKER_HEADER = "X-BI-A2A" as const;
export const A2A_MAIL_MARKER_VALUE = "v1" as const;
export const A2A_SUBJECT_TAG = "[BI-A2A]" as const;
const DEFAULT_SMTP_PORT = 465;
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_TIMEOUT_MS = 10_000;
const EHLO_NAME = "a2a-email-gateway";
/** base64 正文按 76 字符折行（RFC 2045 §6.8 建议 ≤76） */
const BODY_LINE_WIDTH = 76;
const MAX_LOG_LINES = 1000;

// ---------------------------------------------------------------------------
// 错误模型：connect / auth / protocol / timeout 四类
// ---------------------------------------------------------------------------

export type EmailGatewayErrorKind = "connect" | "auth" | "protocol" | "timeout";

/** 结构化网关错误：协议异常携带原始响应行（已脱敏，凭据位为 ***）。 */
export class EmailGatewayError extends Error {
  readonly kind: EmailGatewayErrorKind;
  /** 原始响应行（已脱敏）；仅协议/鉴权异常时提供 */
  readonly raw?: string;

  constructor(kind: EmailGatewayErrorKind, message: string, raw?: string) {
    super(`[a2a-email-gateway:${kind}] ${message}`);
    this.name = "EmailGatewayError";
    this.kind = kind;
    this.raw = raw;
  }
}

/** STARTTLS 被服务器拒绝/未广告 —— 触发隐式 TLS 465 直连回退（内部控制流用）。 */
class StartTlsRefusedError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`STARTTLS refused: ${detail}`);
    this.name = "StartTlsRefusedError";
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// 传输抽象：双工 socket（生产 node:net/node:tls；测试注入脚本化桩）
// ---------------------------------------------------------------------------

export interface DuplexLike {
  /** 客户端→服务端写（协议行，含 CRLF 由实现方补齐） */
  write(data: string): void;
  /** 服务端→客户端数据回调（chunk 边界任意） */
  onData(cb: (chunk: string) => void): void;
  /** 服务端关闭连接（EOF） */
  onEnd(cb: () => void): void;
  /** 传输层错误 */
  onError(cb: (err: Error) => void): void;
  /** 优雅关闭（FIN，冲刷待写数据） */
  end(): void;
  destroy?(): void;
  /** STARTTLS：在同一 TCP 连接上升级 TLS（仅明文口需要；测试桩记录调用） */
  upgradeTls?(): Promise<void> | void;
}

/** socket 工厂：tls=true 表示隐式 TLS（465/993 直连）；测试注入双工桩实现零真实网络 */
export type SocketFactory = (host: string, port: number, tls: boolean) => Promise<DuplexLike>;

/** 生产默认工厂：node:net / node:tls。 */
export async function defaultSocketFactory(
  host: string,
  port: number,
  tls: boolean,
): Promise<DuplexLike> {
  const net = await import("node:net");
  const tlsMod = await import("node:tls");
  let sock: NetSocket = tls
    ? tlsMod.connect({ host, port })
    : net.connect({ host, port });
  await new Promise<void>((resolve, reject) => {
    const handshakeEvent = tls ? "secureConnect" : "connect";
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onErr = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      sock.removeListener("error", onErr);
      sock.removeListener(handshakeEvent, onReady);
    };
    sock.once("error", onErr);
    sock.once(handshakeEvent, onReady);
  });

  let dataCb: ((chunk: string) => void) | null = null;
  let endCb: (() => void) | null = null;
  let errCb: ((err: Error) => void) | null = null;
  const dataFn = (buf: Buffer): void => dataCb?.(buf.toString("utf8"));
  const endFn = (): void => endCb?.();
  const errFn = (err: Error): void => errCb?.(err);

  const attach = (target: NetSocket): void => {
    target.on("data", dataFn);
    target.on("end", endFn);
    target.on("error", errFn);
  };
  attach(sock);

  return {
    write: (data) => sock.write(data),
    onData: (cb) => {
      dataCb = cb;
    },
    onEnd: (cb) => {
      endCb = cb;
    },
    onError: (cb) => {
      errCb = cb;
    },
    end: () => sock.end(),
    destroy: () => sock.destroy(),
    upgradeTls: async () => {
      // STARTTLS：剥离明文监听，用同一 TCP socket 做 TLS 握手后重新挂监听
      sock.removeListener("data", dataFn);
      sock.removeListener("end", endFn);
      sock.removeListener("error", errFn);
      const upgraded = tlsMod.connect({ host, port, socket: sock });
      await new Promise<void>((resolve, reject) => {
        const onOk = (): void => {
          cleanup();
          resolve();
        };
        const onErr = (err: Error): void => {
          cleanup();
          reject(err);
        };
        const cleanup = (): void => {
          upgraded.removeListener("secureConnect", onOk);
          upgraded.removeListener("error", onErr);
        };
        upgraded.once("secureConnect", onOk);
        upgraded.once("error", onErr);
      });
      sock = upgraded;
      attach(sock);
    },
  };
}

// ---------------------------------------------------------------------------
// 选项与审计事件
// ---------------------------------------------------------------------------

export interface SmtpConfig {
  host: string;
  /** 默认 465（隐式 TLS 直连） */
  port?: number;
  /** 默认 true = 隐式 TLS；false = 明文连接并尝试 STARTTLS（被拒则回退 465 隐式 TLS） */
  tls?: boolean;
  /** STARTTLS 被拒回退时连接的隐式 TLS 端口（默认 465，工单裁定「465 直连」） */
  tlsFallbackPort?: number;
}

export interface ImapConfig {
  host: string;
  /** 默认 993（隐式 TLS） */
  port?: number;
}

/** 审计事件（验签拒绝 / 白名单拒绝；不含任何信封内容，只含发件地址与稳定原因） */
export interface A2aGatewayAuditEvent {
  readonly at: number;
  readonly kind: "verify-rejected" | "allowlist-rejected";
  readonly from: string;
  /** 稳定原因：BI-15.3 原因码或 'malformed'（JSON/结构损坏） */
  readonly reason: string;
}

/** 单条会话的客户端命令记录（已脱敏：凭据位为 ***；测试断言协议序列用） */
export interface SessionTrace {
  readonly label: string;
  readonly tls: boolean;
  readonly sent: string[];
}

export interface EmailGatewayOptions {
  smtp: SmtpConfig;
  imap: ImapConfig;
  /** 本端信箱地址：SMTP MAIL FROM 信封地址 & IMAP LOGIN 账号 */
  mailbox: string;
  /**
   * 邮箱凭据：SMTP AUTH LOGIN 用 user/pass；IMAP LOGIN 复用 pass（账号 = mailbox）。
   * pollInbox 必需；sendControl 缺省时跳过 AUTH（匿名中继场景）。
   */
  smtpAuth?: { user: string; pass: string };
  /** A2A 共享密钥（BI-15.3 brand 类型） */
  secret: A2aSharedSecret;
  /** 发件人白名单（邮件 From 头层，fail-closed：空数组拒绝一切） */
  allowFrom?: string[];
  /** 人类旁观抄送：发送时追加 RCPT TO + MIME Cc 头（人类旁观控制面，不参与协议应答） */
  ccHuman?: string[];
  /** 测试注入双工桩；缺省走 node:net/node:tls 真实连接 */
  socketFactory?: SocketFactory;
  /** 单命令超时毫秒；默认 10_000 */
  timeoutMs?: number;
  /** 注入时钟（审计时刻 / MIME Date / verifyEnvelope now）；默认 Date.now */
  clock?: () => number;
  /** nonce 防重放库（透传 BI-15.3）；缺省本网关私有 MemoryReplayStore */
  replayStore?: ReplayStore;
  /** verifyEnvelope 时钟偏斜窗透传；缺省 BI-15.3 默认 5 分钟 */
  skewMs?: number;
  /** 审计接收器；缺省仅记录到网关内部审计环（audits() 可读） */
  auditSink?: (event: A2aGatewayAuditEvent) => void;
  /** 结构化日志接收器；缺省仅记录到网关内部日志环（logs() 可读） */
  logSink?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// 协议小工具
// ---------------------------------------------------------------------------

/** SMTP 点 stuffing（RFC 5321 §4.5.2）：以 "." 开头的行前再补一个 "."。 */
export function smtpDotStuff(line: string): string {
  return line.startsWith(".") ? `.${line}` : line;
}

/** IMAP quoted string（RFC 3501 §9）：转义 `\` 与 `"`。 */
function imapQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 收发件地址注入防护：拒绝空白/CR/LF 与 SMTP/MIME 分隔符。
 * 错误消息不回显地址全文（只回显长度），防地址本身含诱导性内容污染日志。
 */
function assertAddress(addr: string, role: string): void {
  const ok = /^[^\s@<>,;:"\\]+@[^\s@<>,;:"\\]+$/.test(addr);
  if (!ok) {
    throw new EmailGatewayError("protocol", `${role} 地址不合法（长度 ${addr.length}，拒绝注入字符）`);
  }
}

/** RFC 2047 编码（UTF-8 / B）：仅当出现非可打印 ASCII 时启用。 */
export function encodeMimeHeaderText(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7E]/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/** RFC 2047 解码（本网关自产格式：单个 UTF-8/B encoded-word；原文 ASCII 时原样返回）。 */
export function decodeMimeHeaderText(text: string): string {
  const match = /=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/i.exec(text);
  if (match === null) return text;
  const decoded = match[1];
  if (decoded === undefined) return text;
  return Buffer.from(decoded, "base64").toString("utf8");
}

/** SMTP 正向完成码（2xx 中 250/251 系）。 */
function isPositiveCompletion(line: string): boolean {
  return /^25\d/.test(line);
}

/** 从 MIME From 头提取纯地址（`Name <a@b>` → `a@b`；裸地址原样）。 */
function extractAddressFromHeader(value: string): string {
  const angled = /<([^<>]+)>/.exec(value);
  const inner = angled?.[1];
  const candidate = (inner ?? value).trim();
  return candidate;
}

interface ParsedMime {
  readonly headers: Map<string, string>;
  readonly body: string;
  readonly contentTransferEncoding: string;
}

/** 最小 MIME 解析：头部折叠行 + 空行分界 + body 原文（不递归 multipart；本网关自产单段文本）。 */
function parseMime(raw: string): ParsedMime | null {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  let headerText: string;
  let body: string;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    headerText = raw.slice(0, crlf);
    body = raw.slice(crlf + 4);
  } else if (lf >= 0) {
    headerText = raw.slice(0, lf);
    body = raw.slice(lf + 2);
  } else {
    return null;
  }
  const headers = new Map<string, string>();
  let currentKey: string | null = null;
  for (const rawLine of headerText.split(/\r?\n/)) {
    if (rawLine.length === 0) continue;
    if ((rawLine.startsWith(" ") || rawLine.startsWith("\t")) && currentKey !== null) {
      const prev = headers.get(currentKey);
      if (prev !== undefined) headers.set(currentKey, `${prev} ${rawLine.trim()}`);
      continue;
    }
    const colon = rawLine.indexOf(":");
    if (colon <= 0) continue;
    currentKey = rawLine.slice(0, colon).trim().toLowerCase();
    headers.set(currentKey, rawLine.slice(colon + 1).trim());
  }
  const cte = (headers.get("content-transfer-encoding") ?? "7bit").trim().toLowerCase();
  return { headers, body, contentTransferEncoding: cte };
}

/** 解码邮件正文：base64 CTE → UTF-8 JSON 文本；其余（7bit/8bit）按原文。 */
function decodeMimeBody(parsed: ParsedMime): string {
  if (parsed.contentTransferEncoding === "base64") {
    return Buffer.from(parsed.body.replace(/\s+/g, ""), "base64").toString("utf8");
  }
  return parsed.body;
}

/** 已签名封套运行时形状校验（键集恰为六协议键，防未签名附加字段注入——对齐 BI-15.3）。 */
function isWellFormedSignedEnvelope(value: unknown): value is SignedEnvelope<unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== "from,nonce,payload,signature,to,ts") return false;
  const env = value as Record<string, unknown>;
  return (
    typeof env.from === "string" &&
    typeof env.to === "string" &&
    typeof env.nonce === "string" &&
    typeof env.signature === "string" &&
    typeof env.ts === "number" &&
    Number.isSafeInteger(env.ts) &&
    "payload" in env
  );
}

// ---------------------------------------------------------------------------
// WireSession：单连接行协议会话（缓冲、超时、trace、脱敏日志）
// ---------------------------------------------------------------------------

interface PendingRead {
  readonly kind: "line" | "literal";
  readonly need: number;
  readonly resolve: (value: string) => void;
  readonly reject: (error: EmailGatewayError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * 行协议会话：把 DuplexLike 的无边界 chunk 流整形为「行 / 定长字面量」顺序读。
 * 读序严格串行（协议天然如此）；超时/EOF/传输错误统一落四类结构化错误。
 */
class WireSession {
  readonly label: string;
  readonly tls: boolean;
  /** 已发送命令（脱敏后），会话结束并入网关 trace */
  readonly sent: string[] = [];
  #buf = "";
  #read: PendingRead | null = null;
  #dead = false;
  readonly #timeoutMs: number;
  readonly #redact: (text: string) => string;
  readonly #log: (line: string) => void;

  constructor(
    label: string,
    tls: boolean,
    socket: DuplexLike,
    timeoutMs: number,
    redact: (text: string) => string,
    log: (line: string) => void,
  ) {
    this.label = label;
    this.tls = tls;
    this.#timeoutMs = timeoutMs;
    this.#redact = redact;
    this.#log = log;
    socket.onData((chunk) => {
      if (this.#dead) return;
      this.#buf += chunk;
      this.#drain();
    });
    socket.onEnd(() => this.#markDead(`${label} 连接被对端关闭`));
    socket.onError((err) => this.#markDead(`${label} 传输错误: ${err.message}`));
  }

  get isDead(): boolean {
    return this.#dead;
  }

  #markDead(reason: string): void {
    if (this.#dead) return;
    this.#dead = true;
    this.#log(`${this.label}! ${reason}`);
    const read = this.#read;
    if (read !== null) {
      this.#read = null;
      clearTimeout(read.timer);
      read.reject(new EmailGatewayError("connect", reason));
    }
  }

  #drain(): void {
    const read = this.#read;
    if (read === null) return;
    if (read.kind === "line") {
      const nl = this.#buf.indexOf("\n");
      if (nl < 0) return;
      let line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#settle(read, line);
      return;
    }
    if (this.#buf.length < read.need) return;
    const data = this.#buf.slice(0, read.need);
    this.#buf = this.#buf.slice(read.need);
    this.#settle(read, data);
  }

  #settle(read: PendingRead, value: string): void {
    this.#read = null;
    clearTimeout(read.timer);
    read.resolve(value);
  }

  /** 顺序读一行（CRLF/LF 均容忍）；超时 → kind=timeout 并销毁连接。 */
  readLine(what: string): Promise<string> {
    return this.#read_({ kind: "line", need: 0, what });
  }

  /** 顺序读定长字面量（IMAP {N}）；字符计数与自产 ASCII 安全 MIME 对齐（见文件头边界声明）。 */
  readLiteral(n: number, what: string): Promise<string> {
    return this.#read_({ kind: "literal", need: n, what });
  }

  #read_(req: { kind: "line" | "literal"; need: number; what: string }): Promise<string> {
    if (this.#dead) {
      return Promise.reject(new EmailGatewayError("connect", `${this.label} 会话已关闭，无法读取 ${req.what}`));
    }
    if (this.#read !== null) {
      return Promise.reject(new EmailGatewayError("protocol", `${this.label} 读操作并发（等待 ${req.what}）`));
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#read = null;
        this.destroy();
        reject(
          new EmailGatewayError(
            "timeout",
            `${this.label} 等待 ${req.what} 超时（${this.#timeoutMs}ms）`,
          ),
        );
      }, this.#timeoutMs);
      this.#read = { kind: req.kind, need: req.need, resolve, reject, timer };
      this.#drain();
    });
  }

  /** 写协议行（自动补 CRLF）；traceOverride 用于凭据行落 trace 为 ***。 */
  write(line: string, traceOverride?: string): void {
    if (this.#dead) {
      throw new EmailGatewayError("connect", `${this.label} 会话已关闭，无法发送`);
    }
    const traced = this.#redact(traceOverride ?? line);
    this.sent.push(traced);
    this.#log(`${this.label}> ${traced}`);
    this.#socketWrite(`${line}\r\n`);
  }

  #socketWrite(data: string): void {
    try {
      this.#socketRef?.(data);
    } catch (error) {
      this.#markDead(`${this.label} 写失败: ${String(error)}`);
    }
  }

  // 写句柄在构造后由 openSession 注入（避免在字段初始化器里引用 socket）
  #socketRef: ((data: string) => void) | null = null;
  #socketEnd: (() => void) | null = null;
  #socketDestroy: (() => void) | null = null;
  #socketUpgrade: (() => Promise<void> | void) | null = null;
  #socketCanUpgradeTls = false;

  /** 由工厂函数注入底层 socket 行为（write/end/destroy/upgradeTls）。 */
  bindSocket(socket: DuplexLike): void {
    this.#socketRef = (data) => socket.write(data);
    this.#socketEnd = () => socket.end();
    this.#socketDestroy = () => socket.destroy?.();
    this.#socketUpgrade = () => socket.upgradeTls?.();
    this.#socketCanUpgradeTls = typeof socket.upgradeTls === "function";
  }

  /** STARTTLS：在既有 TCP 连接上升级 TLS（仅明文口；升级后须重新 EHLO）。 */
  async upgradeTls(): Promise<void> {
    if (this.#dead) {
      throw new EmailGatewayError("connect", `${this.label} 会话已关闭，无法升级 TLS`);
    }
    if (!this.#socketCanUpgradeTls) {
      // 安全红线：不支持升级就绝不能继续明文会话
      throw new EmailGatewayError("protocol", `${this.label} socket 不支持 STARTTLS 升级，拒绝明文续传`);
    }
    await this.#socketUpgrade?.();
  }

  close(): void {
    try {
      this.#socketEnd?.();
    } catch {
      // 关闭失败不影响主流程
    }
  }

  destroy(): void {
    this.#markDeadSilently();
    try {
      this.#socketDestroy?.();
    } catch {
      // 忽略
    }
  }

  #markDeadSilently(): void {
    this.#dead = true;
    const read = this.#read;
    if (read !== null) {
      this.#read = null;
      clearTimeout(read.timer);
      read.reject(new EmailGatewayError("connect", `${this.label} 会话销毁`));
    }
  }
}

// ---------------------------------------------------------------------------
// EmailGateway
// ---------------------------------------------------------------------------

const GATEWAY_DEFAULTS = {
  smtpPort: DEFAULT_SMTP_PORT,
  imapPort: DEFAULT_IMAP_PORT,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  allowFrom: [] as string[],
  ccHuman: [] as string[],
} as const;

export class EmailGateway {
  readonly #smtp: { host: string; port: number; tls: boolean; tlsFallbackPort: number };
  readonly #imap: { host: string; port: number };
  readonly #mailbox: string;
  readonly #smtpAuth: { user: string; pass: string } | null;
  readonly #secret: A2aSharedSecret;
  readonly #allowFrom: string[];
  readonly #ccHuman: string[];
  readonly #socketFactory: SocketFactory;
  readonly #timeoutMs: number;
  readonly #clock: () => number;
  readonly #replayStore: ReplayStore;
  readonly #skewMs: number | undefined;
  readonly #auditSink: ((event: A2aGatewayAuditEvent) => void) | null;
  readonly #logSink: ((line: string) => void) | null;
  readonly #logs: string[] = [];
  readonly #traces: SessionTrace[] = [];
  readonly #audits: A2aGatewayAuditEvent[] = [];
  /** 参与脱敏的凭据片段（明文与 base64 双形态） */
  readonly #secretFragments: string[] = [];

  constructor(options: EmailGatewayOptions) {
    if (options.smtp === undefined || options.smtp.host.length === 0) {
      throw new EmailGatewayError("protocol", "options.smtp.host 必填");
    }
    if (options.imap === undefined || options.imap.host.length === 0) {
      throw new EmailGatewayError("protocol", "options.imap.host 必填");
    }
    assertAddress(options.mailbox, "mailbox");
    if (typeof options.secret !== "string" || options.secret.length === 0) {
      throw new EmailGatewayError("protocol", "secret 必须是经 a2aSecret() 标记的非空字符串");
    }
    this.#smtp = {
      host: options.smtp.host,
      port: options.smtp.port ?? GATEWAY_DEFAULTS.smtpPort,
      tls: options.smtp.tls ?? true,
      tlsFallbackPort: options.smtp.tlsFallbackPort ?? DEFAULT_SMTP_PORT,
    };
    this.#imap = {
      host: options.imap.host,
      port: options.imap.port ?? GATEWAY_DEFAULTS.imapPort,
    };
    this.#mailbox = options.mailbox;
    this.#smtpAuth = options.smtpAuth ?? null;
    this.#secret = options.secret;
    this.#allowFrom = [...(options.allowFrom ?? GATEWAY_DEFAULTS.allowFrom)];
    this.#ccHuman = [...(options.ccHuman ?? GATEWAY_DEFAULTS.ccHuman)];
    for (const addr of [...this.#allowFrom, ...this.#ccHuman]) {
      assertAddress(addr, "allowFrom/ccHuman");
    }
    this.#socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.#timeoutMs = options.timeoutMs ?? GATEWAY_DEFAULTS.timeoutMs;
    this.#clock = options.clock ?? Date.now;
    this.#replayStore = options.replayStore ?? new MemoryReplayStore();
    this.#skewMs = options.skewMs;
    this.#auditSink = options.auditSink ?? null;
    this.#logSink = options.logSink ?? null;
    if (this.#smtpAuth !== null) {
      this.#secretFragments.push(
        this.#smtpAuth.pass,
        Buffer.from(this.#smtpAuth.user, "utf8").toString("base64"),
        Buffer.from(this.#smtpAuth.pass, "utf8").toString("base64"),
      );
    }
  }

  // -------------------------------------------------------------------------
  // 观测面（测试与运维）
  // -------------------------------------------------------------------------

  /** 全部会话命令 trace（已脱敏） */
  traces(): SessionTrace[] {
    return this.#traces.map((trace) => ({ label: trace.label, tls: trace.tls, sent: [...trace.sent] }));
  }

  /** 最近一条会话 trace（已脱敏） */
  lastTrace(): SessionTrace | undefined {
    return this.traces().at(-1);
  }

  /** 结构化日志环（已脱敏；凭据位为 ***） */
  logs(): string[] {
    return [...this.#logs];
  }

  /** 审计事件环（验签/白名单拒绝） */
  audits(): A2aGatewayAuditEvent[] {
    return [...this.#audits];
  }

  #log(line: string): void {
    const safe = this.#redact(line);
    if (this.#logs.length >= MAX_LOG_LINES) this.#logs.shift();
    this.#logs.push(safe);
    this.#logSink?.(safe);
  }

  #audit(kind: "verify-rejected" | "allowlist-rejected", from: string, reason: string): void {
    const event: A2aGatewayAuditEvent = { at: this.#clock(), kind, from, reason };
    this.#audits.push(event);
    this.#log(`audit ${kind} from=${from} reason=${reason}`);
    this.#auditSink?.(event);
  }

  #redact(text: string): string {
    let out = text;
    for (const fragment of this.#secretFragments) {
      if (fragment.length > 0 && out.includes(fragment)) {
        out = out.split(fragment).join("***");
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 发送面：SMTP 最小子集
  // -------------------------------------------------------------------------

  /**
   * 发送控制信封：A2A 载荷即邮件体（JSON 化 SignedEnvelope，base64 CTE 承载），
   * 主题 `[BI-A2A] <from>→<to>`，头部 `X-BI-A2A: v1`；to 为主收件人，
   * ccHuman 追加 RCPT TO 与 MIME Cc（人类旁观控制面）。
   */
  async sendControl(env: SignedEnvelope, to: string[]): Promise<void> {
    if (!isWellFormedSignedEnvelope(env)) {
      throw new EmailGatewayError("protocol", "signed envelope 形状不合法（六协议键必填）");
    }
    if (to.length === 0) {
      throw new EmailGatewayError("protocol", "sendControl 至少需要一个收件人");
    }
    assertAddress(env.to, "envelope.to");
    assertAddress(env.from, "envelope.from");
    for (const addr of to) assertAddress(addr, "收件人");
    for (const addr of this.#ccHuman) assertAddress(addr, "ccHuman");

    const tlsMode = this.#smtp.tls ? "implicit" : "explicit";
    try {
      await this.#smtpSendSession(env, to, tlsMode);
      return;
    } catch (error) {
      if (tlsMode === "explicit" && error instanceof StartTlsRefusedError) {
        // 工单裁定：STARTTLS 被拒 → 隐式 TLS 465 直连回退（仅一次，防循环）
        this.#log(`smtp STARTTLS 被拒（${error.detail}），回退隐式 TLS ${this.#smtp.tlsFallbackPort}`);
        await this.#smtpSendSession(env, to, "implicit-fallback");
        return;
      }
      throw error;
    }
  }

  async #smtpSendSession(
    env: SignedEnvelope,
    to: string[],
    mode: "implicit" | "explicit" | "implicit-fallback",
  ): Promise<void> {
    const host = this.#smtp.host;
    const port = mode === "implicit-fallback" ? this.#smtp.tlsFallbackPort : this.#smtp.port;
    const useTls = mode !== "explicit";
    const session = await this.#openSession("smtp", host, port, useTls);
    try {
      // 1. 问候
      const greeting = await session.readLine("服务器问候");
      if (!greeting.startsWith("220")) {
        throw new EmailGatewayError("protocol", "smtp 服务器问候异常", this.#redact(greeting));
      }
      // 2. EHLO（第一轮）
      let capabilities = await this.#smtpEhlo(session);
      // 3. STARTTLS 升级（仅明文口）
      if (mode === "explicit") {
        if (!capabilities.toLowerCase().includes("starttls")) {
          throw new StartTlsRefusedError("服务器未广告 STARTTLS");
        }
        session.write("STARTTLS");
        const answer = await session.readLine("STARTTLS 应答");
        if (!answer.startsWith("220")) {
          throw new StartTlsRefusedError(this.#redact(answer));
        }
        await session.upgradeTls();
        capabilities = await this.#smtpEhlo(session); // TLS 后必须重新 EHLO
      }
      // 4. AUTH LOGIN（可选）
      if (this.#smtpAuth !== null) {
        await this.#smtpAuthLogin(session);
      }
      // 5. MAIL FROM（信封地址 = 本端信箱）
      session.write(`MAIL FROM:<${this.#mailbox}>`);
      const mailFrom = await session.readLine("MAIL FROM 应答");
      if (!isPositiveCompletion(mailFrom)) {
        throw new EmailGatewayError("protocol", "smtp MAIL FROM 被拒", this.#redact(mailFrom));
      }
      // 6. RCPT TO（主收件人 + 人类抄送）
      for (const addr of [...to, ...this.#ccHuman]) {
        session.write(`RCPT TO:<${addr}>`);
        const rcpt = await session.readLine("RCPT TO 应答");
        if (!isPositiveCompletion(rcpt)) {
          throw new EmailGatewayError("protocol", `smtp RCPT TO 被拒（序号 ${[...to, ...this.#ccHuman].indexOf(addr) + 1}）`, this.#redact(rcpt));
        }
      }
      // 7. DATA：MIME 文本邮件（A2A 载荷即邮件体）
      session.write("DATA");
      const dataGo = await session.readLine("DATA 应答");
      if (!dataGo.startsWith("354")) {
        throw new EmailGatewayError("protocol", "smtp DATA 未进入数据态", this.#redact(dataGo));
      }
      const mime = this.#buildA2aMime(env, to);
      for (const line of mime.split("\r\n")) {
        session.write(smtpDotStuff(line));
      }
      session.write("."); // 点终止（RFC 5321 §4.1.1.4）
      const accepted = await session.readLine("DATA 接收应答");
      if (!isPositiveCompletion(accepted)) {
        throw new EmailGatewayError("protocol", "smtp DATA 投递被拒", this.#redact(accepted));
      }
      // 8. QUIT（优雅收尾；发送/应答异常不视为投递失败——250 已确认受理）
      try {
        session.write("QUIT");
        await session.readLine("QUIT 应答");
      } catch {
        // 对端先关/超时：不回滚
      }
    } finally {
      this.#rememberTrace(session);
      session.close();
    }
  }

  async #smtpEhlo(session: WireSession): Promise<string> {
    session.write(`EHLO ${EHLO_NAME}`);
    const lines: string[] = [];
    for (;;) {
      const line = await session.readLine("EHLO 应答行");
      lines.push(line);
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (match === null) {
        throw new EmailGatewayError("protocol", "smtp EHLO 应答行格式异常", this.#redact(line));
      }
      const sep = match[2];
      if (sep === " ") break; // 空格结尾 = 多行最后一行
    }
    const first = lines[0];
    if (first === undefined || !first.startsWith("250")) {
      throw new EmailGatewayError("protocol", "smtp EHLO 失败", this.#redact(lines.join(" | ")));
    }
    return lines.join("\n");
  }

  async #smtpAuthLogin(session: WireSession): Promise<void> {
    const auth = this.#smtpAuth;
    if (auth === null) return;
    session.write("AUTH LOGIN");
    const userChallenge = await session.readLine("AUTH LOGIN 用户名挑战");
    if (!userChallenge.startsWith("334")) {
      throw new EmailGatewayError("auth", "smtp AUTH LOGIN 未进入用户名挑战", this.#redact(userChallenge));
    }
    // 凭据 base64 上线；trace/日志一律 ***（零数据外泄）
    session.write(Buffer.from(auth.user, "utf8").toString("base64"), "***");
    const passChallenge = await session.readLine("AUTH LOGIN 密码挑战");
    if (!passChallenge.startsWith("334")) {
      throw new EmailGatewayError("auth", "smtp AUTH LOGIN 未进入密码挑战", this.#redact(passChallenge));
    }
    session.write(Buffer.from(auth.pass, "utf8").toString("base64"), "***");
    const verdict = await session.readLine("AUTH LOGIN 结果");
    if (!verdict.startsWith("235")) {
      throw new EmailGatewayError("auth", "smtp AUTH LOGIN 鉴权失败", this.#redact(verdict));
    }
  }

  /** MIME 文本邮件：头 + base64(JSON envelope) 体。 */
  #buildA2aMime(env: SignedEnvelope, to: string[]): string {
    const headerLines: string[] = [];
    headerLines.push(`From: ${this.#mailbox}`);
    headerLines.push(`To: ${to.join(", ")}`);
    if (this.#ccHuman.length > 0) {
      headerLines.push(`Cc: ${this.#ccHuman.join(", ")}`);
    }
    const subject = `${A2A_SUBJECT_TAG} ${env.from}→${env.to}`;
    headerLines.push(`Subject: ${encodeMimeHeaderText(subject)}`);
    headerLines.push(`Date: ${new Date(this.#clock()).toUTCString()}`);
    const nonceSafe = env.nonce.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || "nonce";
    headerLines.push(`Message-ID: <${nonceSafe}@a2a-gateway>`);
    headerLines.push(`${A2A_MAIL_MARKER_HEADER}: ${A2A_MAIL_MARKER_VALUE}`);
    headerLines.push("MIME-Version: 1.0");
    headerLines.push('Content-Type: text/plain; charset=utf-8');
    headerLines.push("Content-Transfer-Encoding: base64");
    const bodyJson = JSON.stringify(env);
    const bodyB64 = Buffer.from(bodyJson, "utf8").toString("base64");
    const bodyLines: string[] = [];
    for (let i = 0; i < bodyB64.length; i += BODY_LINE_WIDTH) {
      bodyLines.push(bodyB64.slice(i, i + BODY_LINE_WIDTH));
    }
    return [...headerLines, "", ...bodyLines].join("\r\n");
  }

  // -------------------------------------------------------------------------
  // 接收面：IMAP v1（轮询级）
  // -------------------------------------------------------------------------

  /**
   * 轮询收件箱：SEARCH HEADER "X-BI-A2A" "v1" UNSEEN → FETCH → 提取 JSON →
   * verifyEnvelope（BI-15.3 五步）→ 过：结构化返回并标 \Seen；
   * 验签/白名单/JSON 失败：审计 + 仍标 \Seen（防重复处理，工单裁定）；
   * 无 X-BI-A2A 标记：非 A2A 资产，跳过（不动、不审计）。
   */
  async pollInbox(): Promise<SignedEnvelope[]> {
    const auth = this.#smtpAuth;
    if (auth === null) {
      throw new EmailGatewayError("auth", "pollInbox 需要 smtpAuth 凭据（IMAP LOGIN）");
    }
    const session = await this.#openSession("imap", this.#imap.host, this.#imap.port, true);
    const results: SignedEnvelope[] = [];
    let tagSeq = 0;
    const nextTag = (): string => `A${++tagSeq}`;
    try {
      const greeting = await session.readLine("IMAP 问候");
      if (!/^\* (OK|PREAUTH)/.test(greeting)) {
        throw new EmailGatewayError("protocol", "imap 服务器问候异常", this.#redact(greeting));
      }
      // LOGIN（凭据位 trace/log 全脱敏）
      const loginTag = nextTag();
      session.write(
        `${loginTag} LOGIN ${imapQuote(this.#mailbox)} ${imapQuote(auth.pass)}`,
        `${loginTag} LOGIN *** ***`,
      );
      await this.#imapTagged(session, loginTag, "LOGIN", "auth");
      // SELECT INBOX
      const selectTag = nextTag();
      session.write(`${selectTag} SELECT INBOX`);
      await this.#imapTagged(session, selectTag, "SELECT", "protocol");
      // SEARCH：标记过滤 + UNSEEN
      const searchTag = nextTag();
      session.write(`${searchTag} SEARCH HEADER "${A2A_MAIL_MARKER_HEADER}" "${A2A_MAIL_MARKER_VALUE}" UNSEEN`);
      const untagged = await this.#imapTagged(session, searchTag, "SEARCH", "protocol");
      const seqs = this.#parseSearchSequenceNumbers(untagged);
      // 逐封 FETCH + 处置 + \Seen
      for (const seq of seqs) {
        const raw = await this.#imapFetchMessage(session, nextTag(), seq);
        if (raw === null) continue;
        const handled = this.#processInboundMime(raw, results);
        if (handled) {
          const storeTag = nextTag();
          session.write(`${storeTag} STORE ${seq} +FLAGS (\\Seen)`);
          await this.#imapTagged(session, storeTag, "STORE", "protocol");
        }
      }
      // LOGOUT：发出即断（v1 轮询模型，连接即弃；不等待 221）
      const logoutTag = nextTag();
      session.write(`${logoutTag} LOGOUT`);
    } finally {
      this.#rememberTrace(session);
      session.close();
    }
    return results;
  }

  /** 等待 tagged 应答；返回期间收集的 untagged 行。NO/BAD 按指定类别抛错。 */
  async #imapTagged(
    session: WireSession,
    tag: string,
    what: string,
    errorKind: EmailGatewayErrorKind,
  ): Promise<string[]> {
    const untagged: string[] = [];
    for (;;) {
      const line = await session.readLine(`${what} 应答`);
      if (line.startsWith(`${tag} `)) {
        const verdict = line.slice(tag.length + 1);
        if (verdict.startsWith("OK")) return untagged;
        throw new EmailGatewayError(errorKind, `imap ${what} 被拒`, this.#redact(verdict));
      }
      untagged.push(line);
    }
  }

  /** 解析 `* SEARCH n1 n2 ...` 序号列表。 */
  #parseSearchSequenceNumbers(untagged: string[]): number[] {
    const numbers: number[] = [];
    for (const line of untagged) {
      if (!line.startsWith("* SEARCH")) continue;
      for (const match of line.slice("* SEARCH".length).matchAll(/\d+/g)) {
        const token = match[0];
        if (token !== undefined) numbers.push(Number(token));
      }
    }
    return numbers;
  }

  /** FETCH (BODY.PEEK[])：捕获第一个 {N} 字面量为原始 MIME；tagged OK 返回（无字面量 → null）。 */
  async #imapFetchMessage(session: WireSession, tag: string, seq: number): Promise<string | null> {
    session.write(`${tag} FETCH ${seq} (BODY.PEEK[])`);
    let raw: string | null = null;
    for (;;) {
      const line = await session.readLine(`FETCH ${seq} 应答`);
      if (line.startsWith(`${tag} `)) {
        if (line.slice(tag.length + 1).startsWith("OK")) return raw;
        throw new EmailGatewayError("protocol", `imap FETCH ${seq} 被拒`, this.#redact(line.slice(tag.length + 1)));
      }
      const literalMatch = /\{(\d+)\}\s*$/.exec(line);
      if (raw === null && literalMatch !== null) {
        const need = Number(literalMatch[1]);
        if (Number.isSafeInteger(need) && need >= 0) {
          raw = await session.readLiteral(need, `FETCH ${seq} 正文字面量`);
        }
      }
      // 其余 untagged 行（FLAGS 汇报等）忽略
    }
  }

  /**
   * 入站处置：提取 JSON → 五步验签 → 结果落审计。
   * 返回 true = 已按 A2A 邮件处置（调用方须标 \Seen）；false = 非 A2A 邮件（跳过）。
   */
  #processInboundMime(raw: string, results: SignedEnvelope[]): boolean {
    const mime = parseMime(raw);
    if (mime === null) {
      this.#audit("verify-rejected", "(unparseable)", "malformed");
      return true;
    }
    const marker = mime.headers.get(A2A_MAIL_MARKER_HEADER.toLowerCase());
    if (marker === undefined || marker.trim() !== A2A_MAIL_MARKER_VALUE) {
      // 无标记：非 A2A 邮件（SEARCH 之下出现属服务器异常），跳过不处置
      this.#log("imap 收到无 X-BI-A2A 标记邮件，跳过（不标 \\Seen、不审计）");
      return false;
    }
    const fromHeader = mime.headers.get("from") ?? "";
    const fromAddress = extractAddressFromHeader(decodeMimeHeaderText(fromHeader));
    // 第一层白名单（邮件 From 头；fail-closed）——BI-15.3 信封白名单为第二层
    if (!this.#allowFrom.includes(fromAddress)) {
      this.#audit("allowlist-rejected", fromAddress, "邮件 From 头不在 allowFrom（fail-closed）");
      return true;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeMimeBody(mime));
    } catch {
      this.#audit("verify-rejected", fromAddress, "malformed");
      return true;
    }
    if (!isWellFormedSignedEnvelope(parsed)) {
      this.#audit("verify-rejected", fromAddress, "malformed");
      return true;
    }
    const verdict = verifyEnvelope(parsed, {
      secret: this.#secret,
      allowFrom: this.#allowFrom,
      now: this.#clock(),
      replayStore: this.#replayStore,
      ...(this.#skewMs !== undefined ? { skewMs: this.#skewMs } : {}),
    });
    if (!verdict.valid) {
      this.#audit("verify-rejected", parsed.from, verdict.reason);
      return true;
    }
    results.push(parsed);
    return true;
  }

  // -------------------------------------------------------------------------
  // 公共连接设施
  // -------------------------------------------------------------------------

  async #openSession(label: string, host: string, port: number, tls: boolean): Promise<WireSession> {
    let socket: DuplexLike;
    try {
      socket = await this.#socketFactory(host, port, tls);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new EmailGatewayError("connect", `${label} 连接 ${host}:${port} (tls=${tls}) 失败: ${reason}`);
    }
    const session = new WireSession(label, tls, socket, this.#timeoutMs, (text) => this.#redact(text), (line) => this.#log(line));
    session.bindSocket(socket);
    return session;
  }

  #rememberTrace(session: WireSession): void {
    this.#traces.push({ label: session.label, tls: session.tls, sent: [...session.sent] });
  }
}

export default EmailGateway;
