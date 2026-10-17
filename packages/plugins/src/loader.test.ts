import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  discoverPlugins,
  loadPlugin,
  parseFrontmatter,
  PluginLoadError,
  probePluginManifest,
  validatePlugin,
} from './loader';
import { Marketplace } from './marketplace';

// ---------------------------------------------------------------------------
// tmp fixture 基建
// ---------------------------------------------------------------------------

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bi17-loader-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeFile(rel: string, text: string): Promise<string> {
  const abs = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
  return abs;
}

function writeJson(rel: string, obj: unknown): Promise<string> {
  return writeFile(rel, JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------------------
// 双协议探测矩阵
// ---------------------------------------------------------------------------

describe('loadPlugin · 双协议探测矩阵', () => {
  test('Anthropic 形态：.claude-plugin/plugin.json 被识别为 claude 协议', async () => {
    await writeJson('p1/.claude-plugin/plugin.json', {
      name: 'research-pack',
      version: '1.2.0',
      description: '研报插件',
    });
    const manifest = await loadPlugin(path.join(tmpRoot, 'p1'));
    expect(manifest.name).toBe('research-pack');
    expect(manifest.version).toBe('1.2.0');
    expect(manifest.description).toBe('研报插件');
    expect(manifest.skills).toEqual([]);
  });

  test('zcode 点目录形态：.zcode-plugin/plugin.json 被识别为 zcode 协议', async () => {
    await writeJson('p2/.zcode-plugin/plugin.json', { name: 'bi-zcode' });
    const probe = await probePluginManifest(path.join(tmpRoot, 'p2'));
    expect(probe?.protocol).toBe('zcode');
    const manifest = await loadPlugin(path.join(tmpRoot, 'p2'));
    expect(manifest.name).toBe('bi-zcode');
  });

  test('zcode 根级形态：目录内 plugin.json 被识别为 zcode 协议', async () => {
    await writeJson('p3/plugin.json', { name: 'bi-flat' });
    const probe = await probePluginManifest(path.join(tmpRoot, 'p3'));
    expect(probe?.protocol).toBe('zcode');
    expect(await loadPlugin(path.join(tmpRoot, 'p3'))).toMatchObject({ name: 'bi-flat' });
  });

  test('探测优先级：.claude-plugin 优先于 .zcode-plugin 与根级 plugin.json', async () => {
    await writeJson('p4/.claude-plugin/plugin.json', { name: 'from-claude' });
    await writeJson('p4/.zcode-plugin/plugin.json', { name: 'from-zcode-dot' });
    await writeJson('p4/plugin.json', { name: 'from-zcode-flat' });
    const probe = await probePluginManifest(path.join(tmpRoot, 'p4'));
    expect(probe?.protocol).toBe('claude');
    expect(await loadPlugin(path.join(tmpRoot, 'p4'))).toMatchObject({ name: 'from-claude' });
  });

  test("protocol: 'claude' 强制后不探测 zcode 形态", async () => {
    await writeJson('p5/plugin.json', { name: 'zcode-only' });
    await expect(
      loadPlugin(path.join(tmpRoot, 'p5'), { protocol: 'claude' }),
    ).rejects.toMatchObject({ code: 'no-manifest' });
  });

  test('无清单 → 结构化 no-manifest；目录不存在 → dir-not-found', async () => {
    await fs.mkdir(path.join(tmpRoot, 'empty'));
    const noManifest = await loadPlugin(path.join(tmpRoot, 'empty')).catch((e) => e);
    expect(noManifest).toBeInstanceOf(PluginLoadError);
    expect((noManifest as PluginLoadError).code).toBe('no-manifest');

    const missing = await loadPlugin(path.join(tmpRoot, 'nope')).catch((e) => e);
    expect((missing as PluginLoadError).code).toBe('dir-not-found');
  });

  test('清单 JSON 畸形 → manifest-malformed；name 缺失 → name-missing', async () => {
    await writeFile('p6/.claude-plugin/plugin.json', '{ not json !!!');
    const malformed = await loadPlugin(path.join(tmpRoot, 'p6')).catch((e) => e);
    expect((malformed as PluginLoadError).code).toBe('manifest-malformed');

    await writeJson('p7/plugin.json', { version: '0.1.0' });
    const noName = await loadPlugin(path.join(tmpRoot, 'p7')).catch((e) => e);
    expect((noName as PluginLoadError).code).toBe('name-missing');
  });
});

// ---------------------------------------------------------------------------
// skills/ 扫描与 frontmatter 解析
// ---------------------------------------------------------------------------

describe('loadPlugin · skills 扫描与 frontmatter', () => {
  test('子目录 SKILL.md：frontmatter.name 优先，正文与路径齐备', async () => {
    await writeJson('p8/plugin.json', { name: 'skills-basic' });
    const md = await writeFile(
      'p8/skills/scan/SKILL.md',
      '---\nname: 深度扫描\ndescription: 扫描研报技能\n---\n\n正文第一行。\n',
    );
    const manifest = await loadPlugin(path.join(tmpRoot, 'p8'));
    expect(manifest.skills).toHaveLength(1);
    const skill = manifest.skills[0]!;
    expect(skill.name).toBe('深度扫描');
    expect(skill.path).toBe(md);
    expect(skill.body).toBe('正文第一行。');
    expect(skill.frontmatter['description']).toBe('扫描研报技能');
  });

  test('平铺单 .md 文件与唯一 .md 子目录两种落位', async () => {
    await writeJson('p9/plugin.json', { name: 'skills-flat' });
    await writeFile('p9/skills/flat.md', '---\nname: flat\n---\n平铺正文');
    const flat = await loadPlugin(path.join(tmpRoot, 'p9'));
    expect(flat.skills.map((s) => s.name)).toEqual(['flat']);

    await writeJson('p9b/plugin.json', { name: 'skills-single-dir' });
    await writeFile('p9b/skills/singles/only.md', '---\nname: only\n---\n唯一正文');
    const singleDir = await loadPlugin(path.join(tmpRoot, 'p9b'));
    expect(singleDir.skills.map((s) => s.name)).toEqual(['only']);
  });

  test('frontmatter 列表项（key: 后跟 - x）与布尔值解析', async () => {
    await writeJson('p10/plugin.json', { name: 'fm-types' });
    await writeFile(
      'p10/skills/a/SKILL.md',
      ['---', 'tags:', '  - a', '  - b', 'enabled: true', 'disabled: false', 'plain: hello', '---', 'body'].join('\n'),
    );
    const manifest = await loadPlugin(path.join(tmpRoot, 'p10'));
    const fm = manifest.skills[0]!.frontmatter;
    expect(fm['tags']).toEqual(['a', 'b']);
    expect(fm['enabled']).toBe(true);
    expect(fm['disabled']).toBe(false);
    expect(fm['plain']).toBe('hello');
  });

  test('frontmatter 引号剥离与畸形行容错（无冒号行、无归属列表项被跳过）', async () => {
    const parsed = parseFrontmatter(
      ['---', 'name: "quoted name"', "single: 'single quoted'", 'not-a-kv-line', '- orphan', 'ok: v', '---', 'B'].join('\n'),
    );
    expect(parsed.fenced).toBe(true);
    expect(parsed.frontmatter['name']).toBe('quoted name');
    expect(parsed.frontmatter['single']).toBe('single quoted');
    expect(parsed.frontmatter['ok']).toBe('v');
    expect(Object.keys(parsed.frontmatter).sort()).toEqual(['name', 'ok', 'single']);
    expect(parsed.body).toBe('B');
  });

  test('无围栏 / 围栏未闭合 → fenced:false 容错；重复键后者覆盖', async () => {
    expect(parseFrontmatter('没有围栏的正文')).toEqual({ frontmatter: {}, body: '没有围栏的正文', fenced: false });
    expect(parseFrontmatter('---\nname: a\n没有闭合').fenced).toBe(false);
    const dup = parseFrontmatter('---\nname: first\nname: second\n---\n');
    expect(dup.frontmatter['name']).toBe('second');
  });

  test('无 skills/ 目录 → skills 为空数组', async () => {
    await writeJson('p11/plugin.json', { name: 'no-skills' });
    expect((await loadPlugin(path.join(tmpRoot, 'p11'))).skills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mcpServers 声明透传（不启动）
// ---------------------------------------------------------------------------

describe('loadPlugin · mcpServers 声明透传', () => {
  test('command 与 url 条目原样透传，未知字段保留（纯数据，不解释）', async () => {
    await writeJson('p12/plugin.json', {
      name: 'mcp-passthrough',
      mcpServers: {
        local: { command: 'bun', args: ['run', 'server.ts'], env: { FOO: 'bar' } },
        remote: { url: 'https://example.com/sse' },
      },
    });
    const manifest = await loadPlugin(path.join(tmpRoot, 'p12'));
    expect(manifest.mcpServers?.['local']).toEqual({
      command: 'bun',
      args: ['run', 'server.ts'],
      env: { FOO: 'bar' },
    });
    expect(manifest.mcpServers?.['remote']).toEqual({ url: 'https://example.com/sse' });
  });

  test('非对象条目被声明层丢弃（validate 负责报告）', async () => {
    await writeJson('p13/plugin.json', {
      name: 'mcp-dirty',
      mcpServers: { good: { command: 'ls' }, bad: 'not-an-object' },
    });
    const manifest = await loadPlugin(path.join(tmpRoot, 'p13'));
    expect(Object.keys(manifest.mcpServers ?? {})).toEqual(['good']);
  });
});

// ---------------------------------------------------------------------------
// discoverPlugins 多根发现
// ---------------------------------------------------------------------------

describe('discoverPlugins · 多根发现与去重', () => {
  test('多根扫描：两个根各一插件，全部载入', async () => {
    await writeJson('root-a/alpha/plugin.json', { name: 'alpha' });
    await writeJson('root-b/beta/.claude-plugin/plugin.json', { name: 'beta' });
    const result = await discoverPlugins([
      path.join(tmpRoot, 'root-a'),
      path.join(tmpRoot, 'root-b'),
    ]);
    expect(result.plugins.map((p) => p.name).sort()).toEqual(['alpha', 'beta']);
    expect(result.rejected).toEqual([]);
  });

  test('重复 name 后者拒绝：先到先得，rejected 指向后一候选目录', async () => {
    await writeJson('root-a/dup/plugin.json', { name: 'dup', version: 'first' });
    await writeJson('root-b/dup/plugin.json', { name: 'dup', version: 'second' });
    const result = await discoverPlugins([
      path.join(tmpRoot, 'root-a'),
      path.join(tmpRoot, 'root-b'),
    ]);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]?.version).toBe('first');
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.name).toBe('dup');
    expect(result.rejected[0]?.dir).toBe(path.join(tmpRoot, 'root-b', 'dup'));
    expect(result.rejected[0]?.reason).toContain('duplicate-name');
  });

  test('非插件子目录、文件与不存在的根被静默跳过', async () => {
    await writeJson('root/real/plugin.json', { name: 'real' });
    await writeJson('root/not-plugin/readme.txt', '不是插件');
    await writeFile('root/loose-file.txt', 'loose');
    const result = await discoverPlugins([
      path.join(tmpRoot, 'root'),
      path.join(tmpRoot, 'missing-root'),
    ]);
    expect(result.plugins.map((p) => p.name)).toEqual(['real']);
    expect(result.rejected).toEqual([]);
  });

  test('候选加载失败（畸形清单）→ rejected 记录原因而非抛出', async () => {
    await writeFile('root/broken/.claude-plugin/plugin.json', '{{{');
    const result = await discoverPlugins([path.join(tmpRoot, 'root')]);
    expect(result.plugins).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain('manifest-malformed');
  });
});

// ---------------------------------------------------------------------------
// validatePlugin 结构化问题清单
// ---------------------------------------------------------------------------

describe('validatePlugin · 问题清单', () => {
  test('完整双协议插件（zcode 点目录形态）→ ok:true', async () => {
    await writeJson('ok1/.zcode-plugin/plugin.json', {
      name: 'healthy',
      version: '1.0.0',
      description: '健康插件',
      skills: ['skills/scan/SKILL.md'],
      mcpServers: { svc: { command: 'bun' }, web: { url: 'https://x' } },
    });
    await writeFile('ok1/skills/scan/SKILL.md', '---\nname: scan\n---\nbody');
    const report = await validatePlugin(path.join(tmpRoot, 'ok1'));
    expect(report).toEqual({ ok: true, problems: [] });
  });

  test('缺 name / version 类型错误 → manifest 前缀问题', async () => {
    await writeJson('bad1/plugin.json', { name: '', version: 3 });
    const report = await validatePlugin(path.join(tmpRoot, 'bad1'));
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes('缺少必填字段 name'))).toBe(true);
    expect(report.problems.some((p) => p === 'manifest: version 应为字符串')).toBe(true);
  });

  test('JSON 畸形与无清单各自有稳定问题文案', async () => {
    await writeFile('bad2/plugin.json', '{oops');
    expect((await validatePlugin(path.join(tmpRoot, 'bad2'))).problems[0]).toContain('JSON 解析失败');

    await fs.mkdir(path.join(tmpRoot, 'bad3'), { recursive: true });
    expect((await validatePlugin(path.join(tmpRoot, 'bad3'))).problems[0]).toContain('未找到清单');
  });

  test('清单声明的 skills 路径不存在 → 结构化指出缺失路径', async () => {
    await writeJson('bad4/plugin.json', { name: 'x', skills: ['skills/ghost.md'] });
    const report = await validatePlugin(path.join(tmpRoot, 'bad4'));
    expect(report.problems).toContain('skills: 清单声明的技能路径不存在: skills/ghost.md');
  });

  test('mcpServers 条目缺 command 与 url → 按名报告', async () => {
    await writeJson('bad5/plugin.json', {
      name: 'x',
      mcpServers: { broken: { args: ['no-command-no-url'] } },
    });
    const report = await validatePlugin(path.join(tmpRoot, 'bad5'));
    expect(report.problems).toContain('mcpServers.broken: 声明缺少 command 或 url 之一');
  });

  test('skills 子目录既无 SKILL.md 又无唯一 .md；SKILL.md 缺围栏 → 报告', async () => {
    await writeJson('bad6/plugin.json', { name: 'x' });
    await writeFile('bad6/skills/multi/a.md', 'a');
    await writeFile('bad6/skills/multi/b.md', 'b');
    await writeFile('bad6/skills/nofence/SKILL.md', '没有围栏');
    const report = await validatePlugin(path.join(tmpRoot, 'bad6'));
    expect(report.problems).toContain("skills: 子目录 'multi' 缺少 SKILL.md 或唯一 .md 文件");
    expect(report.problems.some((p) => p.includes('缺少 frontmatter'))).toBe(true);
    expect(report.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 纯数据断言：加载全程零子进程 spawn（注入 spawn spy）
// ---------------------------------------------------------------------------

type SpawnSpy = { calls: string[]; restore: () => void };

/**
 * 注入 spawn spy：覆盖 node:child_process 与 Bun.spawn 的可变属性。
 * 说明：ESM 具名绑定（import { spawn }）无法被运行时拦截，此 spy 是
 * 防回归金丝雀——若未来有人在声明层引入执行面，CJS 形态调用与
 * Bun.spawn 都会被计数并抛错。
 */
function installSpawnSpy(): SpawnSpy {
  const calls: string[] = [];
  const guard = (fnName: string) => () => {
    calls.push(fnName);
    throw new Error(`BI-17 纯数据断言被触发：声明层不允许 ${fnName}()`);
  };
  const require_ = createRequire(import.meta.url);
  const cp = require_('node:child_process') as Record<string, unknown>;
  const cpPatched: Array<[string, unknown]> = [];
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    if (typeof cp[fn] === 'function') {
      cpPatched.push([fn, cp[fn]]);
      cp[fn] = guard(fn);
    }
  }
  const bun = (globalThis as unknown as { Bun?: Record<string, unknown> }).Bun;
  const bunPatched: Array<[string, unknown]> = [];
  if (bun) {
    for (const fn of ['spawn', 'spawnSync']) {
      if (typeof bun[fn] === 'function') {
        bunPatched.push([fn, bun[fn]]);
        bun[fn] = guard(fn);
      }
    }
  }
  return {
    calls,
    restore() {
      for (const [k, v] of cpPatched) cp[k] = v;
      if (bun) {
        for (const [k, v] of bunPatched) bun[k] = v;
      }
    },
  };
}

describe('纯数据断言 · 声明层零子进程', () => {
  test('加载含 mcpServers command 声明的插件：loadPlugin/discover/validate/marketplace 全程零 spawn', async () => {
    // 构造最容易"诱发"执行的输入：清单里带 command + skills 带 url 声明
    await writeJson('m1/.claude-plugin/plugin.json', {
      name: 'spawn-bait',
      mcpServers: { dangerous: { command: 'rm', args: ['-rf', '/'] } },
    });
    await writeFile('m1/skills/bait/SKILL.md', '---\nname: bait\n---\ndo evil');
    await writeJson('market/marketplace.json', { plugins: [{ name: 'spawn-bait', source: '../m1' }] });

    const spy = installSpawnSpy();
    try {
      const manifest = await loadPlugin(path.join(tmpRoot, 'm1'));
      expect(manifest.mcpServers?.['dangerous']?.['command']).toBe('rm'); // 声明只是数据
      await discoverPlugins([path.join(tmpRoot, 'm1')]);
      await validatePlugin(path.join(tmpRoot, 'm1'));
      const market = new Marketplace();
      await market.index(path.join(tmpRoot, 'market'));
      await market.install('spawn-bait', path.join(tmpRoot, 'into'));
    } finally {
      spy.restore();
    }
    expect(spy.calls).toEqual([]);
  });
});
