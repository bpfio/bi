import { describe, expect, test } from 'bun:test';
import { expandShellVars, parseShellArgs } from './shell-expansion';

// ---------------------------------------------------------------------------
// expandShellVars —— $VAR / ${VAR} 文本展开
// ---------------------------------------------------------------------------

describe('BI-01.2 expandShellVars —— 变量文本展开', () => {
  const env = { HOME: '/home/u', WORKSPACE: 'bi', EMPTY: '' };

  test('$VAR 已定义 → 替换为值', () => {
    expect(expandShellVars('cd $HOME/bin', env)).toBe('cd /home/u/bin');
  });

  test('${VAR} 花括号形态 → 替换为值, 可紧邻后缀', () => {
    expect(expandShellVars('${WORKSPACE}-dev', env)).toBe('bi-dev');
  });

  test('未定义变量 → 保留字面 (安全缺省, 不静默删除)', () => {
    expect(expandShellVars('$NOPE/$HOME', env)).toBe('$NOPE//home/u');
  });

  test('${UNSET} 未定义花括号形态 → 保留原样', () => {
    expect(expandShellVars('x=${UNSET}!', env)).toBe('x=${UNSET}!');
  });

  test('\\$ 转义 → 字面 $ (不展开)', () => {
    expect(expandShellVars('price \\$HOME $HOME', env)).toBe('price $HOME /home/u');
  });

  test('连续多变量依序展开', () => {
    expect(expandShellVars('$HOME:$WORKSPACE', env)).toBe('/home/u:bi');
  });

  test('已定义空值变量 → 替换为空串', () => {
    expect(expandShellVars('a=${EMPTY}b', env)).toBe('a=b');
  });

  test('非法名 ${1ABC} 与未闭合 ${ → 保留字面', () => {
    expect(expandShellVars('${1ABC}', env)).toBe('${1ABC}');
    expect(expandShellVars('open ${BRK', env)).toBe('open ${BRK');
  });

  test('空 env: 无可展开项, 原文透传', () => {
    expect(expandShellVars('$HOME ${HOME} $', {})).toBe('$HOME ${HOME} $');
  });
});

// ---------------------------------------------------------------------------
// 展开安全 —— 无子进程执行断言 (本卡只做变量文本展开, 命令执行归 BI-06)
// ---------------------------------------------------------------------------

describe('BI-01.2 expandShellVars —— 展开安全 (零进程执行)', () => {
  const env = { HOME: '/home/u' };

  test('$(...) 命令替换不执行, 保留字面', () => {
    const input = 'out=$(rm -rf /) $HOME';
    expect(expandShellVars(input, env)).toBe('out=$(rm -rf /) /home/u');
  });

  test('反引号命令替换不执行, 保留字面', () => {
    const input = 'x=`cat /etc/passwd` y=$HOME';
    expect(expandShellVars(input, env)).toBe('x=`cat /etc/passwd` y=/home/u');
  });

  test('$$ 与 $1 等非变量形态保留字面 (位置参数归 expandCommand)', () => {
    expect(expandShellVars('pid=$$ pos=$1', env)).toBe('pid=$$ pos=$1');
  });

  test('变量值注入命令替换形态时也不被执行 (纯字符串, 无求值)', () => {
    const dangerous = { CMD: '$(echo pwned)' };
    expect(expandShellVars('run $CMD', dangerous)).toBe('run $(echo pwned)');
  });
});

// ---------------------------------------------------------------------------
// parseShellArgs —— 引号感知参数拆分
// ---------------------------------------------------------------------------

describe('BI-01.2 parseShellArgs —— 引号感知拆分', () => {
  test('朴素空白分词 (连续空格/制表符折叠)', () => {
    expect(parseShellArgs('a  b\t c')).toEqual(['a', 'b', 'c']);
  });

  test('单引号: 空格与特殊字符全字面', () => {
    expect(parseShellArgs("a 'b  c' d")).toEqual(['a', 'b  c', 'd']);
  });

  test('单引号内 $VAR 不展开语义由调用方保证, 拆分层仅保字面', () => {
    expect(parseShellArgs("'$HOME'")).toEqual(['$HOME']);
  });

  test('双引号: 空格保留且允许跨词合并 token', () => {
    expect(parseShellArgs('cmd "a b" c')).toEqual(['cmd', 'a b', 'c']);
  });

  test('双引号内转义 \\" \\\\ 生效', () => {
    expect(parseShellArgs('"a\\"b\\\\c"')).toEqual(['a"b\\c']);
  });

  test('双引号内其余反斜杠保留字面 (POSIX 行为)', () => {
    expect(parseShellArgs('"a\\nb"')).toEqual(['a\\nb']);
  });

  test('引号外反斜杠转义任意字符 (空格/引号/反斜杠)', () => {
    expect(parseShellArgs('a\\ b \'x\' "y"')).toEqual(['a b', 'x', 'y']);
    expect(parseShellArgs('\\$HOME \\\\')).toEqual(['$HOME', '\\']);
  });

  test('引号嵌套: 单内双/双内单按字面收编', () => {
    expect(parseShellArgs('"it\'s" \'say "hi"\'')).toEqual(["it's", 'say "hi"']);
  });

  test('空引号产出空串参数 (位置占位合法)', () => {
    expect(parseShellArgs("a '' b \"\"")).toEqual(['a', '', 'b', '']);
  });

  test('未闭合引号: 尽力收尾不抛异常', () => {
    expect(parseShellArgs("a 'unclosed")).toEqual(['a', 'unclosed']);
    expect(parseShellArgs('"unclosed')).toEqual(['unclosed']);
  });

  test('空输入与纯空白 → 空数组', () => {
    expect(parseShellArgs('')).toEqual([]);
    expect(parseShellArgs('   \t\n ')).toEqual([]);
  });

  test('~ 展开: 提供 home 时未引用行首 ~ 与 ~/x 前缀替换', () => {
    expect(parseShellArgs('~', { home: '/home/u' })).toEqual(['/home/u']);
    expect(parseShellArgs('~/notes todo.md', { home: '/home/u' })).toEqual([
      '/home/u/notes',
      'todo.md',
    ]);
  });

  test('~ 引用或 mid-token 时不展开; ~user 形态保留字面', () => {
    expect(parseShellArgs('"~"', { home: '/home/u' })).toEqual(['~']);
    expect(parseShellArgs("a~b", { home: '/home/u' })).toEqual(['a~b']);
    expect(parseShellArgs('~root/etc', { home: '/home/u' })).toEqual(['~root/etc']);
  });

  test('未提供 home: ~ 保留字面', () => {
    expect(parseShellArgs('~/x')).toEqual(['~/x']);
  });

  test('混合矩阵: 引号+转义+~+变量字面一屏', () => {
    const argv = parseShellArgs("deploy '$TAG' \"v $N\" \\$H ~", {
      home: '/h',
    });
    expect(argv).toEqual(['deploy', '$TAG', 'v $N', '$H', '/h']);
  });
});
