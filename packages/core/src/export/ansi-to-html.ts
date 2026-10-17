/**
 * BI-20.3 — ANSI SGR -> CSS span 转换。
 *
 * 支持: \x1b[1m 粗体, \x1b[30m..37m 基础前景色, \x1b[0m/22m/39m 重置;
 * 未知码忽略 (剥离序列, 不产出 span 类)。输出 class 语义化
 * (如 ansi-red / ansi-bold), 颜色由 html-exporter 的主题 CSS 决定。
 * 文本先做 HTML 转义; 前景色槽位互斥 (后到者替换); 类名按固定规范序拼接。
 * 零依赖; 确定性。
 */

/** 基础前景色 SGR 30..37 -> 类名 (钉死)。 */
const FG_BY_CODE: Record<number, string> = {
  30: 'ansi-black',
  31: 'ansi-red',
  32: 'ansi-green',
  33: 'ansi-yellow',
  34: 'ansi-blue',
  35: 'ansi-magenta',
  36: 'ansi-cyan',
  37: 'ansi-white',
};

/** 固定调色板 (双主题一致, 确定性; 供内联 CSS 使用)。 */
const ANSI_PALETTE: Record<string, string> = {
  'ansi-black': '#808080',
  'ansi-red': '#cd3131',
  'ansi-green': '#0dbc79',
  'ansi-yellow': '#e5e510',
  'ansi-blue': '#2472c8',
  'ansi-magenta': '#bc3fbc',
  'ansi-cyan': '#11a8cd',
  'ansi-white': '#e5e5e5',
};

/** 规范类序 (钉死): bold 在前, 色按 30..37 升序。 */
export const ANSI_CLASS_ORDER: readonly string[] = [
  'ansi-bold',
  'ansi-black',
  'ansi-red',
  'ansi-green',
  'ansi-yellow',
  'ansi-blue',
  'ansi-magenta',
  'ansi-cyan',
  'ansi-white',
] as const;

/** ANSI 类的内联 CSS 片段 (html-exporter 拼入 <style>)。 */
export const ANSI_CSS: string = [
  '.ansi-bold { font-weight: bold; }',
  ...Object.entries(ANSI_PALETTE).map(([cls, color]) => `.${cls} { color: ${color}; }`),
].join('\n');

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 先 HTML 转义文本, 再按 SGR 状态机包裹 span。 */
export function ansiToHtml(input: string): string {
  let bold = false;
  let fg: string | null = null;
  let out = '';
  let last = 0;
  const re = /\u001b\[([0-9;]*)m/g;
  let m: RegExpExecArray | null;

  const emit = (raw: string): void => {
    if (raw === '') {
      return;
    }
    const escaped = escapeText(raw);
    const classes: string[] = [];
    if (bold) {
      classes.push('ansi-bold');
    }
    if (fg !== null) {
      classes.push(fg);
    }
    out += classes.length === 0 ? escaped : `<span class="${classes.join(' ')}">${escaped}</span>`;
  };

  while ((m = re.exec(input)) !== null) {
    emit(input.slice(last, m.index));
    last = re.lastIndex;
    const params = m[1] ?? '';
    const codes = params === '' ? [0] : params.split(';').map((s) => Number(s));
    for (const code of codes) {
      if (code === 0) {
        bold = false;
        fg = null;
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 39) {
        fg = null;
      } else if (code >= 30 && code <= 37) {
        fg = FG_BY_CODE[code] ?? null;
      }
      // 其余未知/不支持码: 忽略
    }
  }
  emit(input.slice(last));
  return out;
}
