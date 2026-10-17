import { describe, expect, test } from 'bun:test';
import {
  ANSI,
  buildDiffFromFiles,
  formatHunkHeader,
  parseDiff,
  presentDiff,
  renderDiff,
  type DiffModel,
} from './diff-view';

const RESET = '\u001b[0m';

const MULTI_FILE_DIFF = [
  'diff --git a/src/math.ts b/src/math.ts',
  'index 1111111..2222222 100644',
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -1,4 +1,5 @@ export function add',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const b2 = 4;',
  ' const c = 5;',
  ' const d = 6;',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..abcdef0',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+hello',
  '+world',
].join('\n');

describe('BI-20 diff-view —— hunk 解析', () => {
  test('单文件修改:文件路径/状态/增删汇总', () => {
    const model = parseDiff(MULTI_FILE_DIFF);
    expect(model.files.length).toBe(2);
    const first = model.files[0]!;
    expect(first.path).toBe('src/math.ts');
    expect(first.status).toBe('modified');
    expect(first.additions).toBe(2);
    expect(first.deletions).toBe(1);
  });

  test('hunk 头解析:起止/计数/heading', () => {
    const hunk = parseDiff(MULTI_FILE_DIFF).files[0]!.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldCount).toBe(4);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newCount).toBe(5);
    expect(hunk.heading).toBe('export function add');
  });

  test('省略计数的 hunk 头 @@ -3 +3 @@ 按计数 1 处理', () => {
    const model = parseDiff('--- a/x.txt\n+++ b/x.txt\n@@ -3 +3 @@\n-old\n+new');
    const hunk = model.files[0]!.hunks[0]!;
    expect(hunk.oldStart).toBe(3);
    expect(hunk.oldCount).toBe(1);
    expect(hunk.newStart).toBe(3);
    expect(hunk.newCount).toBe(1);
  });

  test('行级 +/-/上下文与 oldNum/newNum 追踪', () => {
    const lines = parseDiff(MULTI_FILE_DIFF).files[0]!.hunks[0]!.lines;
    expect(lines.map((l) => l.kind)).toEqual([
      'context',
      'del',
      'add',
      'add',
      'context',
      'context',
    ]);
    expect(lines[0]!.oldNum).toBe(1);
    expect(lines[0]!.newNum).toBe(1);
    expect(lines[1]!.oldNum).toBe(2);
    expect(lines[1]!.newNum).toBe(null);
    expect(lines[2]!.newNum).toBe(2);
    expect(lines[3]!.newNum).toBe(3);
    expect(lines[4]!.oldNum).toBe(3);
    expect(lines[4]!.newNum).toBe(4);
    expect(lines[5]!.oldNum).toBe(4);
    expect(lines[5]!.newNum).toBe(5);
  });

  test('新增文件:--- /dev/null → status=added,oldPath=null', () => {
    const file = parseDiff(MULTI_FILE_DIFF).files[1]!;
    expect(file.status).toBe('added');
    expect(file.oldPath).toBe(null);
    expect(file.path).toBe('src/new.ts');
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);
  });

  test('new file mode 头可独立触发 added(容忍缺 --- /dev/null)', () => {
    const model = parseDiff(
      'diff --git a/a.txt b/a.txt\nnew file mode 100644\n@@ -0,0 +1,1 @@\n+hi',
    );
    expect(model.files[0]!.status).toBe('added');
    expect(model.files[0]!.oldPath).toBe(null);
  });

  test('删除文件:+++ /dev/null → status=deleted,path 取旧路径', () => {
    const model = parseDiff(
      'diff --git a/src/old.ts b/src/old.ts\ndeleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-goodbye\n-cruel',
    );
    const file = model.files[0]!;
    expect(file.status).toBe('deleted');
    expect(file.path).toBe('src/old.ts');
    expect(file.deletions).toBe(2);
    expect(file.additions).toBe(0);
  });

  test('重命名:rename from/to → status=renamed 且保留新旧路径', () => {
    const model = parseDiff(
      'diff --git a/src/before.ts b/src/after.ts\nsimilarity index 90%\nrename from src/before.ts\nrename to src/after.ts',
    );
    const file = model.files[0]!;
    expect(file.status).toBe('renamed');
    expect(file.oldPath).toBe('src/before.ts');
    expect(file.path).toBe('src/after.ts');
    expect(file.hunks.length).toBe(0);
  });

  test('二进制检测:Binary files ... differ → isBinary 且无 hunk', () => {
    const model = parseDiff(
      'diff --git a/assets/logo.png b/assets/logo.png\nindex 111..222 100644\nBinary files a/assets/logo.png and b/assets/logo.png differ',
    );
    const file = model.files[0]!;
    expect(file.isBinary).toBe(true);
    expect(file.status).toBe('binary');
    expect(file.hunks.length).toBe(0);
  });

  test('二进制检测:GIT binary patch 同样命中', () => {
    const model = parseDiff('diff --git a/img.bin b/img.bin\nGIT binary patch');
    expect(model.files[0]!.isBinary).toBe(true);
  });

  test('\\ No newline 标记行进 meta,不计增删', () => {
    const model = parseDiff('--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file');
    const hunk = model.files[0]!.hunks[0]!;
    expect(hunk.lines[1]!.kind).toBe('meta');
    expect(hunk.lines[3]!.kind).toBe('meta');
    expect(model.additions).toBe(1);
    expect(model.deletions).toBe(1);
  });

  test('模型级汇总 = 各文件之和;空文本 → 空模型', () => {
    const model = parseDiff(MULTI_FILE_DIFF);
    expect(model.additions).toBe(4);
    expect(model.deletions).toBe(1);
    const empty = parseDiff('');
    expect(empty.files).toEqual([]);
    expect(empty.additions).toBe(0);
    expect(empty.deletions).toBe(0);
  });
});

describe('BI-20 diff-view —— 渲染快照(纯 ANSI)', () => {
  const model: DiffModel = parseDiff(
    '--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n keep\n-del me\n+add me',
  );

  test('文件头为青色 [M] 行,含 +N -N 统计', () => {
    expect(renderDiff(model)[0]).toBe(`${ANSI.cyan}[M] x.ts (+1 -1)${RESET}`);
  });

  test('hunk 头为青色 @@ 行', () => {
    expect(renderDiff(model)[1]).toBe(`${ANSI.cyan}@@ -1,2 +1,2 @@${RESET}`);
  });

  test('上下文行无色,前缀空格', () => {
    expect(renderDiff(model)[2]).toBe(' keep');
  });

  test('删行红色 - 前缀', () => {
    expect(renderDiff(model)[3]).toBe(`${ANSI.red}-del me${RESET}`);
  });

  test('增行绿色 + 前缀', () => {
    expect(renderDiff(model)[4]).toBe(`${ANSI.green}+add me${RESET}`);
  });

  test('二进制文件只渲染头行并带 (binary) 标记', () => {
    const binary = parseDiff('diff --git a/img.bin b/img.bin\nGIT binary patch');
    expect(renderDiff(binary)).toEqual([`${ANSI.cyan}[B] img.bin (binary)${RESET}`]);
  });

  test('重命名文件头显示 old -> new;空模型渲染为空数组', () => {
    const renamed = parseDiff(
      'diff --git a/a.ts b/b.ts\nrename from a.ts\nrename to b.ts',
    );
    expect(renderDiff(renamed)[0]).toBe(`${ANSI.cyan}[R] a.ts -> b.ts (+0 -0)${RESET}`);
    expect(renderDiff({ files: [], additions: 0, deletions: 0 })).toEqual([]);
  });

  test('formatHunkHeader:带 heading 时拼接节标题', () => {
    expect(formatHunkHeader({ oldStart: 2, oldCount: 1, newStart: 2, newCount: 3, heading: 'fn', lines: [] })).toBe(
      '@@ -2,1 +2,3 @@ fn',
    );
  });
});

describe('BI-20 diff-view —— 审查门 presentDiff', () => {
  const model: DiffModel = parseDiff('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b');

  test('autoApprove 直接 approve,不触发审查回调', async () => {
    let called = 0;
    const decision = await presentDiff(model, {
      autoApprove: true,
      confirm: () => {
        called++;
        return true;
      },
    });
    expect(decision.decision).toBe('approve');
    expect(called).toBe(0);
  });

  test('confirm 返回 true → approve', async () => {
    const decision = await presentDiff(model, { confirm: () => true });
    expect(decision.decision).toBe('approve');
  });

  test('confirm 返回 false → reject 且带原因', async () => {
    const decision = await presentDiff(model, { confirm: () => false });
    expect(decision.decision).toBe('reject');
    expect(decision.reason).toContain('否决');
  });

  test('异步 confirm 回路(Promise 回调)照常工作', async () => {
    const decision = await presentDiff(model, { confirm: async (view) => view.length > 0 });
    expect(decision.decision).toBe('approve');
  });

  test('未注册 confirm 回调 → 默认拒绝(fail-closed)', async () => {
    const decision = await presentDiff(model, {});
    expect(decision.decision).toBe('reject');
    expect(decision.reason).toContain('默认拒绝');
  });

  test('空模型直接 approve', async () => {
    let called = 0;
    const decision = await presentDiff(
      { files: [], additions: 0, deletions: 0 },
      {
        confirm: () => {
          called++;
          return false;
        },
      },
    );
    expect(decision.decision).toBe('approve');
    expect(called).toBe(0);
  });

  test('confirm 抛异常 → reject(fail-closed)', async () => {
    const decision = await presentDiff(model, {
      confirm: () => {
        throw new Error('tui crashed');
      },
    });
    expect(decision.decision).toBe('reject');
    expect(decision.reason).toContain('tui crashed');
  });

  test('回调收到的视图包含 ANSI 渲染行与汇总数字', async () => {
    let seenView: readonly string[] = [];
    let seenSummary = { files: 0, additions: 0, deletions: 0 };
    await presentDiff(model, {
      confirm: (view, summary) => {
        seenView = view;
        seenSummary = summary;
        return true;
      },
    });
    expect(seenView.length).toBe(4);
    expect(seenView[3]).toBe(`${ANSI.green}+b${RESET}`);
    expect(seenSummary).toEqual({ files: 1, additions: 1, deletions: 1 });
  });
});

describe('BI-20 diff-view —— 旧/新文件对构建', () => {
  test('修改对:生成 hunk、行号与汇总正确', () => {
    const model = buildDiffFromFiles('a\nb\nc\nd\ne\nf', 'a\nB\nc\nd\nE\nf', 'src/letters.txt');
    expect(model.files[0]!.status).toBe('modified');
    expect(model.additions).toBe(2);
    expect(model.deletions).toBe(2);
    const hunk = model.files[0]!.hunks[0]!;
    // 两处变更相距 2 行(<= 2*context),上下文重叠,应合并为一个 hunk(自第 1 行起)
    expect(model.files[0]!.hunks.length).toBe(1);
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines.length).toBe(8);
    expect(hunk.lines.some((l) => l.kind === 'add' && l.text === 'B')).toBe(true);
    expect(hunk.lines.some((l) => l.kind === 'del' && l.text === 'b')).toBe(true);
  });

  test('相同内容:无 hunk、零增删', () => {
    const model = buildDiffFromFiles('same\ntext', 'same\ntext', 'x.txt');
    expect(model.files[0]!.hunks).toEqual([]);
    expect(model.additions).toBe(0);
    expect(model.deletions).toBe(0);
  });

  test('空旧文本 → 新增文件,-0,0 起始符合 git 惯例', () => {
    const model = buildDiffFromFiles('', 'l1\nl2', 'brand-new.txt');
    const file = model.files[0]!;
    expect(file.status).toBe('added');
    expect(file.oldPath).toBe(null);
    const hunk = file.hunks[0]!;
    expect(hunk.oldStart).toBe(0);
    expect(hunk.oldCount).toBe(0);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newCount).toBe(2);
  });

  test('空新文本 → 删除文件,新侧 -N,0', () => {
    const model = buildDiffFromFiles('only\nline', '', 'doomed.txt');
    const file = model.files[0]!;
    expect(file.status).toBe('deleted');
    const hunk = file.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldCount).toBe(2);
    expect(hunk.newStart).toBe(0);
    expect(hunk.newCount).toBe(0);
    expect(renderDiff(model)[0]).toBe(`${ANSI.cyan}[D] doomed.txt (+0 -2)${RESET}`);
  });

  test('远离的两处变更拆成两个 hunk(context=3 不搭桥)', () => {
    const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].join('\n');
    const neu = ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'L'].join('\n');
    const model = buildDiffFromFiles(old, neu, 'spread.txt');
    expect(model.files[0]!.hunks.length).toBe(2);
  });

  test('parseDiff 能消化 buildDiffFromFiles 的产物(往返一致)', () => {
    const built = buildDiffFromFiles('a\nb\nc', 'a\nB\nc', 'rt.ts');
    const reparsed = parseDiff(
      `--- a/rt.ts\n+++ b/rt.ts\n${built.files[0]!.hunks.map(formatHunkHeader).join('\n')}\n` +
        built.files[0]!.hunks[0]!.lines
          .map((l) => (l.kind === 'add' ? `+${l.text}` : l.kind === 'del' ? `-${l.text}` : ` ${l.text}`))
          .join('\n'),
    );
    expect(reparsed.additions).toBe(1);
    expect(reparsed.deletions).toBe(1);
    expect(reparsed.files[0]!.hunks[0]!.oldStart).toBe(built.files[0]!.hunks[0]!.oldStart);
  });
});
