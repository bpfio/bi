/**
 * BI-15.1 · A2A 邮件私密信令网关测试 —— 零真实网络·零真实邮箱。
 *
 * 测试红线（对齐工单）：
 * - 所有协议交互经注入的 ScriptedSocket 双工桩（脚本化 SMTP/IMAP 会话），不触碰
 *   node:net/node:tls、不监听任何端口、不访问任何真实主机/邮箱；
 * - SMTP/IMAP 命令序列逐行断言（EHLO→AUTH→MAIL→RCPT→DATA 点终止；LOGIN→SELECT→
 *   SEARCH→FETCH→STORE→LOGOUT）；
 * - 凭据零明文：traces/logs/audits/error.raw 全量扫描，断言不含明文密码与其 base64 形态；
 * - 验签过/拒、白名单 fail-closed、四类结构化错误（connect/auth/protocol/timeout）全覆盖。
 */

import { describe, expect, test } from "bun:test";
import { a2aSecret, signEnvelope, type A2aSharedSecret, type SignedEnvelope } from "../auth";
import {
  A2A_MAIL_MARKER_HEADER,
  EmailGateway,
  EmailGatewayError,
  decodeMimeHeaderText,
  encodeMimeHeaderText,
  smtpDotStuff,
  type EmailGatewayOptions,
  type SocketFactory,
} from "./a2a-email-gateway";

// ---------------------------------------------------------------------------
// 固定测试常量（凭据为本测试专用假值，绝不指向真实邮箱）
// ---------------------------------------------------------------------------

const SECRET: A2aSharedSecret = a2aSecret("bi-a2a-test-secret-0123456789abcdef");
const NOW = 1_760_000_000_000;
const MAILBOX = "controller@bi.local";
const PEER = "agent-a@bi.local";
const SMTP_USER = MAILBOX;
const PASS = "s3cr3t-PASS-w0rd!x9";
const PASS_B64 = Buffer.from(PASS, "utf8").toString("base64");
const USER_B64 = Buffer.from(SMTP_USER, "utf8").toString("base64");

let nonceSeq = 0;

function makeSigned(opts?: {
  from?: string;
  to?: string;
  ts?: number;
  payload?: unknown;
  secret?: A2aSharedSecret;
}): SignedEnvelope {
  nonceSeq += 1;
  return signEnvelope(
    {
      from: opts?.from ?? PEER,
      to: opts?.to ?? MAILBOX,
      ts: opts?.ts ?? NOW,
      nonce: `nonce-${String(nonceSeq).padStart(3, "0")}`,
      payload: opts?.payload ?? { action: "control.ping", seq: nonceSeq },
    },
    opts?.secret ?? SECRET,
  );
}

// ---------------------------------------------------------------------------
// ScriptedSocket：双工桩（脚本化服务端响应序列；记录客户端命令流）
// ---------------------------------------------------------------------------

class ScriptedSocket {
  readonly written: string[] = [];
  readonly clientLines: string[] = [];
  tlsUpgraded = false;
  endCalled = false;
  destroyCalled = false;
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  #dataCb: ((chunk: string) => void) | null = null;
  #endCb: (() => void) | null = null;
  #out = "";
  readonly #onLine: (sock: ScriptedSocket, line: string) => void;

  constructor(params: {
    host: string;
    port: number;
    tls: boolean;
    greeting?: string;
    onLine: (sock: ScriptedSocket, line: string) => void;
  }) {
    this.host = params.host;
    this.port = params.port;
    this.tls = params.tls;
    this.#onLine = params.onLine;
    if (params.greeting !== undefined) this.#out += params.greeting;
  }

  onData(cb: (chunk: string) => void): void {
    this.#dataCb = cb;
    this.#flush(); // 注册即冲刷问候语
  }

  onEnd(cb: () => void): void {
    this.#endCb = cb;
  }

  onError(_cb: (err: Error) => void): void {
    // 桩不主动产生传输错误（需要时可用 failTransport 手动触发）
  }

  /** 服务端→客户端推送任意文本（chunk 边界任意，覆盖分片场景） */
  send(text: string): void {
    this.#out += text;
    this.#flush();
  }

  #flush(): void {
    if (this.#dataCb !== null && this.#out.length > 0) {
      const data = this.#out;
      this.#out = "";
      this.#dataCb(data);
    }
  }

  write(data: string): void {
    this.written.push(data);
    let rest = data;
    for (;;) {
      const nl = rest.indexOf("\n");
      if (nl < 0) break;
      const raw = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      this.clientLines.push(line);
      this.#onLine(this, line);
    }
  }

  end(): void {
    this.endCalled = true;
    this.#endCb?.();
  }

  destroy(): void {
    this.destroyCalled = true;
  }

  upgradeTls(): void {
    this.tlsUpgraded = true;
  }
}

/** socket 工厂桩：每个用例独立注册表；failConnect=true 模拟连接拒绝。 */
function socketStub(
  server: (sock: ScriptedSocket, line: string) => void,
  opts?: { greeting?: string; failConnect?: boolean },
): { sockets: ScriptedSocket[]; factory: SocketFactory; connectAttempts: number } {
  const sockets: ScriptedSocket[] = [];
  let connectAttempts = 0;
  const factory: SocketFactory = async (host, port, tls) => {
    connectAttempts += 1;
    if (opts?.failConnect === true) {
      throw new Error(`ECONNREFUSED ${host}:${port} (stub)`);
    }
    const sock = new ScriptedSocket({ host, port, tls, greeting: opts?.greeting, onLine: server });
    sockets.push(sock);
    return sock;
  };
  return { sockets, factory, get connectAttempts() { return connectAttempts; } };
}

/** SMTP 侧桩工厂：默认 220 问候（可显式覆盖为 undefined 模拟沉默服务器）。 */
function smtpStub(
  server: (sock: ScriptedSocket, line: string) => void,
  opts?: { greeting?: string; failConnect?: boolean },
): ReturnType<typeof socketStub> {
  return socketStub(server, { greeting: "220 mail.bi.local ESMTP ready\r\n", ...opts });
}

/** IMAP 侧桩工厂：默认 `* OK` 问候。 */
function imapStub(
  server: (sock: ScriptedSocket, line: string) => void,
  opts?: { greeting?: string; failConnect?: boolean },
): ReturnType<typeof socketStub> {
  return socketStub(server, { greeting: "* OK IMAP4rev1 a2a-stub ready\r\n", ...opts });
}

// ---------------------------------------------------------------------------
// 脚本化 SMTP 服务器（PICTURE 化最小子集的对端）
// ---------------------------------------------------------------------------

interface SmtpServerOptions {
  ehloCaps?: string[];
  starttlsReply?: string;
  authMode?: "ok" | "fail535";
  mailFromReply?: string;
  rcptReject?: string;
  dataAcceptedReply?: string;
}

class FakeSmtpServer {
  inData = false;
  authStage = 0;
  authUserB64 = "";
  authPassB64 = "";
  dataBody: string[] = [];
  rcptTo: string[] = [];
  mailFrom = "";
  ehloCount = 0;
  readonly #opts: SmtpServerOptions;

  constructor(opts: SmtpServerOptions = {}) {
    this.#opts = opts;
  }

  handle = (sock: ScriptedSocket, line: string): void => {
    if (this.inData) {
      if (line === ".") {
        this.inData = false;
        sock.send((this.#opts.dataAcceptedReply ?? "250 2.0.0 queued as A2A9") + "\r\n");
      } else {
        this.dataBody.push(line);
      }
      return;
    }
    if (line.startsWith("EHLO")) {
      this.ehloCount += 1;
      const caps = this.#opts.ehloCaps ?? ["PIPELINING", "SIZE 10240000", "SMTPUTF8"];
      const lines = caps.map((cap) => `250-${cap}`);
      lines[lines.length - 1] = `250 ${caps[caps.length - 1] ?? ""}`;
      sock.send(lines.join("\r\n") + "\r\n");
      return;
    }
    if (line === "STARTTLS") {
      sock.send((this.#opts.starttlsReply ?? "220 2.0.0 Ready to start TLS") + "\r\n");
      return;
    }
    if (line === "AUTH LOGIN") {
      sock.send(`334 ${Buffer.from("Username:", "utf8").toString("base64")}\r\n`);
      this.authStage = 1;
      return;
    }
    if (this.authStage === 1) {
      this.authUserB64 = line;
      this.authStage = 0;
      if (this.#opts.authMode === "fail535") {
        sock.send("535 5.7.8 Bad credentials\r\n");
        return;
      }
      this.authStage = 2;
      sock.send(`334 ${Buffer.from("Password:", "utf8").toString("base64")}\r\n`);
      return;
    }
    if (this.authStage === 2) {
      this.authPassB64 = line;
      this.authStage = 0;
      sock.send(this.#opts.authMode === "fail535" ? "535 5.7.8 Bad credentials\r\n" : "235 2.7.0 Authentication successful\r\n");
      return;
    }
    if (line.startsWith("MAIL FROM:")) {
      this.mailFrom = line;
      sock.send((this.#opts.mailFromReply ?? "250 2.1.0 Ok") + "\r\n");
      return;
    }
    if (line.startsWith("RCPT TO:")) {
      this.rcptTo.push(line);
      if (this.#opts.rcptReject !== undefined && line.includes(this.#opts.rcptReject)) {
        sock.send("550 5.1.1 mailbox unavailable\r\n");
        return;
      }
      sock.send("250 2.1.5 Ok\r\n");
      return;
    }
    if (line === "DATA") {
      this.inData = true;
      sock.send("354 End data with <CR><LF>.<CR><LF>\r\n");
      return;
    }
    if (line === "QUIT") {
      sock.send("221 2.0.0 Bye\r\n");
      return;
    }
    sock.send("500 5.5.2 unrecognized command\r\n");
  };
}

// ---------------------------------------------------------------------------
// 脚本化 IMAP 服务器（v1 轮询级对端）
// ---------------------------------------------------------------------------

interface ImapServerOptions {
  searchResult?: number[];
  messages?: Map<number, string>;
  loginReply?: "OK" | "NO";
  selectReply?: "OK" | "NO";
  hangOn?: "SEARCH" | "SELECT";
  splitLiteral?: boolean;
}

class FakeImapServer {
  storeCalls: string[] = [];
  fetchSeqs: number[] = [];
  readonly #opts: ImapServerOptions;

  constructor(opts: ImapServerOptions = {}) {
    this.#opts = opts;
  }

  handle = (sock: ScriptedSocket, line: string): void => {
    const match = /^(\S+) (.+)$/.exec(line);
    if (match === null) {
      sock.send("* BAD invalid\r\n");
      return;
    }
    const tag = match[1] ?? "";
    const rest = match[2] ?? "";
    if (rest.startsWith("LOGIN ")) {
      sock.send(`${tag} ${this.#opts.loginReply === "NO" ? "NO login refused" : "OK [CAPABILITY IMAP4rev1] logged in"}\r\n`);
      return;
    }
    if (rest === "SELECT INBOX") {
      if (this.#opts.hangOn === "SELECT") return; // 脚本化挂起 → 触发超时
      sock.send(`* 8 EXISTS\r\n* OK [UIDVALIDITY 42] UIDs valid\r\n${tag} ${this.#opts.selectReply === "NO" ? "NO mailbox locked" : "OK [READ-WRITE] select completed"}\r\n`);
      return;
    }
    if (rest.startsWith("SEARCH ")) {
      if (this.#opts.hangOn === "SEARCH") return; // 脚本化挂起 → 触发超时
      const seqs = this.#opts.searchResult ?? [];
      sock.send((seqs.length > 0 ? `* SEARCH ${seqs.join(" ")}\r\n` : "* SEARCH\r\n") + `${tag} OK search completed\r\n`);
      return;
    }
    if (rest.startsWith("FETCH ")) {
      const seqToken = rest.slice("FETCH ".length).split(" ")[0] ?? "0";
      const seq = Number(seqToken);
      const mime = this.#opts.messages?.get(seq);
      if (mime === undefined) {
        sock.send(`${tag} NO no such message\r\n`);
        return;
      }
      this.fetchSeqs.push(seq);
      if (this.#opts.splitLiteral === true) {
        // 字面量任意分片（含 {N} 行本身分片），验证跨 chunk 重组
        const head = `* ${seq} FETCH (BODY[] {${mime.length}}\r\n`;
        sock.send(head.slice(0, 8));
        sock.send(head.slice(8));
        sock.send(mime.slice(0, 13));
        sock.send(mime.slice(13) + "\r\n)\r\n" + `${tag} OK fetch completed\r\n`);
        return;
      }
      sock.send(`* ${seq} FETCH (BODY[] {${mime.length}}\r\n`);
      sock.send(mime + "\r\n)\r\n" + `${tag} OK fetch completed\r\n`);
      return;
    }
    if (rest.startsWith("STORE ")) {
      this.storeCalls.push(rest);
      const seqToken = rest.slice("STORE ".length).split(" ")[0] ?? "0";
      sock.send(`* ${seqToken} FETCH (FLAGS (\\Seen))\r\n${tag} OK store completed\r\n`);
      return;
    }
    if (rest === "LOGOUT") {
      sock.send(`* BYE bye\r\n${tag} OK logout completed\r\n`);
      return;
    }
    sock.send(`${tag} BAD unknown command\r\n`);
  };
}

// ---------------------------------------------------------------------------
// MIME 邮件构造（测试侧独立实现协议契约，不反向依赖实现细节）
// ---------------------------------------------------------------------------

function chunk76(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 76) out.push(value.slice(i, i + 76));
  return out;
}

function buildA2aMail(
  signed: SignedEnvelope,
  opts?: { from?: string; marker?: string | null; cte?: "base64" | "8bit" },
): string {
  const from = opts?.from ?? PEER;
  const cte = opts?.cte ?? "base64";
  const json = JSON.stringify(signed);
  const body = cte === "base64" ? chunk76(Buffer.from(json, "utf8").toString("base64")).join("\r\n") : json;
  const headers = [
    `From: ${from}`,
    `To: ${MAILBOX}`,
    `Subject: [BI-A2A] ${signed.from}→${signed.to}`,
  ];
  if (opts?.marker !== null) {
    headers.push(`${A2A_MAIL_MARKER_HEADER}: ${opts?.marker ?? "v1"}`);
  }
  headers.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", `Content-Transfer-Encoding: ${cte}`);
  return [...headers, "", body].join("\r\n");
}

// ---------------------------------------------------------------------------
// 网关 fixture 与断言工具
// ---------------------------------------------------------------------------

function makeGateway(factory: SocketFactory, overrides?: Partial<EmailGatewayOptions>): EmailGateway {
  return new EmailGateway({
    smtp: { host: "smtp.bi.local", port: 465, tls: true },
    imap: { host: "imap.bi.local", port: 993 },
    mailbox: MAILBOX,
    smtpAuth: { user: SMTP_USER, pass: PASS },
    secret: SECRET,
    allowFrom: [PEER],
    timeoutMs: 500,
    clock: () => NOW,
    socketFactory: factory,
    ...overrides,
  });
}

async function capture(promise: Promise<unknown>): Promise<EmailGatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EmailGatewayError) return error;
    throw error;
  }
  throw new Error("expected promise to reject with EmailGatewayError");
}

/** 零数据外泄：traces/logs/audits 全量扫描，断言无明文密码与其 base64 形态。 */
function expectNoCredentialLeak(gateway: EmailGateway): void {
  const blob = JSON.stringify({ t: gateway.traces(), l: gateway.logs(), a: gateway.audits() });
  expect(blob).not.toContain(PASS);
  expect(blob).not.toContain(PASS_B64);
  expect(blob).not.toContain(USER_B64);
  expect(blob).toContain("***");
}

// ===========================================================================
// A · SMTP 发送面
// ===========================================================================

describe("BI-15.1 · SMTP 发送面", () => {
  test("最小命令序列：EHLO→MAIL FROM→RCPT TO→DATA→点终止→QUIT 逐行断言", async () => {
    const server = new FakeSmtpServer();
    const { sockets, factory } = smtpStub(server.handle, { greeting: "220 mail.bi.local ESMTP ready\r\n" });
    const gateway = makeGateway(factory);
    const signed = makeSigned({ to: "agent-b@bi.local" });
    await gateway.sendControl(signed, ["agent-b@bi.local"]);

    const trace = gateway.lastTrace();
    expect(trace?.label).toBe("smtp");
    expect(trace?.tls).toBe(true);
    expect(trace?.sent[0]).toBe("EHLO a2a-email-gateway");
    expect(trace?.sent[1]).toBe("AUTH LOGIN");
    expect(trace?.sent[2]).toBe("***");
    expect(trace?.sent[3]).toBe("***");
    expect(trace?.sent[4]).toBe("MAIL FROM:<controller@bi.local>");
    expect(trace?.sent[5]).toBe("RCPT TO:<agent-b@bi.local>");
    expect(trace?.sent[6]).toBe("DATA");
    expect(trace?.sent.at(-1)).toBe("QUIT");
    expect(trace?.sent.at(-2)).toBe(".");
    // 服务器视角同一序列（AUTH 凭据为 base64 明文上线，属协议要求；日志/trace 侧脱敏另测）
    expect(sockets[0]?.clientLines[0]).toBe("EHLO a2a-email-gateway");
    expect(sockets[0]?.clientLines[1]).toBe("AUTH LOGIN");
    expect(sockets[0]?.clientLines[2]).toBe(USER_B64);
    expect(sockets[0]?.clientLines[3]).toBe(PASS_B64);
    expect(sockets[0]?.clientLines[4]).toBe("MAIL FROM:<controller@bi.local>");
    expect(sockets[0]?.clientLines[5]).toBe("RCPT TO:<agent-b@bi.local>");
    expect(sockets[0]?.clientLines[6]).toBe("DATA");
    expect(sockets[0]?.clientLines.at(-2)).toBe(".");
    expect(sockets[0]?.clientLines.at(-1)).toBe("QUIT");
    // 优雅关闭
    expect(sockets[0]?.endCalled).toBe(true);
    expect(server.mailFrom).toBe("MAIL FROM:<controller@bi.local>");
  });

  test("AUTH LOGIN：挑战序列 + 凭据 base64 上线 + trace 脱敏为 ***", async () => {
    const server = new FakeSmtpServer();
    const { factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory);
    await gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local"]);

    expect(server.authUserB64).toBe(USER_B64);
    expect(server.authPassB64).toBe(PASS_B64);
    const sent = gateway.lastTrace()?.sent ?? [];
    expect(sent).toContain("AUTH LOGIN");
    expect(sent).toContain("***");
    // base64 凭据行不得原样出现在 trace
    expect(sent).not.toContain(USER_B64);
    expect(sent).not.toContain(PASS_B64);
  });

  test("凭据零明文：traces/logs/audits/logSink 全量扫描无密码明文与 base64 形态", async () => {
    const sinkLines: string[] = [];
    const server = new FakeSmtpServer({ authMode: "fail535" });
    const { factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory, { logSink: (line) => sinkLines.push(line) });
    await capture(gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local"]));
    expectNoCredentialLeak(gateway);
    expect(sinkLines.join("\n")).not.toContain(PASS);
    expect(sinkLines.join("\n")).not.toContain(PASS_B64);
    // 失败审计路径同样脱敏
    const error = await capture(gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local"]));
    expect(error.raw).not.toContain(PASS);
    expect(error.raw).not.toContain(PASS_B64);
  });

  test("EHLO 多行能力解析：250- 续行收齐后才继续 MAIL", async () => {
    const server = new FakeSmtpServer({ ehloCaps: ["PIPELINING", "SIZE 10240000", "AUTH LOGIN PLAIN", "STARTTLS", "SMTPUTF8"] });
    const { sockets, factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory);
    await gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local"]);
    // 5 行能力全收（隐式 TLS 模式不发起 STARTTLS，仅解析）
    expect(server.ehloCount).toBe(1);
    expect(sockets[0]?.clientLines.filter((line) => line === "STARTTLS")).toHaveLength(0);
    expect(sockets[0]?.clientLines).toContain("MAIL FROM:<controller@bi.local>");
  });

  test("STARTTLS 升级：明文口广告 STARTTLS → 220 → upgradeTls → 重新 EHLO → 投递成功", async () => {
    const server = new FakeSmtpServer({ ehloCaps: ["PIPELINING", "STARTTLS", "SMTPUTF8"] });
    const { sockets, factory } = smtpStub(server.handle, { greeting: "220 mail.bi.local ESMTP ready\r\n" });
    const gateway = makeGateway(factory, { smtp: { host: "smtp.bi.local", port: 25, tls: false } });
    await gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local"]);

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.tls).toBe(false);
    expect(sockets[0]?.tlsUpgraded).toBe(true);
    expect(server.ehloCount).toBe(2); // TLS 后重新 EHLO
    expect(gateway.lastTrace()?.sent).toContain("STARTTLS");
    expect(gateway.lastTrace()?.tls).toBe(false);
    expect(server.rcptTo).toEqual(["RCPT TO:<agent-b@bi.local>"]);
  });

  test("STARTTLS 被拒（454）→ 回退隐式 TLS 465 直连，第二个会话投递成功", async () => {
    const server = new FakeSmtpServer({ ehloCaps: ["PIPELINING", "STARTTLS", "SMTPUTF8"], starttlsReply: "454 4.7.0 TLS not available" });
    const { sockets, factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory, {
      smtp: { host: "smtp.bi.local", port: 25, tls: false, tlsFallbackPort: 465 },
    });
    await gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local"]);

    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.tls).toBe(false);
    expect(sockets[0]?.tlsUpgraded).toBe(false);
    expect(sockets[0]?.port).toBe(25);
    expect(sockets[1]?.tls).toBe(true);
    expect(sockets[1]?.port).toBe(465);
    const traces = gateway.traces();
    expect(traces).toHaveLength(2);
    expect(traces[0]?.tls).toBe(false);
    expect(traces[1]?.tls).toBe(true);
    expect(traces[1]?.sent[0]).toBe("EHLO a2a-email-gateway");
    expect(server.rcptTo).toEqual(["RCPT TO:<agent-b@bi.local>"]);
  });

  test("多收件人 + ccHuman：RCPT TO 覆盖全部 to 与 cc，MIME 含 Cc 头", async () => {
    const server = new FakeSmtpServer();
    const { factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory, { ccHuman: ["human@corp.test"] });
    await gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local", "agent-c@bi.local"]);

    expect(server.rcptTo).toEqual([
      "RCPT TO:<agent-b@bi.local>",
      "RCPT TO:<agent-c@bi.local>",
      "RCPT TO:<human@corp.test>",
    ]);
    const mime = server.dataBody.join("\r\n");
    expect(mime).toContain("To: agent-b@bi.local, agent-c@bi.local");
    expect(mime).toContain("Cc: human@corp.test");
  });

  test("MIME 结构：X-BI-A2A 标记、主题 encoded-word 往返、base64 CTE、From/To", async () => {
    const server = new FakeSmtpServer();
    const { factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory);
    const signed = makeSigned({ to: "agent-b@bi.local" });
    await gateway.sendControl(signed, ["agent-b@bi.local"]);

    const mime = server.dataBody.join("\r\n");
    expect(mime).toContain(`${A2A_MAIL_MARKER_HEADER}: v1`);
    expect(mime).toContain("MIME-Version: 1.0");
    expect(mime).toContain("Content-Type: text/plain; charset=utf-8");
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    expect(mime).toContain(`From: ${MAILBOX}`);
    expect(mime).toContain("To: agent-b@bi.local");
    const subjectLine = mime.split("\r\n").find((line) => line.startsWith("Subject:")) ?? "";
    expect(subjectLine).toContain("=?UTF-8?B?"); // 非 ASCII（→）走 RFC 2047
    expect(decodeMimeHeaderText(subjectLine.slice("Subject: ".length))).toBe(
      "[BI-A2A] agent-a@bi.local→agent-b@bi.local",
    );
    // 正文 = JSON 化 envelope（base64 承载）
    const body = mime.split("\r\n\r\n")[1] ?? "";
    const decoded = JSON.parse(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")) as SignedEnvelope;
    expect(decoded).toEqual(signed);
    expect(decoded.signature).toBe(signed.signature);
  });

  test("JSON 载荷含 unicode（中文/emoji/换行）经 MIME 往返值完整", async () => {
    const server = new FakeSmtpServer();
    const { factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory);
    const payload = { note: "中文载荷→🎯", lines: ["第一行\n第二行", "tab\t制表"] };
    const signed = makeSigned({ to: "agent-b@bi.local", payload });
    await gateway.sendControl(signed, ["agent-b@bi.local"]);

    const body = server.dataBody.join("\r\n").split("\r\n\r\n")[1] ?? "";
    const decoded = JSON.parse(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")) as SignedEnvelope;
    expect(decoded.payload).toEqual(payload);
    expect(decoded.nonce).toBe(signed.nonce);
  });

  test("点 stuffing：单元行为 + DATA 终止行单独成行 + base64 正文不误触发", () => {
    expect(smtpDotStuff(".")).toBe("..");
    expect(smtpDotStuff(".lead")).toBe("..lead");
    expect(smtpDotStuff("abc")).toBe("abc");
    expect(smtpDotStuff("")).toBe("");
  });

  test("DATA 点终止：wire 以 \\r\\n.\\r\\n 收尾，正文行无 stuffing 副作用", async () => {
    const server = new FakeSmtpServer();
    const { sockets, factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory);
    await gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local"]);
    const wire = sockets[0]?.written.join("") ?? "";
    expect(wire).toContain("\r\n.\r\n");
    expect(server.dataBody.every((line) => !line.startsWith(".."))).toBe(true);
  });

  test("MAIL FROM 被拒（550）→ protocol 错误携带脱敏原始响应行", async () => {
    const server = new FakeSmtpServer({ mailFromReply: "550 5.1.1 sender blocked" });
    const { sockets, factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory);
    const error = await capture(gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local"]));
    expect(error.kind).toBe("protocol");
    expect(error.raw).toContain("550");
    expect(sockets[0]?.endCalled).toBe(true);
  });

  test("AUTH 鉴权失败（535）→ auth 错误", async () => {
    const server = new FakeSmtpServer({ authMode: "fail535" });
    const { factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory);
    const error = await capture(gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local"]));
    expect(error.kind).toBe("auth");
    expect(error.raw).toContain("535");
  });

  test("连接拒绝 → connect 错误", async () => {
    const stub = smtpStub(() => {}, { failConnect: true });
    const gateway = makeGateway(stub.factory);
    const error = await capture(gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local"]));
    expect(error.kind).toBe("connect");
    expect(error.message).toContain("ECONNREFUSED");
    expect(stub.connectAttempts).toBe(1);
  });

  test("问候超时 → timeout 错误并销毁连接", async () => {
    const { sockets, factory } = smtpStub(() => {}, { greeting: undefined }); // 服务器全程沉默
    const gateway = makeGateway(factory, { timeoutMs: 25 });
    const error = await capture(gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local"]));
    expect(error.kind).toBe("timeout");
    expect(sockets[0]?.destroyCalled).toBe(true);
  });

  test("DATA 投递被拒（554）→ protocol 错误", async () => {
    const server = new FakeSmtpServer({ dataAcceptedReply: "554 5.0.0 message rejected" });
    const { factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory);
    const error = await capture(gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local"]));
    expect(error.kind).toBe("protocol");
    expect(error.raw).toContain("554");
  });

  test("地址注入防护：收件人含 CRLF 注入 → protocol 错误且 wire 无注入痕迹", async () => {
    const server = new FakeSmtpServer();
    const { sockets, factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory);
    const error = await capture(gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["victim@x.test\r\nBCC: evil@z.test"]));
    expect(error.kind).toBe("protocol");
    expect(error.message).not.toContain("victim@x.test");
    expect(sockets).toHaveLength(0); // 校验先于任何连接
  });

  test("envelope 形状不合法（缺 signature）→ protocol 错误且未建连", async () => {
    const server = new FakeSmtpServer();
    const { sockets, factory, connectAttempts } = smtpStub(server.handle);
    const gateway = makeGateway(factory);
    const bad = { from: PEER, to: "agent-b@bi.local", ts: NOW, nonce: "n1", payload: {} } as unknown as SignedEnvelope;
    const error = await capture(gateway.sendControl(bad, ["agent-b@bi.local"]));
    expect(error.kind).toBe("protocol");
    expect(sockets).toHaveLength(0);
    expect(connectAttempts).toBe(0);
  });

  test("RCPT 被拒（550）→ protocol 错误，错误前已发出的命令可审计", async () => {
    const server = new FakeSmtpServer({ rcptReject: "agent-c@bi.local" });
    const { factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory);
    const error = await capture(
      gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local", "agent-c@bi.local"]),
    );
    expect(error.kind).toBe("protocol");
    expect(error.raw).toContain("550");
    const sent = gateway.lastTrace()?.sent ?? [];
    expect(sent).toContain("RCPT TO:<agent-b@bi.local>"); // 前一收件人已发出
  });

  test("smtpAuth 缺省：跳过 AUTH 直接 MAIL FROM（匿名中继场景）", async () => {
    const server = new FakeSmtpServer();
    const { factory } = smtpStub(server.handle);
    const gateway = makeGateway(factory, { smtpAuth: undefined });
    await gateway.sendControl(makeSigned({ to: "agent-b@bi.local" }), ["agent-b@bi.local"]);
    const sent = gateway.lastTrace()?.sent ?? [];
    expect(sent.some((line) => line.startsWith("AUTH"))).toBe(false);
    expect(sent[1]).toBe("MAIL FROM:<controller@bi.local>");
  });
});

// ===========================================================================
// B · IMAP 接收面
// ===========================================================================

describe("BI-15.1 · IMAP 接收面", () => {
  test("正常单封：LOGIN→SELECT→SEARCH→FETCH→STORE→LOGOUT 序列断言 + 信封结构化返回", async () => {
    const signed = makeSigned();
    const server = new FakeImapServer({ searchResult: [1], messages: new Map([[1, buildA2aMail(signed)]]) });
    const { factory } = imapStub(server.handle, { greeting: "* OK IMAP4rev1 a2a-stub ready\r\n" });
    const gateway = makeGateway(factory);
    const results = await gateway.pollInbox();

    expect(results).toEqual([signed]);
    const trace = gateway.lastTrace();
    expect(trace?.label).toBe("imap");
    expect(trace?.tls).toBe(true);
    expect(trace?.sent[0]).toBe("A1 LOGIN *** ***");
    expect(trace?.sent[1]).toBe("A2 SELECT INBOX");
    expect(trace?.sent[2]).toBe(`A3 SEARCH HEADER "${A2A_MAIL_MARKER_HEADER}" "v1" UNSEEN`);
    expect(trace?.sent[3]).toBe("A4 FETCH 1 (BODY.PEEK[])");
    expect(trace?.sent[4]).toBe("A5 STORE 1 +FLAGS (\\Seen)");
    expect(trace?.sent[5]).toBe("A6 LOGOUT");
    expect(server.storeCalls).toEqual(["STORE 1 +FLAGS (\\Seen)"]);
    expect(server.fetchSeqs).toEqual([1]);
  });

  test("LOGIN trace 脱敏 + 全量扫描无凭据明文（IMAP 侧）", async () => {
    const signed = makeSigned();
    const server = new FakeImapServer({ searchResult: [1], messages: new Map([[1, buildA2aMail(signed)]]) });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory);
    await gateway.pollInbox();
    expectNoCredentialLeak(gateway);
  });

  test("SEARCH 空结果：返回空数组，不 FETCH 不 STORE", async () => {
    const server = new FakeImapServer({ searchResult: [] });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory);
    const results = await gateway.pollInbox();
    expect(results).toEqual([]);
    expect(server.fetchSeqs).toEqual([]);
    expect(server.storeCalls).toEqual([]);
  });

  test("验签失败（坏签名）：不返回 + 审计 bad-signature + 仍标 \\Seen 防重复处理", async () => {
    const signed = makeSigned();
    const tampered = { ...signed, signature: Buffer.from("forged-by-zzz", "utf8").toString("base64url") };
    const server = new FakeImapServer({ searchResult: [1], messages: new Map([[1, buildA2aMail(tampered)]]) });
    const { factory } = imapStub(server.handle);
    const sinkEvents: unknown[] = [];
    const gateway = makeGateway(factory, { auditSink: (event) => sinkEvents.push(event) });
    const results = await gateway.pollInbox();

    expect(results).toEqual([]);
    expect(gateway.audits()).toHaveLength(1);
    expect(gateway.audits()[0]?.kind).toBe("verify-rejected");
    expect(gateway.audits()[0]?.reason).toBe("bad-signature");
    expect(gateway.audits()[0]?.from).toBe(PEER);
    expect(gateway.audits()[0]?.at).toBe(NOW);
    expect(sinkEvents).toHaveLength(1);
    expect(server.storeCalls).toEqual(["STORE 1 +FLAGS (\\Seen)"]); // 工单裁定：标 seen 防重复处理
  });

  test("白名单外发件人（邮件 From 头）：审计 allowlist-rejected + 标 \\Seen + 不返回", async () => {
    const signed = makeSigned();
    const server = new FakeImapServer({
      searchResult: [1],
      messages: new Map([[1, buildA2aMail(signed, { from: "Intruder <intruder@evil.test>" })]]),
    });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory);
    const results = await gateway.pollInbox();

    expect(results).toEqual([]);
    expect(gateway.audits()).toEqual([
      { at: NOW, kind: "allowlist-rejected", from: "intruder@evil.test", reason: "邮件 From 头不在 allowFrom（fail-closed）" },
    ]);
    expect(server.storeCalls).toEqual(["STORE 1 +FLAGS (\\Seen)"]);
  });

  test("allowFrom 空数组 fail-closed：一切发件人（含合法签名）均在第一层被拒", async () => {
    const signed = makeSigned();
    const server = new FakeImapServer({ searchResult: [1], messages: new Map([[1, buildA2aMail(signed)]]) });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory, { allowFrom: [] });
    const results = await gateway.pollInbox();

    expect(results).toEqual([]);
    expect(gateway.audits()[0]?.kind).toBe("allowlist-rejected");
    expect(gateway.audits()[0]?.from).toBe(PEER);
    expect(server.storeCalls).toHaveLength(1); // 已按 A2A 邮件处置 → 标 \Seen
  });

  test("allowFrom fail-closed 双层：邮件 From 头过闸、信封 from 非白名单仍拒（unknown-sender）", async () => {
    // 双层语义：邮件 From 头（第一层，可被伪造）与信封 from（第二层，密钥绑定）必须都在白名单内
    const ghost = makeSigned({ from: "ghost@beyond.test" }); // 信封 from 不在白名单
    const server = new FakeImapServer({
      searchResult: [1],
      messages: new Map([[1, buildA2aMail(ghost, { from: PEER })]]), // 邮件头 From 在白名单
    });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory, { allowFrom: [PEER] });
    const results = await gateway.pollInbox();

    expect(results).toEqual([]);
    expect(gateway.audits()).toHaveLength(1);
    expect(gateway.audits()[0]?.kind).toBe("verify-rejected");
    expect(gateway.audits()[0]?.reason).toBe("unknown-sender");
    expect(gateway.audits()[0]?.from).toBe("ghost@beyond.test");
    expect(server.storeCalls).toHaveLength(1);
  });

  test("JSON 体损坏：审计 malformed + 标 \\Seen", async () => {
    const broken = "From: agent-a@bi.local\r\nTo: controller@bi.local\r\nX-BI-A2A: v1\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\neyJicm9rZW4iOiJub3QtYW4tZW52ZWxvcGU\r\n";
    const server = new FakeImapServer({ searchResult: [1], messages: new Map([[1, broken]]) });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory);
    const results = await gateway.pollInbox();

    expect(results).toEqual([]);
    expect(gateway.audits()[0]?.reason).toBe("malformed");
    expect(server.storeCalls).toHaveLength(1);
  });

  test("无 X-BI-A2A 标记邮件：非 A2A 资产跳过——不返回、不 STORE、不审计", async () => {
    const signed = makeSigned();
    const server = new FakeImapServer({ searchResult: [1], messages: new Map([[1, buildA2aMail(signed, { marker: null })]]) });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory);
    const results = await gateway.pollInbox();

    expect(results).toEqual([]);
    expect(gateway.audits()).toEqual([]);
    expect(server.storeCalls).toEqual([]);
    expect(gateway.logs().some((line) => line.includes("X-BI-A2A"))).toBe(true);
  });

  test("混合多封：2 过 1 拒 → 返回 2、审计 1、全部标 \\Seen", async () => {
    const s1 = makeSigned();
    const s2 = makeSigned({ payload: { action: "control.pong" } });
    const s3 = makeSigned();
    const forged = { ...s3, signature: Buffer.from("nope", "utf8").toString("base64url") };
    const server = new FakeImapServer({
      searchResult: [1, 2, 3],
      messages: new Map([
        [1, buildA2aMail(s1)],
        [2, buildA2aMail(s2)],
        [3, buildA2aMail(forged)],
      ]),
    });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory);
    const results = await gateway.pollInbox();

    expect(results).toEqual([s1, s2]);
    expect(gateway.audits()).toHaveLength(1);
    expect(gateway.audits()[0]?.reason).toBe("bad-signature");
    expect(server.storeCalls).toHaveLength(3);
    expect(server.fetchSeqs).toEqual([1, 2, 3]);
  });

  test("nonce 防重放：同信封重复投递 → 第二封审计 replayed 不返回，两封均标 \\Seen", async () => {
    const signed = makeSigned();
    const mail = buildA2aMail(signed);
    const server = new FakeImapServer({
      searchResult: [1, 2],
      messages: new Map([[1, mail], [2, mail]]),
    });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory);
    const results = await gateway.pollInbox();

    expect(results).toEqual([signed]);
    expect(gateway.audits()).toHaveLength(1);
    expect(gateway.audits()[0]?.reason).toBe("replayed");
    expect(server.storeCalls).toHaveLength(2);
  });

  test("时钟注入：过期信封（超出偏斜窗）→ 审计 expired + 标 \\Seen + 不返回", async () => {
    const stale = makeSigned({ ts: NOW - 400_000 }); // > 5 分钟窗
    const server = new FakeImapServer({ searchResult: [1], messages: new Map([[1, buildA2aMail(stale)]]) });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory);
    const results = await gateway.pollInbox();

    expect(results).toEqual([]);
    expect(gateway.audits()[0]?.reason).toBe("expired");
    expect(server.storeCalls).toHaveLength(1);
  });

  test("From 头 display-name 形式：提取纯地址后命中白名单", async () => {
    const signed = makeSigned();
    const server = new FakeImapServer({
      searchResult: [1],
      messages: new Map([[1, buildA2aMail(signed, { from: "Agent A <agent-a@bi.local>" })]]),
    });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory);
    const results = await gateway.pollInbox();
    expect(results).toEqual([signed]);
    expect(gateway.audits()).toEqual([]);
  });

  test("8bit CTE 入站（外来邮件形态）：正文按原文提取并验签通过", async () => {
    const signed = makeSigned({ payload: { note: "中文 8bit 直排" } });
    const server = new FakeImapServer({
      searchResult: [1],
      messages: new Map([[1, buildA2aMail(signed, { cte: "8bit" })]]),
    });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory);
    const results = await gateway.pollInbox();
    expect(results).toEqual([signed]);
  });

  test("FETCH 字面量任意分片：{N} 行与正文跨 chunk 重组正确", async () => {
    const signed = makeSigned();
    const server = new FakeImapServer({ searchResult: [1], messages: new Map([[1, buildA2aMail(signed)]]), splitLiteral: true });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory);
    const results = await gateway.pollInbox();
    expect(results).toEqual([signed]);
  });

  test("LOGIN 被拒（tagged NO）→ auth 错误", async () => {
    const server = new FakeImapServer({ loginReply: "NO" });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory);
    const error = await capture(gateway.pollInbox());
    expect(error.kind).toBe("auth");
    expect(error.raw).toContain("NO");
  });

  test("SELECT 被拒（tagged NO）→ protocol 错误", async () => {
    const server = new FakeImapServer({ selectReply: "NO" });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory);
    const error = await capture(gateway.pollInbox());
    expect(error.kind).toBe("protocol");
  });

  test("SEARCH 超时 → timeout 错误", async () => {
    const server = new FakeImapServer({ hangOn: "SEARCH" });
    const { factory } = imapStub(server.handle);
    const gateway = makeGateway(factory, { timeoutMs: 25 });
    const error = await capture(gateway.pollInbox());
    expect(error.kind).toBe("timeout");
  });

  test("连接拒绝 → connect 错误", async () => {
    const { factory } = imapStub(() => {}, { failConnect: true });
    const gateway = makeGateway(factory);
    const error = await capture(gateway.pollInbox());
    expect(error.kind).toBe("connect");
  });

  test("IMAP 问候异常（* BYE）→ protocol 错误", async () => {
    const server = new FakeImapServer();
    const { factory } = imapStub(server.handle, { greeting: "* BYE shutting down\r\n" });
    const gateway = makeGateway(factory);
    const error = await capture(gateway.pollInbox());
    expect(error.kind).toBe("protocol");
    expect(error.raw).toContain("BYE");
  });

  test("smtpAuth 缺省：pollInbox 拒绝执行（IMAP LOGIN 需凭据）", async () => {
    const { factory, connectAttempts } = imapStub(() => {});
    const gateway = makeGateway(factory, { smtpAuth: undefined });
    const error = await capture(gateway.pollInbox());
    expect(error.kind).toBe("auth");
    expect(connectAttempts).toBe(0);
  });
});

// ===========================================================================
// C · 协议工具单元
// ===========================================================================

describe("BI-15.1 · 协议工具单元", () => {
  test("RFC 2047 编解码往返：非 ASCII 编码、ASCII 原样", () => {
    const subject = "[BI-A2A] agent-a→controller（中文）🎯";
    const encoded = encodeMimeHeaderText(subject);
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(decodeMimeHeaderText(encoded)).toBe(subject);
    expect(encodeMimeHeaderText("plain-ascii subject")).toBe("plain-ascii subject");
    expect(decodeMimeHeaderText("plain-ascii subject")).toBe("plain-ascii subject");
  });

  test("点 stuffing：dot 前缀行加填、其余不动", () => {
    expect(smtpDotStuff("..double")).toBe("...double");
    expect(smtpDotStuff("no dot")).toBe("no dot");
  });
});
