import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadPlugin } from './loader';
import { Marketplace, MarketplaceError } from './marketplace';

// ---------------------------------------------------------------------------
// tmp fixture 基建
// ---------------------------------------------------------------------------

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bi17-market-'));
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

/** 建一个双协议共用的源插件（claude 形态，带技能与 mcpServers 声明）。 */
async function seedPlugin(rel: string, name: string): Promise<string> {
  await writeJson(`${rel}/.claude-plugin/plugin.json`, {
    name,
    version: '1.0.0',
    mcpServers: { local: { command: 'bun', args: ['x', 'srv'] } },
  });
  await writeFile(`${rel}/skills/scan/SKILL.md`, '---\nname: scan\n---\n扫描正文');
  return path.join(tmpRoot, rel);
}

// ---------------------------------------------------------------------------
// index（索引）
// ---------------------------------------------------------------------------

describe('Marketplace.index', () => {
  test('读取 marketplace.json → 目录索引（相对路径解析为绝对路径，按 name 排序）', async () => {
    await seedPlugin('srcs/beta', 'beta');
    await seedPlugin('srcs/alpha', 'alpha');
    await writeJson('market/marketplace.json', {
      plugins: [
        { name: 'beta', source: '../srcs/beta' },
        { name: 'alpha', source: '../srcs/../srcs/alpha' },
      ],
    });
    const idx = await new Marketplace().index(path.join(tmpRoot, 'market'));
    expect(idx.entries.map((e) => e.name)).toEqual(['alpha', 'beta']);
    expect(idx.entries[0]?.resolvedPath).toBe(path.join(tmpRoot, 'srcs/alpha'));
    expect(idx.problems).toEqual([]);
  });

  test('形态不合法条目进 problems，不中断其余条目索引', async () => {
    await seedPlugin('srcs/ok', 'ok');
    await writeJson('market/marketplace.json', {
      plugins: [{ source: '../srcs/ok' }, 'junk', { name: 'ok', source: '../srcs/ok' }],
    });
    const idx = await new Marketplace().index(path.join(tmpRoot, 'market'));
    expect(idx.entries.map((e) => e.name)).toEqual(['ok']);
    expect(idx.problems).toHaveLength(2);
    expect(idx.problems[0]).toContain('缺少非空 name 或 source');
    expect(idx.problems[1]).toContain('必须是 { name, source } 对象');
  });

  test('marketplace.json 重复 name → 后者忽略并记 problems', async () => {
    await seedPlugin('srcs/dup', 'dup');
    await writeJson('market/marketplace.json', {
      plugins: [
        { name: 'dup', source: '../srcs/dup' },
        { name: 'dup', source: '../srcs/dup-again' },
      ],
    });
    const idx = await new Marketplace().index(path.join(tmpRoot, 'market'));
    expect(idx.entries).toHaveLength(1);
    expect(idx.problems.some((p) => p.includes("重复 name 'dup'"))).toBe(true);
  });

  test('目录不存在 → marketplace-dir-not-found；文件缺失/畸形 → marketplace-malformed', async () => {
    const m = new Marketplace();
    const missingDir = await m.index(path.join(tmpRoot, 'nope')).catch((e) => e);
    expect(missingDir).toBeInstanceOf(MarketplaceError);
    expect((missingDir as MarketplaceError).code).toBe('marketplace-dir-not-found');

    await fs.mkdir(path.join(tmpRoot, 'm1'), { recursive: true });
    const noFile = await m.index(path.join(tmpRoot, 'm1')).catch((e) => e);
    expect((noFile as MarketplaceError).code).toBe('marketplace-malformed');

    await writeFile('m2/marketplace.json', '{bad json');
    const badJson = await m.index(path.join(tmpRoot, 'm2')).catch((e) => e);
    expect((badJson as MarketplaceError).code).toBe('marketplace-malformed');
  });
});

// ---------------------------------------------------------------------------
// install（安装：fs.cp 递归复制，不执行任何代码）
// ---------------------------------------------------------------------------

describe('Marketplace.install', () => {
  test('从索引递归复制插件目录到目标，内容逐字一致', async () => {
    await seedPlugin('srcs/pack', 'pack');
    await writeJson('market/marketplace.json', { plugins: [{ name: 'pack', source: '../srcs/pack' }] });
    const m = new Marketplace();
    await m.index(path.join(tmpRoot, 'market'));

    const into = path.join(tmpRoot, 'plugins');
    const result = await m.install('pack', into);
    expect(result).toEqual({ ok: true, name: 'pack', dest: path.join(into, 'pack') });

    // 复制结果可被声明层完整加载，技能与 mcpServers 声明无损
    const manifest = await loadPlugin(path.join(into, 'pack'));
    expect(manifest.name).toBe('pack');
    expect(manifest.skills.map((s) => s.name)).toEqual(['scan']);
    expect(manifest.mcpServers?.['local']).toEqual({ command: 'bun', args: ['x', 'srv'] });
  });

  test('重复安装 → already-installed 结构化结果，且不覆盖既有内容（哨兵保留）', async () => {
    await seedPlugin('srcs/pack', 'pack');
    await writeJson('market/marketplace.json', { plugins: [{ name: 'pack', source: '../srcs/pack' }] });
    const m = new Marketplace();
    await m.index(path.join(tmpRoot, 'market'));

    const into = path.join(tmpRoot, 'plugins');
    expect((await m.install('pack', into)).ok).toBe(true);

    const sentinel = path.join(into, 'pack', 'sentinel.txt');
    await fs.writeFile(sentinel, 'do-not-delete', 'utf8');
    // 同时篡改副本清单，验证 already-installed 分支不会重新复制覆盖
    await writeJson('plugins/pack/.claude-plugin/plugin.json', { name: 'tampered' });

    const again = await m.install('pack', into);
    expect(again).toEqual({
      ok: false,
      code: 'already-installed',
      name: 'pack',
      dest: path.join(into, 'pack'),
    });
    expect(await fs.readFile(sentinel, 'utf8')).toBe('do-not-delete');
    expect(await loadPlugin(path.join(into, 'pack'))).toMatchObject({ name: 'tampered' });
  });

  test('未索引 → not-indexed；不在索引 → not-in-index；源缺失 → source-missing', async () => {
    const m = new Marketplace();
    expect(await m.install('x', path.join(tmpRoot, 'a'))).toEqual({
      ok: false,
      code: 'not-indexed',
      name: 'x',
    });

    await writeJson('market/marketplace.json', {
      plugins: [{ name: 'ghost', source: '../nowhere' }],
    });
    await m.index(path.join(tmpRoot, 'market'));
    expect(await m.install('nobody', path.join(tmpRoot, 'a'))).toEqual({
      ok: false,
      code: 'not-in-index',
      name: 'nobody',
    });
    const missingSrc = await m.install('ghost', path.join(tmpRoot, 'a'));
    expect(missingSrc).toMatchObject({ ok: false, code: 'source-missing', name: 'ghost' });
  });
});

// ---------------------------------------------------------------------------
// listInstalled（已装列表：双协议识别）
// ---------------------------------------------------------------------------

describe('Marketplace.listInstalled', () => {
  test('双协议各装一例 → 全部列出且协议标记正确', async () => {
    await seedPlugin('installed/claude-pack', 'claude-pack');
    await writeJson('installed/zcode-pack/.zcode-plugin/plugin.json', { name: 'zcode-pack' });
    await writeJson('installed/zcode-flat/plugin.json', { name: 'zcode-flat' });
    await fs.mkdir(path.join(tmpRoot, 'installed/not-a-plugin'), { recursive: true });

    const m = new Marketplace();
    const installed = await m.listInstalled(path.join(tmpRoot, 'installed'));
    expect(installed.map((e) => e.name).sort()).toEqual(['claude-pack', 'zcode-flat', 'zcode-pack']);
    const byName = new Map(installed.map((e) => [e.name, e]));
    expect(byName.get('claude-pack')?.protocol).toBe('claude');
    expect(byName.get('zcode-pack')?.protocol).toBe('zcode');
    expect(byName.get('zcode-flat')?.protocol).toBe('zcode');
  });

  test('根不存在 → 空数组；清单畸形回退目录名', async () => {
    const m = new Marketplace();
    expect(await m.listInstalled(path.join(tmpRoot, 'missing'))).toEqual([]);

    await fs.mkdir(path.join(tmpRoot, 'installed/broken/.claude-plugin'), { recursive: true });
    await writeFile('installed/broken/.claude-plugin/plugin.json', '{oops');
    const installed = await m.listInstalled(path.join(tmpRoot, 'installed'));
    expect(installed).toHaveLength(1);
    expect(installed[0]?.name).toBe('broken');
  });
});
