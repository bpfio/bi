import { describe, expect, test } from 'bun:test';
import {
  baseName,
  discoverSlashCommands,
  expandCommand,
  joinPath,
  parseArgsSpec,
  parseFrontmatter,
  slashCommandSurface,
  type CommandFs,
  type SlashCommand,
} from './custom-commands';

// ---------------------------------------------------------------------------
// 测试用内存 FS: 由目录前缀推导目录存在性, 缺目录 readdir reject
// ---------------------------------------------------------------------------

function memFs(files: Record<string, string>): CommandFs {
  const dirs = new Set<string>();
  for (const key of Object.keys(files)) {
    const parts = key.split('/');
    parts.pop();
    let acc = '';
    for (const part of parts) {
      if (part === '') continue; // 绝对路径首段空串
      acc = acc === '' ? '/' + part : acc + '/' + part;
      dirs.add(acc);
    }
  }
  return {
    async readdir(path) {
      if (!dirs.has(path)) throw new Error(`ENOENT: ${path}`);
      const prefix = path.endsWith('/') ? path : path + '/';
      return Object.keys(files)
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map((k) => k.slice(prefix.length))
        .sort();
    },
    async readFile(p) {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
  };
}

const USER_DIR = '/home/u/.bi/commands';
const PROJ_DIR = '/home/u/proj/.bi/commands';

function makeCmd(overrides: Partial<SlashCommand>): SlashCommand {
  return {
    name: 'demo',
    description: '',
    argsSpec: '',
    requiredArgs: [],
    optionalArgs: [],
    sourceFile: '/x/demo.md',
    body: 'body',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 发现矩阵
// ---------------------------------------------------------------------------

describe('BI-01.2 discoverSlashCommands —— 发现矩阵', () => {
  test('双目录同时扫描: 用户目录与项目目录命令都收集', async () => {
    const fs = memFs({
      [`${USER_DIR}/ask.md`]: '---\nname: ask\ndescription: 用户级\n---\nbody-ask',
      [`${PROJ_DIR}/deploy.md`]: '---\nname: deploy\ndescription: 项目级\n---\nbody-deploy',
    });
    const result = await discoverSlashCommands([USER_DIR, PROJ_DIR], fs);
    expect(result.warnings).toEqual([]);
    expect(result.commands.map((c) => c.name).sort()).toEqual(['ask', 'deploy']);
  });

  test('优先序: 同名命令下标靠前的目录胜出 (先到先得)', async () => {
    const fs = memFs({
      [`${USER_DIR}/review.md`]: '---\nname: review\ndescription: 用户版\n---\nuser-body',
      [`${PROJ_DIR}/review.md`]: '---\nname: review\ndescription: 项目版\n---\nproject-body',
    });
    const result = await discoverSlashCommands([USER_DIR, PROJ_DIR], fs);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.description).toBe('用户版');
    expect(result.commands[0]?.sourceFile).toBe(`${USER_DIR}/review.md`);
  });

  test('缺目录容错: readdir reject 的目录静默跳过, 不中断其余目录', async () => {
    const fs = memFs({
      [`${PROJ_DIR}/only.md`]: '---\nname: only\ndescription: 孤存\n---\nb',
    });
    const result = await discoverSlashCommands(['/no/such/dir', PROJ_DIR], fs);
    expect(result.warnings).toEqual([]);
    expect(result.commands.map((c) => c.name)).toEqual(['only']);
  });

  test('frontmatter 缺 name: 回退文件名去 .md; 缺 description 回退空串', async () => {
    const fs = memFs({
      [`${USER_DIR}/git-pr.md`]: '---\ndescription: 有描述\n---\nbody',
      [`${USER_DIR}/bare.md`]: '无围栏纯正文',
    });
    const result = await discoverSlashCommands([USER_DIR], fs);
    // readdir 按字典序返回条目: bare.md 先于 git-pr.md
    expect(result.commands.map((c) => c.name)).toEqual(['bare', 'git-pr']);
    expect(result.commands[1]?.description).toBe('有描述');
    expect(result.commands[0]?.description).toBe('');
  });

  test('args 声明解析: <必选> 与 [可选] 依序入列', async () => {
    const fs = memFs({
      [`${USER_DIR}/q.md`]: '---\nname: q\ndescription: d\nargs: <query> <mode> [limit]\n---\nb',
    });
    const result = await discoverSlashCommands([USER_DIR], fs);
    const cmd = result.commands[0]!;
    expect(cmd.argsSpec).toBe('<query> <mode> [limit]');
    expect(cmd.requiredArgs).toEqual(['query', 'mode']);
    expect(cmd.optionalArgs).toEqual(['limit']);
  });

  test('非 .md 条目被忽略 (shell/txt 不入注册表)', async () => {
    const fs = memFs({
      [`${USER_DIR}/a.md`]: '---\nname: a\ndescription: x\n---\nb',
      [`${USER_DIR}/note.txt`]: 'nope',
      [`${USER_DIR}/run.sh`]: 'echo nope',
    });
    const result = await discoverSlashCommands([USER_DIR], fs);
    expect(result.commands.map((c) => c.name)).toEqual(['a']);
  });

  test('frontmatter 围栏未闭合: 告警并跳过该文件', async () => {
    const fs = memFs({
      [`${USER_DIR}/bad.md`]: '---\nname: bad\ndescription: 未闭合到 EOF',
      [`${USER_DIR}/good.md`]: '---\nname: good\ndescription: ok\n---\nb',
    });
    const result = await discoverSlashCommands([USER_DIR], fs);
    expect(result.commands.map((c) => c.name)).toEqual(['good']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.file).toBe(`${USER_DIR}/bad.md`);
  });

  test('readFile 失败的单文件: 告警不致命', async () => {
    const flaky: CommandFs = {
      readdir: async () => ['ghost.md', 'real.md'],
      readFile: async (p) => {
        if (p.endsWith('ghost.md')) throw new Error('EIO');
        return '---\nname: real\ndescription: r\n---\nb';
      },
    };
    const result = await discoverSlashCommands([USER_DIR], flaky);
    expect(result.commands.map((c) => c.name)).toEqual(['real']);
    expect(result.warnings[0]?.file).toBe(`${USER_DIR}/ghost.md`);
    expect(result.warnings[0]?.message).toContain('EIO');
  });
});

// ---------------------------------------------------------------------------
// frontmatter / argsSpec 单元
// ---------------------------------------------------------------------------

describe('BI-01.2 parseFrontmatter / parseArgsSpec / 路径工具', () => {
  test('parseFrontmatter: 首行非 --- 视为无围栏, 全文为 body', () => {
    const r = parseFrontmatter('name: x\nbody');
    expect(r.fields).toEqual({});
    expect(r.body).toBe('name: x\nbody');
    expect(r.malformed).toBe(false);
  });

  test('parseFrontmatter: key:value 切首个冒号, 值可含冒号', () => {
    const r = parseFrontmatter('---\nname: x\ndescription: 用法: 说明\n---\nB');
    expect(r.fields['name']).toBe('x');
    expect(r.fields['description']).toBe('用法: 说明');
    expect(r.body).toBe('B');
  });

  test('parseArgsSpec: 空/无占位声明 → 双空数组', () => {
    expect(parseArgsSpec('')).toEqual([[], []]);
    expect(parseArgsSpec('字面词 only')).toEqual([[], []]);
  });

  test('joinPath 容忍尾随斜杠; baseName 取末端段', () => {
    expect(joinPath('/a/b/', 'c.md')).toBe('/a/b/c.md');
    expect(joinPath('/a/b', 'c.md')).toBe('/a/b/c.md');
    expect(baseName('/a/b/c.md')).toBe('c.md');
    expect(baseName('plain.md')).toBe('plain.md');
  });
});

// ---------------------------------------------------------------------------
// 参数注入矩阵
// ---------------------------------------------------------------------------

describe('BI-01.2 expandCommand —— 参数注入矩阵', () => {
  test('$ARGUMENTS → argv 全文 (单空格连接)', () => {
    const cmd = makeCmd({ body: '全文: $ARGUMENTS' });
    const r = expandCommand(cmd, ['a', 'b c', 'd']);
    expect(r).toEqual({ ok: true, text: '全文: a b c d' });
  });

  test('{{args}} 双花括号形态等价 $ARGUMENTS', () => {
    const cmd = makeCmd({ body: 'A {{args}} B' });
    const r = expandCommand(cmd, ['x', 'y']);
    expect(r).toEqual({ ok: true, text: 'A x y B' });
  });

  test('$1..$n 位置参数依序注入', () => {
    const cmd = makeCmd({ body: '第一个=$1 第二个=$2 第三个=$3' });
    const r = expandCommand(cmd, ['p1', 'p2', 'p3']);
    expect(r).toEqual({ ok: true, text: '第一个=p1 第二个=p2 第三个=p3' });
  });

  test('$10 多位数字取第 10 个位置参数', () => {
    const argv = Array.from({ length: 10 }, (_, i) => `v${i + 1}`);
    const cmd = makeCmd({ body: '十号=$10 一号=$1' });
    const r = expandCommand(cmd, argv);
    expect(r).toEqual({ ok: true, text: '十号=v10 一号=v1' });
  });

  test('越界位置参数 → 空串 (可选语义)', () => {
    const cmd = makeCmd({ body: '[中括号=$2]' });
    const r = expandCommand(cmd, ['only']);
    expect(r).toEqual({ ok: true, text: '[中括号=]' });
  });

  test('$0 不展开, 保留字面 (仅 $1..$n 为位置参数)', () => {
    const cmd = makeCmd({ body: '$0 保持' });
    const r = expandCommand(cmd, ['a']);
    expect(r).toEqual({ ok: true, text: '$0 保持' });
  });

  test('参数内容含 $1 / {{args}} 字面时不得二次展开 (注入安全)', () => {
    const cmd = makeCmd({ body: 'out=$1 tpl={{args}}' });
    const r = expandCommand(cmd, ['$9', 'X{{args}}Y']);
    // $1 → 参数字面 '$9' 原样落位; {{args}} → 全文一次替换, 替换结果不再扫描
    expect(r).toEqual({ ok: true, text: 'out=$9 tpl=$9 X{{args}}Y' });
  });

  test('参数内容含 $ARGUMENTS 字面时不得二次展开 (单遍扫描)', () => {
    const cmd = makeCmd({ body: 'pos=$1 tpl={{args}}' });
    const r = expandCommand(cmd, ['$ARGUMENTS', 'X']);
    // 旧实现顺序 replaceAll 会把 $1 展开产物再次当作 $ARGUMENTS 占位替换
    expect(r).toEqual({ ok: true, text: 'pos=$ARGUMENTS tpl=$ARGUMENTS X' });
  });

  test('空 argv 且无必选声明: 全文占位展开为空串', () => {
    const cmd = makeCmd({ body: 'args=[$ARGUMENTS] pos=[$1]' });
    const r = expandCommand(cmd, []);
    expect(r).toEqual({ ok: true, text: 'args=[] pos=[]' });
  });

  test('必选占位缺失: missing-required 结构化错误, 列出缺失名', () => {
    const cmd = makeCmd({
      name: 'review',
      argsSpec: '<pr> [focus]',
      requiredArgs: ['pr'],
      optionalArgs: ['focus'],
      body: 'b',
    });
    const r = expandCommand(cmd, []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('missing-required');
      if (r.error.code === 'missing-required') {
        expect(r.error.missing).toEqual(['pr']);
      }
      expect(r.error.message).toContain('/review');
    }
  });

  test('必选占位空串视为缺失; 第二必选缺失同样入列', () => {
    const cmd = makeCmd({
      argsSpec: '<a> <b>',
      requiredArgs: ['a', 'b'],
      body: 'b',
    });
    const r = expandCommand(cmd, ['']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      if (r.error.code === 'missing-required') expect(r.error.missing).toEqual(['a', 'b']);
    }
  });

  test('必选齐备 + 可选缺省: 正常展开 (可选越界空串)', () => {
    const cmd = makeCmd({
      argsSpec: '<q> [limit]',
      requiredArgs: ['q'],
      optionalArgs: ['limit'],
      body: '查询=$1 上限=$2',
    });
    const r = expandCommand(cmd, ['错误日志']);
    expect(r).toEqual({ ok: true, text: '查询=错误日志 上限=' });
  });
});

// ---------------------------------------------------------------------------
// 调度表面
// ---------------------------------------------------------------------------

describe('BI-01.2 slashCommandSurface —— TUI 补全形态', () => {
  test('返回 name+description 最小表面, 保序输出', () => {
    const cmds = [
      makeCmd({ name: 'zebra', description: 'Z' }),
      makeCmd({ name: 'apple', description: 'A' }),
    ];
    expect(slashCommandSurface(cmds)).toEqual([
      { name: 'zebra', description: 'Z' },
      { name: 'apple', description: 'A' },
    ]);
  });

  test('空注册表 → 空表面', () => {
    expect(slashCommandSurface([])).toEqual([]);
  });
});
