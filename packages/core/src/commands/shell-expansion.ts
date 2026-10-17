/**
 * BI-01.2 — Shell 参数展开器: 变量文本展开 + 引号感知参数拆分。
 *
 * 安全边界 (与 BI-06 的分工): 本文件只做 *文本级* 展开——
 * $VAR/${VAR} 字面替换、引号/转义/~ 拆分。绝不执行子进程:
 * $(...) 命令替换与反引号一律保留字面 (由 BI-06 的沙箱执行层处置)。
 * 零依赖; strict。
 */

// ---------------------------------------------------------------------------
// 变量展开
// ---------------------------------------------------------------------------

/**
 * $VAR / ${VAR} 字面替换 (env 提供映射):
 * - 已定义 → 替换为值;
 * - 未定义 → 保留原文字面 (安全缺省: 不静默删除用户文本);
 * - `\$` → 字面 `$` (转义);
 * - `$(...)`、反引号、`$$`、`$1` 一律不动 (无子进程执行; 位置参数归 expandCommand)。
 */
export function expandShellVars(text: string, env: Readonly<Record<string, string>>): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === '\\' && text[i + 1] === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (ch !== '$') {
      out += ch;
      i += 1;
      continue;
    }
    const next = text[i + 1] ?? '';
    if (next === '{') {
      const close = text.indexOf('}', i + 2);
      if (close === -1) {
        out += ch; // 未闭合 ${ : 保留字面
        i += 1;
        continue;
      }
      const name = text.slice(i + 2, close);
      if (name === '' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        out += text.slice(i, close + 1); // 非法名: 保留字面
      } else {
        out += name in env ? env[name]! : text.slice(i, close + 1);
      }
      i = close + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(next)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j] ?? '')) j += 1;
      const name = text.slice(i + 1, j);
      if (name in env) {
        out += env[name]!;
        i = j;
        continue;
      }
      out += ch; // 未定义: 保留字面
      i += 1;
      continue;
    }
    out += ch; // $ 后非变量字符 ($$、$(、$1、行尾): 保留字面
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 引号感知参数拆分
// ---------------------------------------------------------------------------

/** 拆分选项。 */
export interface ParseShellArgsOptions {
  /** 提供时, 未加引号的行首 `~` 展开为该目录 (如 os 家目录); 缺省保留字面。 */
  home?: string;
}

interface CharScan {
  token: string;
  /** 首字符是否未经引号包裹 (~ 展开仅对此生效)。 */
  unquotedStart: boolean;
}

/**
 * 引号感知参数拆分 (类 POSIX shell 词法):
 * - 单引号: 全字面, 无转义;
 * - 双引号: 内层 `\"` `\\` `\$` `` \` `` 转义生效, 其余 `\x` 保留反斜杠;
 * - 引号外: `\x` 转义任意字符; 空白分词; 空引号产出空参数 ('' 合法 token);
 * - `~` 展开: 仅当提供 home 且 token 行首字符为未引用 `~` 时前缀替换
 *   (`~` → home, `~/x` → home/x; `~user` 形态不展开, 保留字面)。
 */
export function parseShellArgs(input: string, opts: ParseShellArgsOptions = {}): string[] {
  const args: string[] = [];
  let cur: CharScan | null = null;
  let i = 0;
  const pushToken = () => {
    if (cur === null) return;
    let token = cur.token;
    if (opts.home !== undefined && cur.unquotedStart && token.startsWith('~')) {
      if (token === '~') {
        token = opts.home;
      } else if (token[1] === '/') {
        token = opts.home + token.slice(1);
      }
      // ~user 形态: 保留字面 (无 passwd 查询)
    }
    args.push(token);
    cur = null;
  };
  while (i < input.length) {
    const ch = input[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      pushToken();
      i += 1;
      continue;
    }
    if (ch === "'") {
      if (cur === null) cur = { token: '', unquotedStart: false };
      const close = input.indexOf("'", i + 1);
      if (close === -1) {
        cur.token += input.slice(i + 1); // 未闭合: 尽力收尾
        i = input.length;
        continue;
      }
      cur.token += input.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      if (cur === null) cur = { token: '', unquotedStart: false };
      i += 1;
      let closed = false;
      while (i < input.length) {
        const c = input[i] ?? '';
        if (c === '\\' && ['"', '\\', '$', '`'].includes(input[i + 1] ?? '')) {
          cur.token += input[i + 1]!;
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        cur.token += c;
        i += 1;
      }
      if (!closed) {
        // 未闭合双引号: 已尽力收尾
      }
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      if (cur === null) cur = { token: '', unquotedStart: false };
      cur.token += input[i + 1]!;
      i += 2;
      continue;
    }
    if (cur === null) {
      const unquotedStart = ch === '~';
      cur = { token: ch, unquotedStart };
    } else {
      cur.token += ch;
    }
    i += 1;
  }
  pushToken();
  return args;
}
