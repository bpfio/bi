/**
 * BI-06.8 — Deterministic shell lexical scanner (pure TypeScript, zero deps).
 *
 * `scanShell` is a pure function: no IO, no randomness, no clock — the same
 * input always yields the exact same `ScanResult`. It performs a three phase
 * analysis:
 *
 *   1. Lexing     — words, operators, four quoting states, all parameter /
 *                   command / arithmetic expansions, comments, line
 *                   continuations, tilde expansion, CRLF tolerance, heredoc
 *                   body capture on raw byte spans.
 *   2. Statement  — pipelines, and-or lists, compound commands (if/for/
 *      breakdown    while/until/case/function/subshell/group), heredocs,
 *                   redirects (full fd matrix), env-assignment prefixes and
 *                   well-known command modifier prefixes.
 *   3. Grading    — each statement is graded `safe` | `opaque` | `dangerous`
 *                   with stable machine-readable reason strings.
 *
 * Fail-closed: any budget violation (input length / token count / nesting
 * depth) or construct this scanner does not model (e.g. zsh-only syntax)
 * grades the whole input `opaque` instead of guessing.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Expansion kinds tracked by the lexer. */
export type ExpansionKind =
  | "var" // $VAR / ${VAR...} / special params
  | "cmdsub" // $(...) or legacy `...`
  | "arith" // $((...))
  | "backtick"; // `...` (also surfaced as cmdsub semantics)

export interface ExpansionInfo {
  kind: ExpansionKind;
  /** Raw source slice of the expansion, including its sigil(s). */
  text: string;
  start: number;
  end: number;
  /** For cmdsub/backtick: the raw inner script between the delimiters. */
  inner?: string;
}

export type TokenKind = "word" | "op" | "comment" | "newline";

export interface ScanToken {
  kind: TokenKind;
  /** Raw source slice. */
  text: string;
  start: number;
  end: number;
  /** True when the token contained any quoting. */
  quoted: boolean;
  /** Unquoted bare word matching a shell reserved keyword. */
  reserved?: boolean;
  expansions?: ExpansionInfo[];
  hasCmdSubstitution?: boolean;
  /** Any expansion (var/arith/cmdsub) occurs outside quotes. */
  hasUnquotedExpansion?: boolean;
}

export interface RedirectInfo {
  op: string;
  /** Explicit fd prefix (e.g. 2 in `2>`), when present. */
  fd?: number;
  /** Raw source slice of the target word (empty for bare `>&` oddities). */
  target: string;
  targetStart: number;
  targetEnd: number;
  /** Target word contained quoting. */
  quoted: boolean;
  /** Target word contained expansions. */
  hasExpansion: boolean;
  /** Target word contained command substitutions (executed at redirect time). */
  hasCmdSubstitution?: boolean;
  /** Command substitution regions on the target word. */
  cmdSubs?: ExpansionInfo[];
  /** Index into ScanResult.heredocs when this redirect is a heredoc. */
  heredocIndex?: number;
  start: number;
  end: number;
}

export interface HeredocInfo {
  op: "<<" | "<<-" | "<<<";
  /** Delimiter word raw text (for `<<<` this is the here-string body word). */
  delimiter: string;
  /** True when the delimiter word was quoted (body is fully literal). */
  delimiterQuoted: boolean;
  /** Raw byte span of the body (empty span for unmatched / `<<<`). */
  start: number;
  end: number;
  /** Raw body text (`<<<`: the body is the delimiter field itself). */
  text: string;
  /** False when EOF was reached without seeing the delimiter line. */
  matched: boolean;
}

export type StatementKind = "safe" | "opaque" | "dangerous";

export interface ShellStatement {
  /** Original source slice for this statement (for upper-layer composition). */
  text: string;
  start: number;
  end: number;
  kind: StatementKind;
  /** Stable, machine-readable reasons (see REASON constants below). */
  reasons: string[];
  tokens: ScanToken[];
  redirects: RedirectInfo[];
  heredocs: HeredocInfo[];
  /** Environment assignment prefixes, e.g. `FOO=bar`. */
  assignments: string[];
  /** Modifier prefixes (sudo, nohup, ...) — marked, semantics not parsed. */
  modifiers: string[];
  /** Resolved literal command word per pipeline stage (best effort). */
  commands: string[];
}

export interface ScanOptions {
  /** Max input length in UTF-16 code units. Default 256 KiB. */
  maxInputLength?: number;
  /** Max lexer token count. Default 50 000. */
  maxTokens?: number;
  /** Max nesting depth (cmdsub / compounds). Default 64. */
  maxDepth?: number;
}

export interface ScanResult {
  input: string;
  statements: ShellStatement[];
  /** True when any statement is opaque (or the scan failed closed). */
  opaque: boolean;
  /** True when any statement is dangerous. */
  dangerous: boolean;
  heredocs: HeredocInfo[];
  redirects: RedirectInfo[];
  /** Whole-scan reasons (budget / unsupported constructs / aborts). */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Stable reason strings
// ---------------------------------------------------------------------------

export const REASONS = {
  budgetExceeded: "budget-exceeded",
  unsupportedConstruct: "unsupported-construct",
  dynamicEval: "dynamic-execution:eval",
  dynamicSource: "dynamic-execution:source",
  dynamicCommandWordExpansion: "dynamic-execution:expansion-command-word",
  dynamicCommandWordCmdSub: "dynamic-execution:command-substitution-command-word",
  dynamicShellCScript: "dynamic-execution:shell-c-dynamic-script",
  dynamicHeredocExpansion: "dynamic-execution:heredoc-expansion",
  dynamicCmdSubContent: "dynamic-execution:command-substitution-content",
  dynamicUnparseable: "dynamic-execution:unparseable-input",
  unterminatedConstruct: "unterminated-construct",
  dangerousRmRoot: "dangerous:rm-recursive-force-root",
  dangerousChmodRoot: "dangerous:chmod-777-root",
  dangerousMkfs: "dangerous:mkfs",
  dangerousDdBlockDevice: "dangerous:dd-block-device",
  dangerousRedirectBlockDevice: "dangerous:redirect-block-device",
  dangerousPowerControl: "dangerous:power-control",
  dangerousPipeToShell: "dangerous:pipe-to-shell",
  dangerousCredentialPath: "dangerous:credential-path",
} as const;

// ---------------------------------------------------------------------------
// Options / budgets
// ---------------------------------------------------------------------------

const DEFAULT_MAX_INPUT = 256 * 1024;
const DEFAULT_MAX_TOKENS = 50_000;
const DEFAULT_MAX_DEPTH = 64;

interface ResolvedOptions {
  maxInputLength: number;
  maxTokens: number;
  maxDepth: number;
}

function resolveOptions(options?: ScanOptions): ResolvedOptions {
  return {
    maxInputLength: options?.maxInputLength ?? DEFAULT_MAX_INPUT,
    maxTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
}

// ---------------------------------------------------------------------------
// Internal lexical model
// ---------------------------------------------------------------------------

/** Internal abort signal for budget violations (fail-closed). */
class ScanAbort extends Error {
  constructor(
    public readonly detail: string,
  ) {
    super(detail);
    this.name = "ScanAbort";
  }
}

type WordPart =
  | { type: "literal"; text: string; quoted: boolean }
  | { type: "tilde"; text: string }
  | { type: "expansion"; info: ExpansionInfo; quoted: boolean };

interface Word {
  start: number;
  end: number;
  text: string;
  parts: WordPart[];
  /** Any part of the word was quoted. */
  quoted: boolean;
  hasExpansion: boolean;
  hasUnquotedExpansion: boolean;
  hasCmdSubstitution: boolean;
  /** All command substitution regions belonging to this word (flat). */
  cmdSubs: ExpansionInfo[];
  /** Dequoted text when the word is expansion-free; null otherwise. */
  staticText: string | null;
  isAssignment: boolean;
  isReserved: boolean;
}

const RESERVED_KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi",
  "for", "while", "until", "do", "done",
  "case", "esac", "in", "function", "select", "!",
]);

type RedirectOp =
  | ">" | ">>" | "<" | "<<" | "<<-" | "<<<" | "<>" | ">|" | ">&" | "<&" | "&>" | "&>>";

type LexToken =
  | { t: "word"; word: Word; start: number; end: number; text: string }
  | { t: "op"; value: string; start: number; end: number; text: string }
  | {
    t: "redirect";
    op: RedirectOp;
    fd: number | undefined;
    heredocIndex: number | undefined;
    start: number;
    end: number;
    text: string;
  }
  | { t: "newline"; start: number; end: number; text: string }
  | { t: "comment"; start: number; end: number; text: string };

interface LexDiagnostic {
  code: "unterminated-construct" | "heredoc-unmatched" | "missing-heredoc-delimiter" | "unsupported-construct";
  detail: string;
  start: number;
  end: number;
}

const SPECIAL_WORD_BREAK = new Set([" ", "\t", "\r", "\n", "|", "&", ";", "(", ")", "<", ">"]);
const DELIMITER_AFTER_BRACE = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "(", ")", ">", "<", ""]);

function isNameStartChar(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";
}

function isNameChar(ch: string): boolean {
  return isNameStartChar(ch) || (ch >= "0" && ch <= "9");
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

const NAME_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface ScanResult1 {
  next: number;
  unterminated: string | null;
}

interface PendingHeredoc {
  op: "<<" | "<<-" | "<<<";
  heredocIndex: number;
}

// ---------------------------------------------------------------------------
// Phase 1 — Lexer
// ---------------------------------------------------------------------------

class Lexer {
  private readonly input: string;
  private readonly maxTokens: number;
  private readonly maxDepth: number;
  readonly tokens: LexToken[] = [];
  readonly diagnostics: LexDiagnostic[] = [];
  readonly heredocs: HeredocInfo[] = [];
  private awaiting: PendingHeredoc | null = null;
  private bodyQueue: number[] = [];
  private depth = 0;

  constructor(input: string, maxTokens: number, maxDepth: number) {
    this.input = input;
    this.maxTokens = maxTokens;
    this.maxDepth = maxDepth;
  }

  run(): void {
    const input = this.input;
    const len = input.length;
    let i = 0;
    while (i < len) {
      const ch = input[i]!;
      // Line continuation: `\<LF>` or `\<CRLF>`.
      if (
        ch === "\\" &&
        (input[i + 1] === "\n" || (input[i + 1] === "\r" && input[i + 2] === "\n"))
      ) {
        i += input[i + 1] === "\n" ? 2 : 3;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\r") {
        i++;
        continue;
      }
      if (ch === "\n") {
        this.emit({ t: "newline", start: i, end: i + 1, text: "\n" });
        i = this.processHeredocBodies(i + 1);
        continue;
      }
      if (ch === "#") {
        let j = i + 1;
        while (j < len && input[j] !== "\n") j++;
        this.emit({ t: "comment", start: i, end: j, text: input.slice(i, j) });
        i = j;
        continue;
      }
      // fd-prefixed redirect (`2>`, `3<<`, ...): digit run directly followed by < or >.
      if (isDigit(ch)) {
        let j = i;
        while (j < len && isDigit(input[j]!)) j++;
        const nxt = input[j];
        if (nxt === "<" || nxt === ">") {
          const fd = Number(input.slice(i, j));
          i = this.emitRedirect(j, fd);
          continue;
        }
      }
      const nextIdx = this.tryOperator(i);
      if (nextIdx >= 0) {
        i = nextIdx;
        continue;
      }
      // zsh process substitution `=(cmd)` — unsupported, fail closed.
      if (ch === "=" && input[i + 1] === "(") {
        this.diagnostics.push({
          code: "unsupported-construct",
          detail: "zsh-process-substitution",
          start: i,
          end: i + 2,
        });
        i += 1;
        continue;
      }
      i = this.lexWord(i);
    }
    if (this.awaiting !== null) {
      this.diagnostics.push({
        code: "missing-heredoc-delimiter",
        detail: this.awaiting.op,
        start: len,
        end: len,
      });
      this.awaiting = null;
    }
    if (this.bodyQueue.length > 0) this.processHeredocBodies(len);
  }

  private emit(token: LexToken): void {
    if (this.tokens.length >= this.maxTokens) {
      throw new ScanAbort("token-budget-exceeded");
    }
    this.tokens.push(token);
    if (token.t === "word") {
      if (this.awaiting !== null) this.finalizeHeredocDelimiter(token);
      return;
    }
    if (this.awaiting !== null) {
      this.diagnostics.push({
        code: "missing-heredoc-delimiter",
        detail: this.awaiting.op,
        start: token.start,
        end: token.end,
      });
      this.awaiting = null;
    }
  }

  /** Try to lex an operator at `i`; returns the absolute next index or -1. */
  private tryOperator(i: number): number {
    const input = this.input;
    const ch = input[i]!;
    const next = input[i + 1] ?? "";
    const next2 = input[i + 2] ?? "";
    switch (ch) {
      case "|":
        if (next === "|") return this.emitOp(i, 2, "||");
        if (next === "&") return this.emitOp(i, 2, "|&");
        return this.emitOp(i, 1, "|");
      case "&":
        if (next === "&") return this.emitOp(i, 2, "&&");
        if (next === ">") {
          if (next2 === ">") return this.emitRedirect(i, undefined, "&>>", 3);
          return this.emitRedirect(i, undefined, "&>", 2);
        }
        return this.emitOp(i, 1, "&");
      case ";":
        if (next === ";") {
          if (next2 === "&") return this.emitOp(i, 3, ";;&");
          return this.emitOp(i, 2, ";;");
        }
        if (next === "&") return this.emitOp(i, 2, ";&");
        return this.emitOp(i, 1, ";");
      case "(":
        return this.emitOp(i, 1, "(");
      case ")":
        return this.emitOp(i, 1, ")");
      case "<":
        return this.emitRedirect(i, undefined);
      case ">":
        return this.emitRedirect(i, undefined);
      case "{":
        if (DELIMITER_AFTER_BRACE.has(next)) return this.emitOp(i, 1, "{");
        return -1;
      case "}":
        if (DELIMITER_AFTER_BRACE.has(next)) return this.emitOp(i, 1, "}");
        return -1;
      default:
        return -1;
    }
  }

  private emitOp(start: number, length: number, value: string): number {
    this.emit({ t: "op", value, start, end: start + length, text: this.input.slice(start, start + length) });
    return start + length;
  }

  /** Lex a redirect operator starting at `i` (its first char). */
  private emitRedirect(i: number, fd: number | undefined, forced?: RedirectOp, forcedLen?: number): number {
    const input = this.input;
    let op: RedirectOp;
    let len: number;
    if (forced) {
      op = forced;
      len = forcedLen ?? 1;
    } else if (input[i] === "<") {
      if (input.startsWith("<<<", i)) {
        op = "<<<";
        len = 3;
      } else if (input.startsWith("<<-", i)) {
        op = "<<-";
        len = 3;
      } else if (input.startsWith("<<", i)) {
        op = "<<";
        len = 2;
      } else if (input.startsWith("<&", i)) {
        op = "<&";
        len = 2;
      } else if (input.startsWith("<>", i)) {
        op = "<>";
        len = 2;
      } else {
        op = "<";
        len = 1;
      }
    } else {
      if (input.startsWith(">>", i)) {
        op = ">>";
        len = 2;
      } else if (input.startsWith(">&", i)) {
        op = ">&";
        len = 2;
      } else if (input.startsWith(">|", i)) {
        op = ">|";
        len = 2;
      } else {
        op = ">";
        len = 1;
      }
    }
    const heredocOp: "<<" | "<<-" | "<<<" | undefined =
      op === "<<" || op === "<<-" || op === "<<<" ? op : undefined;
    let heredocIndex: number | undefined;
    if (heredocOp !== undefined) {
      heredocIndex = this.heredocs.length;
      this.heredocs.push({
        op: heredocOp,
        delimiter: "",
        delimiterQuoted: false,
        start: i + len,
        end: i + len,
        text: "",
        matched: false,
      });
    }
    this.emit({
      t: "redirect",
      op,
      fd,
      heredocIndex,
      start: i,
      end: i + len,
      text: input.slice(i, i + len),
    });
    if (heredocOp !== undefined && heredocIndex !== undefined) {
      this.awaiting = { op: heredocOp, heredocIndex };
    }
    return i + len;
  }

  private finalizeHeredocDelimiter(token: Extract<LexToken, { t: "word" }>): void {
    const awaiting = this.awaiting;
    if (!awaiting) return;
    this.awaiting = null;
    const info = this.heredocs[awaiting.heredocIndex];
    if (!info) return;
    const word = token.word;
    if (awaiting.op === "<<<") {
      info.delimiter = word.text;
      info.delimiterQuoted = word.quoted;
      info.start = word.start;
      info.end = word.end;
      info.text = word.text;
      info.matched = true;
      return;
    }
    info.delimiter = word.staticText ?? word.text;
    info.delimiterQuoted = word.quoted;
    info.start = word.end;
    info.end = word.end;
    this.bodyQueue.push(awaiting.heredocIndex);
  }

  /** Consume raw heredoc bodies; returns the position after the last body. */
  private processHeredocBodies(pos: number): number {
    if (this.bodyQueue.length === 0) return pos;
    const input = this.input;
    const len = input.length;
    let i = pos;
    for (const idx of this.bodyQueue) {
      const info = this.heredocs[idx];
      if (!info) continue;
      const stripTabs = info.op === "<<-";
      const bodyStart = i;
      let matched = false;
      let cursor = i;
      while (cursor < len) {
        let lineEnd = input.indexOf("\n", cursor);
        if (lineEnd === -1) lineEnd = len;
        let line = input.slice(cursor, lineEnd);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
        if (candidate === info.delimiter) {
          matched = true;
          break;
        }
        cursor = lineEnd + 1;
      }
      const bodyEnd = matched ? cursor : len;
      let body = input.slice(bodyStart, bodyEnd);
      if (body.endsWith("\n")) body = body.slice(0, -1);
      if (body.endsWith("\r")) body = body.slice(0, -1);
      info.start = bodyStart;
      info.end = bodyEnd;
      info.text = body;
      info.matched = matched;
      if (!matched) {
        this.diagnostics.push({
          code: "heredoc-unmatched",
          detail: info.delimiter,
          start: bodyStart,
          end: len,
        });
        i = len;
      } else {
        // Skip past the delimiter line itself (consumed by the heredoc).
        const nl = input.indexOf("\n", cursor);
        i = nl === -1 ? len : nl + 1;
      }
    }
    this.bodyQueue = [];
    return i;
  }

  // -- word lexing ----------------------------------------------------------

  private lexWord(start: number): number {
    const input = this.input;
    const len = input.length;
    const parts: WordPart[] = [];
    const cmdSubs: ExpansionInfo[] = [];
    let i = start;
    let unterminated: string | null = null;
    while (i < len) {
      const ch = input[i]!;
      if (ch === "\\") {
        const nxt = input[i + 1];
        if (nxt === "\n") {
          i += 2;
          continue;
        }
        if (nxt === "\r" && input[i + 2] === "\n") {
          i += 3;
          continue;
        }
        if (nxt === undefined) {
          parts.push({ type: "literal", text: "\\", quoted: false });
          i += 1;
          continue;
        }
        parts.push({ type: "literal", text: nxt, quoted: false });
        i += 2;
        continue;
      }
      if (SPECIAL_WORD_BREAK.has(ch)) break;
      if (ch === "{" || ch === "}") {
        if (parts.length === 0 && DELIMITER_AFTER_BRACE.has(input[i + 1] ?? "")) break;
        parts.push({ type: "literal", text: ch, quoted: false });
        i += 1;
        continue;
      }
      if (ch === "'") {
        const close = input.indexOf("'", i + 1);
        if (close === -1) {
          unterminated = "single-quote";
          i = len;
          break;
        }
        parts.push({ type: "literal", text: input.slice(i + 1, close), quoted: true });
        i = close + 1;
        continue;
      }
      if (ch === '"') {
        const r = this.scanDouble(i, parts, cmdSubs);
        i = r.next;
        if (r.unterminated) {
          unterminated = r.unterminated;
          break;
        }
        continue;
      }
      if (ch === "$") {
        if (input[i + 1] === "'") {
          const r = this.scanAnsiC(i, parts);
          i = r.next;
          if (r.unterminated) {
            unterminated = r.unterminated;
            break;
          }
          continue;
        }
        if (input[i + 1] === '"') {
          const r = this.scanDouble(i + 1, parts, cmdSubs);
          i = r.next;
          if (r.unterminated) {
            unterminated = r.unterminated;
            break;
          }
          continue;
        }
        const r = this.scanDollar(i, parts, cmdSubs, false);
        i = r.next;
        if (r.unterminated) {
          unterminated = r.unterminated;
          break;
        }
        continue;
      }
      if (ch === "`") {
        const r = this.scanBacktick(i, parts, cmdSubs, false);
        i = r.next;
        if (r.unterminated) {
          unterminated = r.unterminated;
          break;
        }
        continue;
      }
      if (ch === "~" && parts.length === 0) {
        parts.push({ type: "tilde", text: "~" });
        i += 1;
        continue;
      }
      // Plain character run: accumulate until a lexically significant char.
      let j = i;
      while (j < len) {
        const c = input[j]!;
        if (
          c === "\\" || c === "$" || c === "`" || c === "'" || c === '"' ||
          SPECIAL_WORD_BREAK.has(c)
        ) {
          break;
        }
        j++;
      }
      if (j === i) {
        // Should not happen (every special char is handled above), but keep
        // the loop provably advancing.
        parts.push({ type: "literal", text: ch, quoted: false });
        i += 1;
        continue;
      }
      parts.push({ type: "literal", text: input.slice(i, j), quoted: false });
      i = j;
    }
    const end = Math.min(i, len);
    if (unterminated) {
      this.diagnostics.push({
        code: "unterminated-construct",
        detail: unterminated,
        start,
        end,
      });
    }
    const word = this.buildWord(start, end, parts, cmdSubs);
    this.emit({ t: "word", word, start, end, text: word.text });
    return end;
  }

  private scanDouble(start: number, parts: WordPart[], cmdSubs: ExpansionInfo[]): ScanResult1 {
    const input = this.input;
    const len = input.length;
    let i = start + 1;
    let buffer = "";
    const flush = () => {
      if (buffer.length > 0) {
        parts.push({ type: "literal", text: buffer, quoted: true });
        buffer = "";
      }
    };
    while (i < len) {
      const ch = input[i]!;
      if (ch === '"') {
        flush();
        return { next: i + 1, unterminated: null };
      }
      if (ch === "\\") {
        const nxt = input[i + 1];
        if (nxt === "\n") {
          i += 2;
          continue;
        }
        if (nxt === "\r" && input[i + 2] === "\n") {
          i += 3;
          continue;
        }
        if (nxt === undefined) {
          flush();
          return { next: len, unterminated: "double-quote" };
        }
        if (nxt === "$" || nxt === "`" || nxt === '"' || nxt === "\\") {
          buffer += nxt;
          i += 2;
        } else {
          buffer += "\\";
          i += 1;
        }
        continue;
      }
      if (ch === "$") {
        flush();
        const r = this.scanDollar(i, parts, cmdSubs, true);
        i = r.next;
        if (r.unterminated) return r;
        continue;
      }
      if (ch === "`") {
        flush();
        const r = this.scanBacktick(i, parts, cmdSubs, true);
        i = r.next;
        if (r.unterminated) return r;
        continue;
      }
      buffer += ch;
      i += 1;
    }
    flush();
    return { next: len, unterminated: "double-quote" };
  }

  private scanAnsiC(start: number, parts: WordPart[]): { next: number; unterminated: string | null } {
    const input = this.input;
    const len = input.length;
    let i = start + 2; // skip $'
    const contentStart = i;
    while (i < len) {
      const ch = input[i]!;
      if (ch === "'") {
        parts.push({ type: "literal", text: input.slice(contentStart, i), quoted: true });
        return { next: i + 1, unterminated: null };
      }
      if (ch === "\\") {
        i += 2;
        continue;
      }
      i += 1;
    }
    parts.push({ type: "literal", text: input.slice(contentStart, len), quoted: true });
    return { next: len, unterminated: "ansi-c-quote" };
  }

  private scanBacktick(
    start: number,
    parts: WordPart[],
    cmdSubs: ExpansionInfo[],
    quoted: boolean,
  ): ScanResult1 {
    const input = this.input;
    const len = input.length;
    let i = start + 1;
    while (i < len) {
      const ch = input[i]!;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        const info: ExpansionInfo = {
          kind: "backtick",
          text: input.slice(start, i + 1),
          start,
          end: i + 1,
          inner: input.slice(start + 1, i),
        };
        parts.push({ type: "expansion", info, quoted });
        cmdSubs.push(info);
        return { next: i + 1, unterminated: null };
      }
      i += 1;
    }
    return { next: len, unterminated: "backtick" };
  }

  private scanDollar(
    start: number,
    parts: WordPart[],
    cmdSubs: ExpansionInfo[],
    quoted: boolean,
  ): ScanResult1 {
    const input = this.input;
    const len = input.length;
    const nxt = input[start + 1];
    if (nxt === undefined) {
      parts.push({ type: "literal", text: "$", quoted });
      return { next: start + 1, unterminated: null };
    }
    if (nxt === "(") {
      if (input[start + 2] === "(") return this.scanArith(start, parts, quoted, cmdSubs);
      return this.scanCmdSub(start, parts, cmdSubs, quoted);
    }
    if (nxt === "{") return this.scanBraces(start, parts, cmdSubs, quoted);
    if (isNameStartChar(nxt)) {
      let j = start + 1;
      while (j < len && isNameChar(input[j]!)) j++;
      this.pushExpansion(parts, { kind: "var", text: input.slice(start, j), start, end: j }, quoted);
      return { next: j, unterminated: null };
    }
    if ("$?!#@*-".includes(nxt) || isDigit(nxt)) {
      this.pushExpansion(
        parts,
        { kind: "var", text: input.slice(start, start + 2), start, end: start + 2 },
        quoted,
      );
      return { next: start + 2, unterminated: null };
    }
    parts.push({ type: "literal", text: "$", quoted });
    return { next: start + 1, unterminated: null };
  }

  private pushExpansion(parts: WordPart[], info: ExpansionInfo, quoted: boolean): void {
    parts.push({ type: "expansion", info, quoted });
  }

  /** `$( ... )` command substitution. */
  private scanCmdSub(
    start: number,
    parts: WordPart[],
    cmdSubs: ExpansionInfo[],
    quoted: boolean,
  ): ScanResult1 {
    const input = this.input;
    const len = input.length;
    this.depth++;
    try {
      if (this.depth > this.maxDepth) throw new ScanAbort("depth-budget-exceeded");
      let i = start + 2;
      const contentStart = i;
      let d = 1;
      while (i < len) {
        const ch = input[i]!;
        if (ch === "'") {
          const close = input.indexOf("'", i + 1);
          if (close === -1) return { next: len, unterminated: "cmdsub-single-quote" };
          i = close + 1;
          continue;
        }
        if (ch === '"') {
          const r = this.scanDouble(i, [], []);
          i = r.next;
          if (r.unterminated) return { next: len, unterminated: "cmdsub-double-quote" };
          continue;
        }
        if (ch === "`") {
          const r = this.scanBacktick(i, [], [], false);
          i = r.next;
          if (r.unterminated) return { next: len, unterminated: "cmdsub-backtick" };
          continue;
        }
        if (ch === "$" && input[i + 1] === "(") {
          d++;
          i += 2;
          continue;
        }
        if (ch === "$" && input[i + 1] === "{") {
          const r = this.scanBraces(i, [], [], false);
          i = r.next;
          if (r.unterminated) return { next: len, unterminated: "cmdsub-braces" };
          continue;
        }
        if (ch === "(") {
          d++;
          i++;
          continue;
        }
        if (ch === ")") {
          d--;
          if (d === 0) {
            const info: ExpansionInfo = {
              kind: "cmdsub",
              text: input.slice(start, i + 1),
              start,
              end: i + 1,
              inner: input.slice(contentStart, i),
            };
            this.pushExpansion(parts, info, quoted);
            cmdSubs.push(info);
            return { next: i + 1, unterminated: null };
          }
          i++;
          continue;
        }
        i++;
      }
      return { next: len, unterminated: "cmdsub" };
    } finally {
      this.depth--;
    }
  }

  /** `${ ... }` parameter expansion. */
  private scanBraces(
    start: number,
    parts: WordPart[],
    cmdSubs: ExpansionInfo[],
    quoted: boolean,
  ): ScanResult1 {
    const input = this.input;
    const len = input.length;
    this.depth++;
    try {
      if (this.depth > this.maxDepth) throw new ScanAbort("depth-budget-exceeded");
      let i = start + 2;
      let d = 1;
      while (i < len) {
        const ch = input[i]!;
        if (ch === "'") {
          const close = input.indexOf("'", i + 1);
          if (close === -1) return { next: len, unterminated: "braces-single-quote" };
          i = close + 1;
          continue;
        }
        if (ch === '"') {
          const r = this.scanDouble(i, [], []);
          i = r.next;
          if (r.unterminated) return { next: len, unterminated: "braces-double-quote" };
          continue;
        }
        if (ch === "`") {
          const r = this.scanBacktick(i, [], [], false);
          i = r.next;
          if (r.unterminated) return { next: len, unterminated: "braces-backtick" };
          continue;
        }
        if (ch === "$" && input[i + 1] === "(") {
          const r = this.scanCmdSub(i, parts, cmdSubs, quoted);
          i = r.next;
          if (r.unterminated) return { next: len, unterminated: "braces-cmdsub" };
          continue;
        }
        if (ch === "$" && input[i + 1] === "{") {
          d++;
          i += 2;
          continue;
        }
        if (ch === "{") {
          d++;
          i++;
          continue;
        }
        if (ch === "}") {
          d--;
          if (d === 0) {
            this.pushExpansion(
              parts,
              { kind: "var", text: input.slice(start, i + 1), start, end: i + 1 },
              quoted,
            );
            return { next: i + 1, unterminated: null };
          }
          i++;
          continue;
        }
        i++;
      }
      return { next: len, unterminated: "braces" };
    } finally {
      this.depth--;
    }
  }

  /** `$(( ... ))` arithmetic expansion. */
  private scanArith(
    start: number,
    parts: WordPart[],
    quoted: boolean,
    cmdSubs: ExpansionInfo[],
  ): ScanResult1 {
    const input = this.input;
    const len = input.length;
    this.depth++;
    try {
      if (this.depth > this.maxDepth) throw new ScanAbort("depth-budget-exceeded");
      let i = start + 3;
      let d = 2;
      while (i < len) {
        const ch = input[i]!;
        if (ch === "'") {
          const close = input.indexOf("'", i + 1);
          if (close === -1) return { next: len, unterminated: "arith-single-quote" };
          i = close + 1;
          continue;
        }
        if (ch === '"') {
          const r = this.scanDouble(i, [], []);
          i = r.next;
          if (r.unterminated) return { next: len, unterminated: "arith-double-quote" };
          continue;
        }
        if (ch === "$" && input[i + 1] === "(") {
          d++;
          i += 2;
          continue;
        }
        if (ch === "(") {
          d++;
          i++;
          continue;
        }
        if (ch === ")") {
          d--;
          if (d === 0) {
            const info: ExpansionInfo = {
              kind: "arith",
              text: input.slice(start, i + 1),
              start,
              end: i + 1,
              inner: input.slice(start + 3, i - 1),
            };
            this.pushExpansion(parts, info, quoted);
            // Arithmetic contexts can execute nested command substitutions.
            cmdSubs.push(info);
            return { next: i + 1, unterminated: null };
          }
          i++;
          continue;
        }
        i++;
      }
      return { next: len, unterminated: "arith" };
    } finally {
      this.depth--;
    }
  }

  private buildWord(start: number, end: number, parts: WordPart[], cmdSubs: ExpansionInfo[]): Word {
    const text = this.input.slice(start, end);
    let quoted = false;
    let hasExpansion = false;
    let hasUnquotedExpansion = false;
    let hasCmdSubstitution = cmdSubs.length > 0;
    let staticText = "";
    let canBeStatic = true;
    for (const part of parts) {
      if (part.type === "literal") {
        if (part.quoted) quoted = true;
        staticText += part.text;
        continue;
      }
      if (part.type === "tilde") {
        staticText += part.text;
        continue;
      }
      hasExpansion = true;
      canBeStatic = false;
      if (part.quoted) quoted = true;
      else hasUnquotedExpansion = true;
      if (part.info.kind === "cmdsub" || part.info.kind === "backtick") hasCmdSubstitution = true;
    }
    // Assignment detection: the `=` must appear inside an unquoted literal
    // prefix (`FOO=bar`, `FOO="x y"` are assignments; `"FOO=bar"` is not).
    let isAssignment = false;
    {
      let prefix = "";
      for (const part of parts) {
        if (part.type !== "literal" || part.quoted) break;
        prefix += part.text;
        if (prefix.includes("=")) {
          isAssignment = NAME_ASSIGN_RE.test(prefix);
          break;
        }
      }
    }
    const isReserved =
      !hasExpansion && !quoted && canBeStatic && RESERVED_KEYWORDS.has(staticText);
    return {
      start,
      end,
      text,
      parts,
      quoted,
      hasExpansion,
      hasUnquotedExpansion,
      hasCmdSubstitution,
      cmdSubs,
      staticText: canBeStatic ? staticText : null,
      isAssignment,
      isReserved,
    };
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — Statement decomposition
// ---------------------------------------------------------------------------

/** One pipeline stage (a simple or compound command). */
interface Stage {
  start: number;
  end: number;
  words: Word[];
  /** Assignment-prefix raw texts (`FOO=bar`) — only a true prefix. */
  assignments: string[];
  redirects: RedirectInfo[];
  /** Raw modifier words (sudo, nohup, ...) — marked, semantics not parsed. */
  modifiers: string[];
  /** Compound keywords ("if", "subshell", "function", ...). */
  keywords: string[];
  /** Statements nested inside a compound command. */
  inner: StatementDraft[];
  /** Function definition body command (graded conservatively). */
  body?: Stage;
}

/** A pipeline (one graded statement) with its source span. */
interface StatementDraft {
  start: number;
  end: number;
  stages: Stage[];
  negated: boolean;
}

interface ParseTerminators {
  ops: Set<string>;
  words: Set<string>;
}

const CASE_TERMINATOR_OPS = new Set([";;", ";&", ";;&"]);
const NO_TERMINATORS: ParseTerminators = { ops: new Set(), words: new Set() };

class Parser {
  private readonly tokens: LexToken[];
  private readonly maxDepth: number;
  private pos = 0;
  private depth = 0;
  /** Set when the token stream cannot be parsed with confidence. */
  malformed = false;
  readonly statements: StatementDraft[] = [];

  constructor(tokens: LexToken[], maxDepth: number) {
    this.tokens = tokens;
    this.maxDepth = maxDepth;
  }

  private peek(offset = 0): LexToken | undefined {
    return this.tokens[this.pos + offset];
  }

  private consume(): LexToken | undefined {
    const token = this.tokens[this.pos];
    if (token !== undefined) this.pos++;
    return token;
  }

  private isOp(token: LexToken | undefined, value: string): boolean {
    return token !== undefined && token.t === "op" && token.value === value;
  }

  private isReservedWord(token: LexToken | undefined, value: string): boolean {
    return (
      token !== undefined &&
      token.t === "word" &&
      token.word.isReserved &&
      token.word.staticText === value
    );
  }

  parseProgram(): void {
    this.parseList(this.statements, NO_TERMINATORS);
    // Stray braces are literal noise; any other leftover token (unbalanced
    // paren, unmatched operator) means we did not fully understand the
    // input — fail closed.
    while (this.isOp(this.peek(), "{") || this.isOp(this.peek(), "}")) {
      this.pos++;
    }
    if (this.pos < this.tokens.length) this.malformed = true;
  }

  /** Skip statement separators: `;`, `&`, and newline tokens. */
  private skipSeparators(): void {
    while (true) {
      const tok = this.peek();
      if (tok === undefined) return;
      if (tok.t === "newline") {
        this.pos++;
        continue;
      }
      if (tok.t === "op" && (tok.value === ";" || tok.value === "&")) {
        this.pos++;
        continue;
      }
      return;
    }
  }

  private parseList(sink: StatementDraft[], terminators: ParseTerminators): void {
    while (true) {
      this.skipSeparators();
      const cur = this.peek();
      if (cur === undefined) return;
      if (cur.t === "comment") {
        this.pos++;
        continue;
      }
      if (cur.t === "op" && terminators.ops.has(cur.value)) return;
      if (cur.t === "op" && (cur.value === ")" || cur.value === "}")) return;
      if (
        cur.t === "word" &&
        cur.word.isReserved &&
        terminators.words.has(cur.word.staticText ?? "")
      ) {
        return;
      }
      const before = this.pos;
      const stmt = this.parsePipeline();
      if (this.pos === before) {
        const stuck = this.peek();
        // Stray `{`/`}` outside any group are literal noise (e.g. `echo }`);
        // anything else unparseable fails closed.
        if (stuck !== undefined && stuck.t === "op" && (stuck.value === "{" || stuck.value === "}")) {
          this.pos++;
          continue;
        }
        this.malformed = true;
        this.pos++;
        continue;
      }
      if (stmt !== null) sink.push(stmt);
      this.skipSeparators();
      if (this.isOp(this.peek(), "&&") || this.isOp(this.peek(), "||")) {
        this.pos++;
        continue;
      }
    }
  }

  private parsePipeline(): StatementDraft | null {
    const before = this.pos;
    const first = this.peek();
    if (first === undefined) return null;
    let negated = false;
    if (this.isReservedWord(this.peek(), "!")) {
      negated = true;
      this.consume();
    }
    const stages: Stage[] = [this.parseCommand()];
    while (this.isOp(this.peek(), "|") || this.isOp(this.peek(), "|&")) {
      this.consume();
      stages.push(this.parseCommand());
    }
    if (this.pos === before) return null;
    const startTok = this.tokens[before]!;
    const endTok = this.tokens[this.pos - 1]!;
    return { start: startTok.start, end: endTok.end, stages, negated };
  }

  private parseCommand(): Stage {
    const cur = this.peek();
    if (cur === undefined) {
      return {
        start: 0,
        end: 0,
        words: [],
        assignments: [],
        redirects: [],
        modifiers: [],
        keywords: [],
        inner: [],
      };
    }
    if (cur.t === "op" && cur.value === "(") return this.parseSubshell();
    if (cur.t === "op" && cur.value === "{") return this.parseGroup();
    if (cur.t === "word" && cur.word.isReserved) {
      switch (cur.word.staticText ?? "") {
        case "if":
          return this.parseIf();
        case "for":
        case "select":
          return this.parseFor(cur.word.staticText ?? "for");
        case "while":
        case "until":
          return this.parseWhile(cur.word.staticText ?? "while");
        case "case":
          return this.parseCase();
        case "function":
          return this.parseFunctionDef();
        default:
          break;
      }
    }
    if (
      cur.t === "word" &&
      !cur.word.isAssignment &&
      this.isOp(this.peek(1), "(") &&
      this.isOp(this.peek(2), ")")
    ) {
      return this.parseFunctionDef();
    }
    return this.parseSimple();
  }

  private enterCompound(): void {
    this.depth++;
    if (this.depth > this.maxDepth) throw new ScanAbort("depth-budget-exceeded");
  }

  private exitCompound(): void {
    this.depth--;
  }

  /** Build the wrapper stage for a compound command, collecting trailing redirects. */
  private compoundStage(open: LexToken, keywords: string[], inner: StatementDraft[]): Stage {
    const start = open.start;
    const last = this.tokens[this.pos - 1];
    const end = last !== undefined ? last.end : open.end;
    const stage: Stage = {
      start,
      end,
      words: [],
      assignments: [],
      redirects: [],
      modifiers: [],
      keywords,
      inner,
    };
    this.collectTrailingRedirects(stage);
    return stage;
  }

  private emptyStage(): Stage {
    return {
      start: 0,
      end: 0,
      words: [],
      assignments: [],
      redirects: [],
      modifiers: [],
      keywords: [],
      inner: [],
    };
  }

  private collectTrailingRedirects(stage: Stage): void {
    while (this.peek()?.t === "redirect") {
      const ok = this.parseRedirectInto(stage);
      if (!ok) break;
    }
  }

  /** `( ... )` subshell; `(( ... ))` parses as a nested subshell (fail-closed friendly). */
  private parseSubshell(): Stage {
    const open = this.consume()!; // "("
    const inner: StatementDraft[] = [];
    this.enterCompound();
    try {
      this.parseList(inner, { ops: new Set([")"]), words: new Set() });
      if (this.isOp(this.peek(), ")")) this.consume();
      else this.malformed = true;
    } finally {
      this.exitCompound();
    }
    return this.compoundStage(open, ["subshell"], inner);
  }

  private parseGroup(): Stage {
    const open = this.consume()!; // "{"
    const inner: StatementDraft[] = [];
    this.enterCompound();
    try {
      this.parseList(inner, { ops: new Set(), words: new Set(["}"]) });
      if (this.isOp(this.peek(), "}")) this.consume();
      else this.malformed = true;
    } finally {
      this.exitCompound();
    }
    return this.compoundStage(open, ["group"], inner);
  }

  private parseIf(): Stage {
    const open = this.consume()!; // "if"
    const inner: StatementDraft[] = [];
    this.enterCompound();
    try {
      this.parseList(inner, { ops: new Set(), words: new Set(["then"]) });
      if (!this.isReservedWord(this.peek(), "then")) {
        this.malformed = true;
        return this.compoundStage(open, ["if"], inner);
      }
      this.consume();
      const tailWords = new Set(["elif", "else", "fi"]);
      this.parseList(inner, { ops: new Set(), words: tailWords });
      while (this.isReservedWord(this.peek(), "elif")) {
        this.consume();
        this.parseList(inner, { ops: new Set(), words: new Set(["then"]) });
        if (!this.isReservedWord(this.peek(), "then")) {
          this.malformed = true;
          return this.compoundStage(open, ["if"], inner);
        }
        this.consume();
        this.parseList(inner, { ops: new Set(), words: tailWords });
      }
      if (this.isReservedWord(this.peek(), "else")) {
        this.consume();
        this.parseList(inner, { ops: new Set(), words: new Set(["fi"]) });
      }
      if (this.isReservedWord(this.peek(), "fi")) this.consume();
      else this.malformed = true;
    } finally {
      this.exitCompound();
    }
    return this.compoundStage(open, ["if"], inner);
  }

  private parseFor(kw: string): Stage {
    const open = this.consume()!; // "for" | "select"
    const inner: StatementDraft[] = [];
    const words: Word[] = [];
    this.enterCompound();
    try {
      const name = this.peek();
      if (name !== undefined && name.t === "word") this.consume();
      if (this.isOp(this.peek(), "(") && this.isOp(this.peek(1), "(")) {
        // Arithmetic for: `for ((init; cond; step))` — consume balanced parens.
        let d = 0;
        while (this.peek() !== undefined) {
          const tok = this.consume()!;
          if (tok.t === "op" && tok.value === "(") d++;
          else if (tok.t === "op" && tok.value === ")") {
            d--;
            if (d === 0) break;
          }
        }
      } else if (this.isReservedWord(this.peek(), "in")) {
        this.consume();
        while (true) {
          const tok = this.peek();
          if (tok === undefined || tok.t !== "word") break;
          if (tok.word.isReserved) break;
          words.push(tok.word);
          this.consume();
        }
      }
      this.skipSeparators();
      if (!this.isReservedWord(this.peek(), "do")) {
        this.malformed = true;
        return this.compoundStage(open, [kw], inner);
      }
      this.consume();
      this.parseList(inner, { ops: new Set(), words: new Set(["done"]) });
      if (this.isReservedWord(this.peek(), "done")) this.consume();
      else this.malformed = true;
    } finally {
      this.exitCompound();
    }
    const stage = this.compoundStage(open, [kw], inner);
    stage.words = words;
    return stage;
  }

  private parseWhile(kw: string): Stage {
    const open = this.consume()!; // "while" | "until"
    const inner: StatementDraft[] = [];
    this.enterCompound();
    try {
      this.parseList(inner, { ops: new Set(), words: new Set(["do"]) });
      if (!this.isReservedWord(this.peek(), "do")) {
        this.malformed = true;
        return this.compoundStage(open, [kw], inner);
      }
      this.consume();
      this.parseList(inner, { ops: new Set(), words: new Set(["done"]) });
      if (this.isReservedWord(this.peek(), "done")) this.consume();
      else this.malformed = true;
    } finally {
      this.exitCompound();
    }
    return this.compoundStage(open, [kw], inner);
  }

  private parseCase(): Stage {
    const open = this.consume()!; // "case"
    const inner: StatementDraft[] = [];
    const words: Word[] = [];
    this.enterCompound();
    try {
      const subject = this.peek();
      if (subject !== undefined && subject.t === "word") {
        words.push(subject.word);
        this.consume();
      }
      if (!this.isReservedWord(this.peek(), "in")) {
        this.malformed = true;
        return this.compoundStage(open, ["case"], inner);
      }
      this.consume();
      while (true) {
        while (true) {
          const sep = this.peek();
          if (sep === undefined) break;
          if (sep.t === "newline" || (sep.t === "op" && sep.value === ";")) {
            this.pos++;
            continue;
          }
          break;
        }
        const cur = this.peek();
        if (cur === undefined) {
          this.malformed = true;
          break;
        }
        if (this.isReservedWord(cur, "esac")) {
          this.consume();
          break;
        }
        if (this.isOp(cur, "(")) this.consume();
        // Pattern words until ")" (or a malformed early terminator).
        while (true) {
          const tok = this.peek();
          if (tok === undefined) break;
          if (tok.t === "op" && (tok.value === ")" || CASE_TERMINATOR_OPS.has(tok.value))) break;
          if (tok.t === "word" && tok.word.isReserved && tok.word.staticText === "esac") break;
          this.consume();
        }
        if (this.isOp(this.peek(), ")")) this.consume();
        else {
          this.malformed = true;
          break;
        }
        this.parseList(inner, { ops: CASE_TERMINATOR_OPS, words: new Set(["esac"]) });
        const after = this.peek();
        if (after !== undefined && after.t === "op" && CASE_TERMINATOR_OPS.has(after.value)) {
          this.consume();
          continue;
        }
        if (this.isReservedWord(this.peek(), "esac")) {
          this.consume();
          break;
        }
        if (this.peek() === undefined) {
          this.malformed = true;
          break;
        }
      }
    } finally {
      this.exitCompound();
    }
    const stage = this.compoundStage(open, ["case"], inner);
    stage.words = words;
    return stage;
  }

  private parseFunctionDef(): Stage {
    const first = this.consume()!; // `function` keyword or the function name
    const isKeywordForm =
      first.t === "word" && first.word.isReserved && first.word.staticText === "function";
    let nameTok: LexToken | undefined;
    if (isKeywordForm) {
      nameTok = this.peek();
      if (nameTok !== undefined && nameTok.t === "word") this.consume();
      if (this.isOp(this.peek(), "(") && this.isOp(this.peek(1), ")")) {
        this.consume();
        this.consume();
      }
    } else {
      nameTok = first;
      if (this.isOp(this.peek(), "(") && this.isOp(this.peek(1), ")")) {
        this.consume();
        this.consume();
      } else {
        this.malformed = true;
      }
    }
    const body = this.parseCommand(); // function body
    const stage = this.compoundStage(first, ["function"], body.inner);
    stage.body = body;
    stage.words = nameTok !== undefined && nameTok.t === "word" ? [nameTok.word] : [];
    return stage;
  }

  private parseSimple(): Stage {
    const first = this.peek();
    if (first === undefined) return this.emptyStage();
    const stage: Stage = {
      start: first.start,
      end: first.end,
      words: [],
      assignments: [],
      redirects: [],
      modifiers: [],
      keywords: [],
      inner: [],
    };
    let prefixPosition = true;
    while (true) {
      const tok = this.peek();
      if (tok === undefined) break;
      if (tok.t === "word") {
        if (tok.word.isAssignment && prefixPosition) {
          stage.assignments.push(tok.text);
          stage.words.push(tok.word);
          this.consume();
          // bash array assignment: `arr=(1 2 3)` — consume the balanced
          // literal; element words stay visible to grading (a command
          // substitution inside executes at assignment time).
          if (this.isOp(this.peek(), "(")) {
            let d = 0;
            while (this.peek() !== undefined) {
              const element = this.consume()!;
              if (element.t === "word") {
                stage.words.push(element.word);
              } else if (element.t === "op" && element.value === "(") {
                d++;
              } else if (element.t === "op" && element.value === ")") {
                d--;
                if (d === 0) break;
              }
            }
            const lastToken = this.tokens[this.pos - 1];
            if (lastToken !== undefined) stage.end = lastToken.end;
          }
          continue;
        }
        prefixPosition = false;
        stage.words.push(tok.word);
        this.consume();
        continue;
      }
      if (tok.t === "redirect") {
        const ok = this.parseRedirectInto(stage);
        if (!ok) break;
        continue;
      }
      break;
    }
    const last = this.tokens[this.pos - 1];
    stage.end = last !== undefined ? last.end : stage.start;
    return stage;
  }

  /** Parse one redirect (op + target word) into the stage. */
  private parseRedirectInto(stage: Stage): boolean {
    const tok = this.peek();
    if (tok === undefined || tok.t !== "redirect") return false;
    this.consume();
    const target = this.peek();
    if (target === undefined || target.t !== "word") {
      this.malformed = true;
      return false;
    }
    this.consume();
    const info: RedirectInfo = {
      op: tok.op,
      fd: tok.fd,
      target: target.text,
      targetStart: target.start,
      targetEnd: target.end,
      quoted: target.word.quoted,
      hasExpansion: target.word.hasExpansion,
      hasCmdSubstitution: target.word.hasCmdSubstitution,
      cmdSubs: target.word.cmdSubs,
      heredocIndex: tok.heredocIndex,
      start: tok.start,
      end: target.end,
    };
    stage.redirects.push(info);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — Grading
// ---------------------------------------------------------------------------

const MODIFIER_WORDS = new Set([
  "sudo", "nohup", "env", "exec", "timeout", "nice", "setsid", "command", "builtin",
]);

const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

const MODIFIER_VALUE_FLAGS = new Set(["-u", "-g", "-p", "-n", "-s", "-D", "-C", "-i", "-w"]);

const POWER_COMMANDS = new Set(["shutdown", "reboot", "poweroff", "halt"]);

const BLOCK_DEVICE_RE = /^\/dev\/(sd|hd|vd|nvme|mmcblk|xvd|dasd)/;

/** Destructive `rm` targets: filesystem root or the home directory itself. */
const RM_ROOT_TARGETS = new Set(["/", "//", "/*", "~", "~/", "~/*"]);

const CHMOD_ROOT_TARGETS = new Set(["/", "//", "/*", "~", "~/", "~/*"]);

const WORST_ORDER: Record<StatementKind, number> = { safe: 0, opaque: 1, dangerous: 2 };

function worstKind(a: StatementKind, b: StatementKind): StatementKind {
  return WORST_ORDER[a] >= WORST_ORDER[b] ? a : b;
}

/** Credential-path patterns (~/.ssh, .env, .bash_history, .gnupg, id_rsa...). */
function isCredentialPath(path: string): boolean {
  if (path.length === 0) return false;
  const lower = path.toLowerCase();
  if (lower.includes(".ssh/") || lower.endsWith(".ssh") || lower === "~/.ssh") return true;
  if (lower.includes("id_rsa") || lower.includes("id_ed25519") || lower.includes("id_ecdsa") || lower.includes("id_dsa")) {
    return true;
  }
  if (lower.includes(".bash_history")) return true;
  if (lower.includes(".gnupg/") || lower.endsWith(".gnupg")) return true;
  if (lower.includes(".aws/credentials")) return true;
  const base = lower.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.startsWith(".env");
}

interface ClassifierContext {
  input: string;
  lexer: Lexer;
  resolved: ResolvedOptions;
  /** Current scanWithDepth recursion depth (for nested cmdsub scans). */
  depthOf: () => number;
}

class Classifier {
  private readonly ctx: ClassifierContext;

  constructor(ctx: ClassifierContext) {
    this.ctx = ctx;
  }

  /** Classify parser statements and assemble the final result. */
  classifyAll(drafts: StatementDraft[], malformed: boolean): ScanResult {
    const { input, lexer } = this.ctx;
    const statements: ShellStatement[] = [];
    let opaque = false;
    let dangerous = false;
    if (malformed) {
      statements.push({
        text: input,
        start: 0,
        end: input.length,
        kind: "opaque",
        reasons: [REASONS.unterminatedConstruct, REASONS.dynamicUnparseable],
        tokens: [],
        redirects: [],
        heredocs: [],
        assignments: [],
        modifiers: [],
        commands: [],
      });
      opaque = true;
    }
    for (const draft of drafts) {
      const graded = this.classifyDraft(draft);
      statements.push(graded.statement, ...graded.nested);
    }
    // Diagnostics that fall outside every statement (e.g. an unmatched
    // heredoc body at end of input) still mean unparsed content — surface
    // them as synthetic opaque statements.
    for (const diag of lexer.diagnostics) {
      const covered = statements.some(
        (statement) => diag.end > statement.start && diag.start < statement.end,
      );
      if (covered) continue;
      statements.push({
        text: input.slice(diag.start, Math.min(diag.end, input.length)),
        start: diag.start,
        end: Math.min(diag.end, input.length),
        kind: "opaque",
        reasons:
          diag.code === "unsupported-construct"
            ? [REASONS.unsupportedConstruct]
            : [REASONS.unterminatedConstruct, REASONS.dynamicUnparseable],
        tokens: [],
        redirects: [],
        heredocs: [],
        assignments: [],
        modifiers: [],
        commands: [],
      });
    }
    for (const statement of statements) {
      if (statement.kind === "opaque") opaque = true;
      if (statement.kind === "dangerous") dangerous = true;
    }
    return this.finish(input, lexer, statements, opaque, dangerous);
  }

  private finish(
    input: string,
    lexer: Lexer,
    statements: ShellStatement[],
    opaque: boolean,
    dangerous: boolean,
  ): ScanResult {
    return {
      input,
      statements,
      opaque,
      dangerous,
      heredocs: lexer.heredocs,
      redirects: collectRedirects(statements),
      reasons: [],
    };
  }

  /** Classify one statement draft (recursively grading nested compounds). */
  private classifyDraft(draft: StatementDraft): {
    statement: ShellStatement;
    nested: ShellStatement[];
  } {
    const { input, lexer } = this.ctx;
    let kind: StatementKind = "safe";
    const reasons: string[] = [];
    const addReason = (reason: string): void => {
      if (!reasons.includes(reason)) reasons.push(reason);
    };
    const commands: string[] = [];
    const nestedStatements: ShellStatement[] = [];

    // Lexer diagnostics overlapping this statement's span force fail-closed
    // (overlap, not containment: e.g. the zsh `=(` diagnostic starts one byte
    // before a following subshell statement).
    for (const diag of lexer.diagnostics) {
      if (diag.end <= draft.start || diag.start >= draft.end) continue;
      if (diag.code === "unsupported-construct") {
        addReason(REASONS.unsupportedConstruct);
        kind = worstKind(kind, "opaque");
      } else {
        addReason(REASONS.unterminatedConstruct);
        addReason(REASONS.dynamicUnparseable);
        kind = worstKind(kind, "opaque");
      }
    }

    // Per-stage grading.
    for (const stage of draft.stages) {
      const stageResult = this.gradeStage(stage);
      for (const reason of stageResult.reasons) addReason(reason);
      kind = worstKind(kind, stageResult.kind);
      commands.push(stageResult.command);
      // A function definition body is graded too (its redirects and a simple
      // body command; nested statements come through stage.inner below).
      if (stage.body !== undefined) {
        const bodyResult = this.gradeStage(stage.body);
        for (const reason of bodyResult.reasons) addReason(reason);
        kind = worstKind(kind, bodyResult.kind);
      }
      // Nested compound statements are graded on their own and aggregate up.
      for (const inner of stage.inner) {
        const graded = this.classifyDraft(inner);
        nestedStatements.push(graded.statement, ...graded.nested);
        if (graded.statement.kind !== "safe") {
          for (const reason of graded.statement.reasons) addReason(reason);
          kind = worstKind(kind, graded.statement.kind);
        }
      }
    }

    // curl/wget piped into a shell interpreter.
    if (this.isPipeToShell(draft.stages, commands)) {
      addReason(REASONS.dangerousPipeToShell);
      kind = worstKind(kind, "dangerous");
    }

    // Heredoc checks for this statement's redirects.
    kind = this.applyHeredocRules(draft, addReason, kind);

    // Command substitutions anywhere in the statement execute content —
    // scan the inner script recursively and merge the verdict.
    kind = this.applyCmdSubRules(draft, addReason, kind);

    const statement: ShellStatement = {
      text: input.slice(draft.start, draft.end),
      start: draft.start,
      end: draft.end,
      kind,
      reasons,
      tokens: this.collectTokens(draft),
      redirects: draft.stages.flatMap((stage) => stage.redirects),
      heredocs: collectStatementHeredocs(draft, lexer),
      assignments: draft.stages.flatMap((stage) => stage.assignments),
      modifiers: draft.stages.flatMap((stage) => stage.modifiers),
      commands,
    };
    return { statement, nested: nestedStatements };
  }

  private collectTokens(draft: StatementDraft): ScanToken[] {
    const tokens: ScanToken[] = [];
    for (const token of this.ctx.lexer.tokens) {
      if (token.start < draft.start || token.end > draft.end) continue;
      if (token.t === "word") {
        const expansions = token.word.parts
          .filter((part): part is Extract<WordPart, { type: "expansion" }> => part.type === "expansion")
          .map((part) => part.info);
        tokens.push({
          kind: "word",
          text: token.text,
          start: token.start,
          end: token.end,
          quoted: token.word.quoted,
          reserved: token.word.isReserved || undefined,
          expansions: expansions.length > 0 ? expansions : undefined,
          hasCmdSubstitution: token.word.hasCmdSubstitution || undefined,
          hasUnquotedExpansion: token.word.hasUnquotedExpansion || undefined,
        });
      } else if (token.t === "op") {
        tokens.push({ kind: "op", text: token.value, start: token.start, end: token.end, quoted: false });
      } else if (token.t === "redirect") {
        tokens.push({ kind: "op", text: token.text, start: token.start, end: token.end, quoted: false });
      } else if (token.t === "comment") {
        tokens.push({ kind: "comment", text: token.text, start: token.start, end: token.end, quoted: false });
      } else {
        tokens.push({ kind: "newline", text: token.text, start: token.start, end: token.end, quoted: false });
      }
    }
    return tokens;
  }

  private applyHeredocRules(
    draft: StatementDraft,
    addReason: (reason: string) => void,
    kind: StatementKind,
  ): StatementKind {
    for (const info of collectStatementHeredocs(draft, this.ctx.lexer)) {
      if (info.op === "<<<") continue;
      if (info.delimiterQuoted) continue;
      if (info.text.includes("$(") || info.text.includes("`")) {
        addReason(REASONS.dynamicHeredocExpansion);
        kind = worstKind(kind, "opaque");
      }
    }
    return kind;
  }

  private applyCmdSubRules(
    draft: StatementDraft,
    addReason: (reason: string) => void,
    kind: StatementKind,
  ): StatementKind {
    const subs: ExpansionInfo[] = [];
    for (const stage of draft.stages) {
      for (const word of stage.words) subs.push(...word.cmdSubs);
      for (const redirect of stage.redirects) subs.push(...(redirect.cmdSubs ?? []));
    }
    for (const sub of subs) {
      if (sub.kind === "arith") {
        const inner = sub.inner ?? sub.text;
        if (inner.includes("$(") || inner.includes("`")) {
          addReason(REASONS.dynamicCmdSubContent);
          kind = worstKind(kind, "opaque");
        }
        continue;
      }
      if (sub.inner === undefined) continue;
      let innerResult: ScanResult;
      try {
        innerResult = scanWithDepth(sub.inner, this.ctx.resolved, this.depth() + 1);
      } catch (error) {
        if (error instanceof ScanAbort) throw error;
        throw error;
      }
      for (const statement of innerResult.statements) {
        if (statement.kind === "safe") continue;
        for (const reason of statement.reasons) {
          addReason(`cmdsub:${reason}`);
        }
        kind = worstKind(kind, statement.kind);
      }
      if (innerResult.opaque && innerResult.reasons.includes(REASONS.budgetExceeded)) {
        addReason(REASONS.budgetExceeded);
        kind = worstKind(kind, "opaque");
      }
    }
    return kind;
  }

  private depth(): number {
    return this.ctx.depthOf?.() ?? 0;
  }

  /** Grade a single pipeline stage; returns its kind, reasons and command name. */
  private gradeStage(stage: Stage): { kind: StatementKind; reasons: string[]; command: string } {
    const reasons: string[] = [];
    const addReason = (reason: string): void => {
      if (!reasons.includes(reason)) reasons.push(reason);
    };
    let kind: StatementKind = "safe";

    // Redirect-based dangerous checks apply to every stage kind.
    kind = this.checkRedirects(stage, addReason, kind);

    if (stage.keywords.length > 0) {
      // Compound header checks: expansions in `for`/`case` header words are
      // executed before the loop body runs.
      for (const word of stage.words) {
        if (word.hasCmdSubstitution) {
          addReason(REASONS.dynamicCmdSubContent);
          kind = worstKind(kind, "opaque");
        }
      }
      return { kind, reasons, command: stage.keywords[0] ?? "" };
    }

    // Resolve the effective command: strip assignment prefixes (`FOO=1 cmd`,
    // also as `env`/`sudo` arguments) and well-known modifier words with
    // their flag arguments.
    const words = stage.words;
    let i = 0;
    while (i < words.length) {
      const word = words[i]!;
      if (word.isAssignment) {
        i++;
        continue;
      }
      const staticText = word.staticText;
      if (staticText === null || !MODIFIER_WORDS.has(staticText)) break;
      stage.modifiers.push(staticText);
      i++;
      if (staticText === "timeout") {
        // `timeout [FLAGS] DURATION CMD` — skip the duration word.
        while (i < words.length) {
          const flag = words[i]!.staticText;
          if (flag === null || !flag.startsWith("-")) break;
          if (MODIFIER_VALUE_FLAGS.has(flag)) i++;
          i++;
        }
        if (i < words.length && words[i]!.staticText !== null && !words[i]!.staticText!.startsWith("-")) {
          i++;
        }
        continue;
      }
      while (i < words.length) {
        const flag = words[i]!.staticText;
        if (flag === null || !flag.startsWith("-") || flag === "-") break;
        if (MODIFIER_VALUE_FLAGS.has(flag)) i++;
        i++;
      }
    }
    const cmdWord = i < words.length ? words[i]! : null;
    if (cmdWord === null) {
      // Assignment-only / redirect-only statement.
      return { kind, reasons, command: "" };
    }

    if (cmdWord.hasCmdSubstitution) {
      addReason(REASONS.dynamicCommandWordCmdSub);
      return { kind: worstKind(kind, "opaque"), reasons, command: "" };
    }
    if (cmdWord.hasExpansion) {
      // Even a quoted expansion in command position executes dynamic content.
      addReason(REASONS.dynamicCommandWordExpansion);
      return { kind: worstKind(kind, "opaque"), reasons, command: "" };
    }

    const name = cmdWord.staticText ?? "";
    const args = words.slice(i + 1);

    if (name === "eval") {
      addReason(REASONS.dynamicEval);
      kind = worstKind(kind, "opaque");
    } else if (name === "source" || name === ".") {
      addReason(REASONS.dynamicSource);
      kind = worstKind(kind, "opaque");
    } else if (name.startsWith("mkfs")) {
      addReason(REASONS.dangerousMkfs);
      kind = worstKind(kind, "dangerous");
    } else if (POWER_COMMANDS.has(name)) {
      addReason(REASONS.dangerousPowerControl);
      kind = worstKind(kind, "dangerous");
    } else if (name === "rm") {
      kind = this.checkRm(args, addReason, kind);
    } else if (name === "chmod") {
      kind = this.checkChmod(args, addReason, kind);
    } else if (name === "dd") {
      kind = this.checkDd(args, addReason, kind);
    } else if (SHELL_INTERPRETERS.has(name) || name === "busybox") {
      kind = this.checkShellC(name, args, addReason, kind);
    }

    // Credential-path access through any argument.
    for (const arg of args) {
      if (arg.hasCmdSubstitution) continue; // content scanned separately
      const candidate = arg.staticText ?? arg.text;
      if (isCredentialPath(candidate)) {
        addReason(REASONS.dangerousCredentialPath);
        kind = worstKind(kind, "dangerous");
        break;
      }
    }

    return { kind, reasons, command: name };
  }

  private checkRedirects(
    stage: Stage,
    addReason: (reason: string) => void,
    kind: StatementKind,
  ): StatementKind {
    for (const redirect of stage.redirects) {
      if (redirect.op === "<" || redirect.op === "<<" || redirect.op === "<<-" || redirect.op === "<<<") {
        // Input redirections cannot destroy a block device.
        if (isCredentialPath(redirect.target)) {
          addReason(REASONS.dangerousCredentialPath);
          kind = worstKind(kind, "dangerous");
        }
        continue;
      }
      const target = redirect.target;
      if (!redirect.hasExpansion && BLOCK_DEVICE_RE.test(target)) {
        addReason(REASONS.dangerousRedirectBlockDevice);
        kind = worstKind(kind, "dangerous");
      }
      if (isCredentialPath(target)) {
        addReason(REASONS.dangerousCredentialPath);
        kind = worstKind(kind, "dangerous");
      }
    }
    return kind;
  }

  private checkRm(
    args: Word[],
    addReason: (reason: string) => void,
    kind: StatementKind,
  ): StatementKind {
    let hasRecursive = false;
    let hasForce = false;
    const targets: Word[] = [];
    let flagsEnded = false;
    for (const arg of args) {
      const staticText = arg.staticText;
      if (!flagsEnded && staticText !== null && staticText.startsWith("-") && staticText !== "-") {
        if (staticText === "--") {
          flagsEnded = true;
          continue;
        }
        if (staticText === "--recursive" || staticText === "-r" || staticText === "-R") hasRecursive = true;
        if (staticText === "--force" || staticText === "-f") hasForce = true;
        if (staticText.startsWith("-") && !staticText.startsWith("--")) {
          hasRecursive = hasRecursive || /[rR]/.test(staticText.slice(1));
          hasForce = hasForce || staticText.slice(1).includes("f");
        }
        continue;
      }
      targets.push(arg);
    }
    if (!hasRecursive || !hasForce) return kind;
    for (const target of targets) {
      if (target.hasExpansion) {
        // Card rule: rm -rf with a variable-expanded target fails closed.
        addReason(REASONS.dangerousRmRoot);
        return worstKind(kind, "dangerous");
      }
      const literal = target.staticText;
      if (literal !== null && RM_ROOT_TARGETS.has(literal)) {
        addReason(REASONS.dangerousRmRoot);
        return worstKind(kind, "dangerous");
      }
    }
    return kind;
  }

  private checkChmod(
    args: Word[],
    addReason: (reason: string) => void,
    kind: StatementKind,
  ): StatementKind {
    let hasMode = false;
    const targets: string[] = [];
    for (const arg of args) {
      const staticText = arg.staticText;
      if (staticText === null) continue;
      if (staticText.startsWith("-")) continue;
      if (staticText === "777" || staticText === "0777") {
        hasMode = true;
        continue;
      }
      targets.push(staticText);
    }
    if (!hasMode) return kind;
    for (const target of targets) {
      if (CHMOD_ROOT_TARGETS.has(target)) {
        addReason(REASONS.dangerousChmodRoot);
        return worstKind(kind, "dangerous");
      }
    }
    return kind;
  }

  private checkDd(
    args: Word[],
    addReason: (reason: string) => void,
    kind: StatementKind,
  ): StatementKind {
    for (const arg of args) {
      const raw = arg.text;
      if (!raw.startsWith("of=/dev/")) continue;
      if (arg.hasExpansion) {
        addReason(REASONS.dangerousDdBlockDevice);
        return worstKind(kind, "dangerous");
      }
      const value = raw.slice(3);
      if (BLOCK_DEVICE_RE.test(value)) {
        addReason(REASONS.dangerousDdBlockDevice);
        return worstKind(kind, "dangerous");
      }
    }
    return kind;
  }

  private checkShellC(
    name: string,
    args: Word[],
    addReason: (reason: string) => void,
    kind: StatementKind,
  ): StatementKind {
    // Find the `-c` flag and take the following word as the script.
    // Combined short flags like `-lc` / `-ic` also carry the -c option.
    let script: Word | null = null;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      const staticText = arg.staticText;
      if (staticText === "-c") {
        script = args[i + 1] ?? null;
        break;
      }
      if (
        staticText !== null &&
        staticText.startsWith("-") &&
        !staticText.startsWith("--") &&
        staticText.length > 1 &&
        staticText.slice(1).includes("c") &&
        staticText.slice(1).split("").every((ch) => "abcdehiklmnoprstuvx".includes(ch))
      ) {
        script = args[i + 1] ?? null;
        break;
      }
      // `busybox sh -c ...` — the interpreter name comes first.
      if (name === "busybox" && staticText !== null && SHELL_INTERPRETERS.has(staticText)) {
        continue;
      }
    }
    if (script === null) return kind;
    if (script.hasExpansion || script.hasCmdSubstitution) {
      addReason(REASONS.dynamicShellCScript);
      return worstKind(kind, "opaque");
    }
    const scriptText = script.staticText;
    if (scriptText === null) return kind;
    const innerResult = scanWithDepth(scriptText, this.ctx.resolved, this.depth() + 1);
    for (const statement of innerResult.statements) {
      if (statement.kind === "safe") continue;
      for (const reason of statement.reasons) {
        addReason(`embedded-script:${reason}`);
      }
      kind = worstKind(kind, statement.kind);
    }
    return kind;
  }

  private isPipeToShell(stages: Stage[], commands: string[]): boolean {
    for (let i = 0; i < stages.length; i++) {
      const name = commands[i] ?? "";
      if (name !== "curl" && name !== "wget" && name !== "curlie") continue;
      for (let j = i + 1; j < stages.length; j++) {
        const consumer = commands[j] ?? "";
        if (SHELL_INTERPRETERS.has(consumer)) return true;
      }
    }
    return false;
  }
}

function collectRedirects(statements: ShellStatement[]): RedirectInfo[] {
  return statements.flatMap((statement) => statement.redirects);
}

/** Heredocs owned by this statement, via its heredoc redirects. */
function collectStatementHeredocs(draft: StatementDraft, lexer: Lexer): HeredocInfo[] {
  const result: HeredocInfo[] = [];
  for (const stage of draft.stages) {
    for (const redirect of stage.redirects) {
      if (redirect.heredocIndex === undefined) continue;
      const info = lexer.heredocs[redirect.heredocIndex];
      if (info !== undefined) result.push(info);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Deterministically scan a shell command line and grade every statement. */
export function scanShell(input: string, options?: ScanOptions): ScanResult {
  const resolved = resolveOptions(options);
  // Fail-closed on oversized input before doing any work.
  if (input.length > resolved.maxInputLength) {
    return budgetExceededResult(input);
  }
  try {
    return scanWithDepth(input, resolved, 0);
  } catch (error) {
    if (error instanceof ScanAbort) {
      return budgetExceededResult(input);
    }
    throw error;
  }
}

/** Internal recursive entry honoring the nesting-depth budget. */
function scanWithDepth(input: string, resolved: ResolvedOptions, depth: number): ScanResult {
  if (depth > resolved.maxDepth) throw new ScanAbort("depth-budget-exceeded");
  const lexer = new Lexer(input, resolved.maxTokens, resolved.maxDepth);
  try {
    lexer.run();
  } catch (error) {
    if (error instanceof ScanAbort) throw error;
    throw error;
  }
  const parser = new Parser(lexer.tokens, resolved.maxDepth);
  parser.parseProgram();
  const classifier = new Classifier({
    input,
    lexer,
    resolved,
    depthOf: () => depth,
  });
  return classifier.classifyAll(parser.statements, parser.malformed);
}

function budgetExceededResult(input: string): ScanResult {
  return {
    input,
    statements: [
      {
        text: input,
        start: 0,
        end: input.length,
        kind: "opaque",
        reasons: [REASONS.budgetExceeded],
        tokens: [],
        redirects: [],
        heredocs: [],
        assignments: [],
        modifiers: [],
        commands: [],
      },
    ],
    opaque: true,
    dangerous: false,
    heredocs: [],
    redirects: [],
    reasons: [REASONS.budgetExceeded],
  };
}

/**
 * Test/diagnostic helper: run the lexer only and expose its raw tokens,
 * diagnostics and heredoc captures. Not part of the stable public surface.
 */
export function lexDebug(input: string, options?: ScanOptions): {
  tokens: LexToken[];
  diagnostics: LexDiagnostic[];
  heredocs: HeredocInfo[];
} {
  const resolved = resolveOptions(options);
  if (input.length > resolved.maxInputLength) {
    throw new ScanAbort("input-budget-exceeded");
  }
  const lexer = new Lexer(input, resolved.maxTokens, resolved.maxDepth);
  try {
    lexer.run();
  } catch (error) {
    if (error instanceof ScanAbort) {
      lexer.diagnostics.push({
        code: "unterminated-construct",
        detail: error.detail,
        start: 0,
        end: input.length,
      });
      return { tokens: lexer.tokens, diagnostics: lexer.diagnostics, heredocs: lexer.heredocs };
    }
    throw error;
  }
  return { tokens: lexer.tokens, diagnostics: lexer.diagnostics, heredocs: lexer.heredocs };
}
