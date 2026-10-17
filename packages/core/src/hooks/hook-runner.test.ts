/**
 * BI-06.4 外部生命周期钩子执行器测试。
 * 全部注入 spawn stub（零真实盘 IO），另设一组真实子进程集成用例验证缺省 spawn 实现。
 */
import { describe, expect, test } from 'bun:test';
import {
  HookRunner,
  parseHookOutput,
  type HookSpawnImpl,
  type HookSpawnResult,
} from './hook-runner';
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  type HookDefinition,
  type HookInput,
  type HooksConfig,
} from './types';
import { scanShell, type ScanResult } from '../sandbox/shell-scan';
import type { WorkspaceTrustState } from '../guard/workspace-trust';

/** 工单钉死的 20 事件清单（与 types.ts 双向比对） */
const EXPECTED_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
  'PreUndo',
  'PostUndo',
  'PreFileWrite',
  'PostFileWrite',
  'PreBash',
  'PostBash',
  'Interrupted',
  'DateChange',
  'ModelFallback',
  'ContextOverflow',
  'SessionFork',
] as const;

interface SpawnCall {
  command: string;
  cwd: string;
  stdin: string;
  timeoutMs: number;
}

type Responder = (call: SpawnCall, index: number) => Partial<HookSpawnResult>;

/** 队列式 spawn stub：记录调用并按应答函数产出结果（缺省 code 0 / 空输出） */
function stubSpawn(responder: Responder): { impl: HookSpawnImpl; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const impl: HookSpawnImpl = async (command, opts) => {
    const call: SpawnCall = {
      command,
      cwd: opts.cwd,
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
    };
    const index = calls.length;
    calls.push(call);
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...responder(call, index) };
  };
  return { impl, calls };
}

const jsonLine = (output: { action: string; reason?: string }): string =>
  `${JSON.stringify(output)}\n`;

/** 恒通过的安全扫描 stub（执行面用例不关心 BI-06.8 细节） */
const safeScan = (cmd: string): ScanResult => ({
  input: cmd,
  statements: [],
  opaque: false,
  dangerous: false,
  heredocs: [],
  redirects: [],
  reasons: [],
});

interface HarnessOptions {
  hooks: HookDefinition[];
  spawnImpl?: HookSpawnImpl;
  trustState?: WorkspaceTrustState;
  scanShellImpl?: (cmd: string) => ScanResult;
  clock?: () => number;
}

function harness(options: HarnessOptions): { runner: HookRunner; trustCalls: string[] } {
  const trustCalls: string[] = [];
  const runner = new HookRunner({
    config: { hooks: options.hooks } satisfies HooksConfig,
    spawnImpl: options.spawnImpl,
    clock: options.clock,
    trust: (root: string) => {
      trustCalls.push(root);
      return options.trustState ?? 'trusted';
    },
    scanShell: options.scanShellImpl ?? safeScan,
  });
  return { runner, trustCalls };
}

const baseInput: HookInput = {
  event: 'PreToolUse',
  sessionId: 'sess-1',
  tool: 'bash',
  args: { command: 'ls -la' },
  cwd: '/ws/demo',
  timestamp: '2026-10-16T08:00:00.000Z',
};

// ---------------------------------------------------------------------------

describe('HookEvent 枚举完备性', () => {
  test('20 种事件恰好与工单清单一致（双向）', () => {
    expect(HOOK_EVENTS.length).toBe(20);
    expect([...HOOK_EVENTS]).toEqual([...EXPECTED_EVENTS]);
  });

  test('20 个事件全部可触发；无钩子 → allow/ran 0 且不查信任门', async () => {
    const { runner, trustCalls } = harness({ hooks: [] });
    for (const event of HOOK_EVENTS) {
      const outcome = await runner.run(event, { ...baseInput, event });
      expect(outcome.action).toBe('allow');
      expect(outcome.ran).toBe(0);
      expect(outcome.records).toEqual([]);
    }
    expect(trustCalls.length).toBe(0);
  });
});

describe('事件匹配矩阵', () => {
  test('未匹配事件的钩子不执行', async () => {
    const { impl, calls } = stubSpawn(() => ({ stdout: jsonLine({ action: 'allow' }) }));
    const { runner } = harness({
      hooks: [{ event: 'SessionStart', command: 'echo session-start' }],
      spawnImpl: impl,
    });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.action).toBe('allow');
    expect(outcome.ran).toBe(0);
    expect(calls.length).toBe(0);
  });

  test('匹配事件的钩子恰好执行一次，stdin 为 HookInput JSON（逐字段）', async () => {
    const { impl, calls } = stubSpawn(() => ({ stdout: jsonLine({ action: 'allow' }) }));
    const { runner } = harness({
      hooks: [{ event: 'PreToolUse', command: './guard.sh' }],
      spawnImpl: impl,
    });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.action).toBe('allow');
    expect(outcome.ran).toBe(1);
    expect(calls.length).toBe(1);
    const stdinInput = JSON.parse(calls[0]!.stdin) as HookInput;
    expect(stdinInput.event).toBe('PreToolUse');
    expect(stdinInput.sessionId).toBe('sess-1');
    expect(stdinInput.tool).toBe('bash');
    expect(stdinInput.args).toEqual({ command: 'ls -la' });
    expect(stdinInput.cwd).toBe('/ws/demo');
    expect(stdinInput.timestamp).toBe('2026-10-16T08:00:00.000Z');
  });

  test('同事件多钩子按 config 顺序全部执行（其他事件不掺入）', async () => {
    const { impl, calls } = stubSpawn((call) => ({
      stdout: jsonLine({ action: 'allow', reason: call.command }),
    }));
    const { runner } = harness({
      hooks: [
        { event: 'PreToolUse', command: 'first.sh' },
        { event: 'PostToolUse', command: 'other.sh' },
        { event: 'PreToolUse', command: 'second.sh' },
        { event: 'PreToolUse', command: 'third.sh' },
      ],
      spawnImpl: impl,
    });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.action).toBe('allow');
    expect(outcome.ran).toBe(3);
    expect(calls.map((c) => c.command)).toEqual(['first.sh', 'second.sh', 'third.sh']);
    expect(outcome.records.map((r) => r.hookId)).toEqual(['hooks[0]', 'hooks[2]', 'hooks[3]']);
  });

  test('run() 的 event 参数权威：stdin JSON 的 event 以 run() 参数为准', async () => {
    const { impl, calls } = stubSpawn(() => ({ stdout: jsonLine({ action: 'allow' }) }));
    const { runner } = harness({ hooks: [{ event: 'PreBash', command: 'x.sh' }], spawnImpl: impl });
    await runner.run('PreBash', { ...baseInput, event: 'PostToolUse' });
    expect((JSON.parse(calls[0]!.stdin) as HookInput).event).toBe('PreBash');
  });
});

describe('信任门（BI-06.9，fail-closed）', () => {
  test('untrusted：零 spawn，逐条 skip 审计，主流程放行（即使钩子想 block）', async () => {
    const { impl, calls } = stubSpawn(() => ({
      stdout: jsonLine({ action: 'block', reason: 'nope' }),
    }));
    const { runner } = harness({
      hooks: [
        { event: 'PreToolUse', command: 'a.sh' },
        { event: 'PreToolUse', command: 'b.sh' },
      ],
      spawnImpl: impl,
      trustState: 'untrusted',
    });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(calls.length).toBe(0);
    expect(outcome.action).toBe('allow');
    expect(outcome.ran).toBe(0);
    expect(outcome.records.map((r) => r.status)).toEqual(['skipped-untrusted', 'skipped-untrusted']);
    expect(outcome.records[0]!.reason).toBe('untrusted-workspace: untrusted');
    expect(outcome.records[1]!.reason).toBe('untrusted-workspace: untrusted');
  });

  test('none：同样拒绝执行', async () => {
    const { impl, calls } = stubSpawn(() => ({ stdout: jsonLine({ action: 'block' }) }));
    const { runner } = harness({
      hooks: [{ event: 'PreBash', command: 'a.sh' }],
      spawnImpl: impl,
      trustState: 'none',
    });
    const outcome = await runner.run('PreBash', baseInput);
    expect(calls.length).toBe(0);
    expect(outcome.action).toBe('allow');
    expect(outcome.records[0]!.status).toBe('skipped-untrusted');
    expect(outcome.records[0]!.reason).toBe('untrusted-workspace: none');
  });

  test('trust 以 input.cwd（工作区根）为查询参数', async () => {
    const { impl } = stubSpawn(() => ({ stdout: jsonLine({ action: 'allow' }) }));
    const { runner, trustCalls } = harness({
      hooks: [{ event: 'PreToolUse', command: 'a.sh' }],
      spawnImpl: impl,
      trustState: 'trusted',
    });
    await runner.run('PreToolUse', baseInput);
    expect(trustCalls).toEqual(['/ws/demo']);
  });
});

describe('执行准入（BI-06.8 opaque/dangerous，fail-closed）', () => {
  test('opaque 脚本（eval）拒绝执行', async () => {
    const { impl, calls } = stubSpawn(() => ({}));
    const { runner } = harness({
      hooks: [{ event: 'PreToolUse', command: "eval 'echo hi'" }],
      spawnImpl: impl,
      scanShellImpl: scanShell,
    });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(calls.length).toBe(0);
    expect(outcome.action).toBe('allow');
    expect(outcome.records[0]!.status).toBe('skipped-opaque');
    expect(outcome.records[0]!.reason).toContain('opaque');
  });

  test('dangerous 脚本（rm -rf /）同样拒绝执行', async () => {
    const { impl, calls } = stubSpawn(() => ({}));
    const { runner } = harness({
      hooks: [{ event: 'PreFileWrite', command: 'rm -rf /' }],
      spawnImpl: impl,
      scanShellImpl: scanShell,
    });
    const outcome = await runner.run('PreFileWrite', baseInput);
    expect(calls.length).toBe(0);
    expect(outcome.records[0]!.status).toBe('skipped-opaque');
    expect(outcome.records[0]!.reason).toContain('dangerous');
  });

  test('可分析的脚本正常进入 spawn（真实 scanShell 放行 ls -la）', async () => {
    const { impl, calls } = stubSpawn(() => ({ stdout: jsonLine({ action: 'allow' }) }));
    const { runner } = harness({
      hooks: [{ event: 'PreToolUse', command: 'ls -la' }],
      spawnImpl: impl,
      scanShellImpl: scanShell,
    });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(calls.length).toBe(1);
    expect(outcome.ran).toBe(1);
    expect(outcome.action).toBe('allow');
  });
});

describe('执行面（fail-open）', () => {
  test('allow 决策：全部执行并放行', async () => {
    const { impl, calls } = stubSpawn(() => ({ stdout: jsonLine({ action: 'allow' }) }));
    const { runner } = harness({
      hooks: [
        { event: 'PreToolUse', command: 'a.sh' },
        { event: 'PreToolUse', command: 'b.sh' },
      ],
      spawnImpl: impl,
    });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.action).toBe('allow');
    expect(outcome.ran).toBe(2);
    expect(outcome.records.map((r) => r.status)).toEqual(['ran', 'ran']);
    expect(outcome.records.map((r) => r.decision)).toEqual(['allow', 'allow']);
    expect(outcome.records.every((r) => r.blocked === false)).toBe(true);
    expect(calls.length).toBe(2);
  });

  test('显式 block 短路：后续钩子不执行，返回 reason 与 hookId', async () => {
    const { impl, calls } = stubSpawn((_call, index) => ({
      stdout:
        index === 1
          ? jsonLine({ action: 'block', reason: 'policy: no git push --force' })
          : jsonLine({ action: 'allow' }),
    }));
    const { runner } = harness({
      hooks: [
        { event: 'PreToolUse', command: 'allow.sh' },
        { event: 'PreToolUse', command: 'block.sh' },
        { event: 'PreToolUse', command: 'tail.sh' },
      ],
      spawnImpl: impl,
    });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.action).toBe('block');
    expect(outcome.reason).toBe('policy: no git push --force');
    expect(outcome.hookId).toBe('hooks[1]');
    expect(outcome.ran).toBe(2);
    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.command)).toEqual(['allow.sh', 'block.sh']);
    expect(outcome.records[1]!.blocked).toBe(true);
    expect(outcome.records[1]!.decision).toBe('block');
  });

  test('非零退出：失败不阻断，后续钩子继续', async () => {
    const { impl, calls } = stubSpawn((_call, index) =>
      index === 0 ? { code: 7 } : { stdout: jsonLine({ action: 'allow' }) },
    );
    const { runner } = harness({
      hooks: [
        { event: 'PreToolUse', command: 'failing.sh' },
        { event: 'PreToolUse', command: 'after.sh' },
      ],
      spawnImpl: impl,
    });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.action).toBe('allow');
    expect(outcome.ran).toBe(2);
    expect(calls.length).toBe(2);
    expect(outcome.records[0]!.status).toBe('crash');
    expect(outcome.records[0]!.exitCode).toBe(7);
    expect(outcome.records[0]!.reason).toBe('non-zero-exit: 7');
    expect(outcome.records[1]!.status).toBe('ran');
  });

  test('超时：结构化 hook-timeout，不阻断，后续钩子继续', async () => {
    const { impl, calls } = stubSpawn((_call, index) =>
      index === 0
        ? { timedOut: true, code: null, signal: 'SIGKILL' }
        : { stdout: jsonLine({ action: 'allow' }) },
    );
    const { runner } = harness({
      hooks: [
        { event: 'PreToolUse', command: 'slow.sh' },
        { event: 'PreToolUse', command: 'after.sh' },
      ],
      spawnImpl: impl,
    });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.action).toBe('allow');
    expect(outcome.ran).toBe(2);
    expect(calls.length).toBe(2);
    expect(outcome.records[0]!.status).toBe('timeout');
    expect(outcome.records[0]!.timedOut).toBe(true);
    expect(outcome.records[0]!.reason).toBe('hook-timeout');
    expect(outcome.records[0]!.exitCode).toBeNull();
    expect(outcome.records[1]!.status).toBe('ran');
  });

  test('坏 JSON 末行：放行 + 告警记录，后续钩子继续', async () => {
    const { impl, calls } = stubSpawn((_call, index) =>
      index === 0 ? { stdout: 'this is not json\n' } : { stdout: jsonLine({ action: 'allow' }) },
    );
    const { runner } = harness({
      hooks: [
        { event: 'PreToolUse', command: 'broken.sh' },
        { event: 'PreToolUse', command: 'after.sh' },
      ],
      spawnImpl: impl,
    });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.action).toBe('allow');
    expect(outcome.ran).toBe(2);
    expect(outcome.records[0]!.status).toBe('bad-output');
    expect(outcome.records[0]!.warning).toContain('json-parse-failed');
    expect(outcome.records[0]!.warning).toContain('fail-open');
    expect(outcome.records[1]!.status).toBe('ran');
  });

  test('空 stdout：bad-output 放行', async () => {
    const { impl } = stubSpawn(() => ({ stdout: '' }));
    const { runner } = harness({ hooks: [{ event: 'PreToolUse', command: 'silent.sh' }], spawnImpl: impl });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.action).toBe('allow');
    expect(outcome.records[0]!.status).toBe('bad-output');
    expect(outcome.records[0]!.warning).toContain('empty-stdout');
  });

  test('纯空白 stdout：bad-output 放行', async () => {
    const { impl } = stubSpawn(() => ({ stdout: '  \n  \n' }));
    const { runner } = harness({ hooks: [{ event: 'PreToolUse', command: 'blank.sh' }], spawnImpl: impl });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.records[0]!.status).toBe('bad-output');
  });

  test('非法 action（deny 不在协议内）：bad-output 放行', async () => {
    const { impl } = stubSpawn(() => ({ stdout: jsonLine({ action: 'deny' }) }));
    const { runner } = harness({ hooks: [{ event: 'PreToolUse', command: 'x.sh' }], spawnImpl: impl });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.action).toBe('allow');
    expect(outcome.records[0]!.status).toBe('bad-output');
    expect(outcome.records[0]!.warning).toContain('invalid-action');
  });

  test('JSON 标量（非对象）：bad-output 放行', async () => {
    const { impl } = stubSpawn(() => ({ stdout: '"ok"\n' }));
    const { runner } = harness({ hooks: [{ event: 'PreToolUse', command: 'x.sh' }], spawnImpl: impl });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.records[0]!.status).toBe('bad-output');
    expect(outcome.records[0]!.warning).toContain('not-a-json-object');
  });

  test('JSON 数组（非对象）：bad-output 放行', async () => {
    const { impl } = stubSpawn(() => ({ stdout: '[1,2]\n' }));
    const { runner } = harness({ hooks: [{ event: 'PreToolUse', command: 'x.sh' }], spawnImpl: impl });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.records[0]!.status).toBe('bad-output');
  });

  test('spawnImpl 违约抛异常：折叠为 crash，不阻断', async () => {
    const impl: HookSpawnImpl = async () => {
      throw new Error('stub exploded');
    };
    const { runner } = harness({ hooks: [{ event: 'PreToolUse', command: 'x.sh' }], spawnImpl: impl });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.action).toBe('allow');
    expect(outcome.ran).toBe(0);
    expect(outcome.records[0]!.status).toBe('crash');
    expect(outcome.records[0]!.reason).toContain('spawn-threw');
    expect(outcome.records[0]!.reason).toContain('stub exploded');
  });

  test('spawn 失败（error 字段，如 ENOENT）：crash 记录，不阻断', async () => {
    const { impl } = stubSpawn(() => ({ code: null, error: 'spawn ENOENT' }));
    const { runner } = harness({ hooks: [{ event: 'PreToolUse', command: 'missing.sh' }], spawnImpl: impl });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.action).toBe('allow');
    expect(outcome.ran).toBe(1);
    expect(outcome.records[0]!.status).toBe('crash');
    expect(outcome.records[0]!.reason).toBe('spawn-error: spawn ENOENT');
  });

  test('ask 决策：不阻断（上层权限扩展点），记录决策', async () => {
    const { impl } = stubSpawn(() => ({ stdout: jsonLine({ action: 'ask', reason: 'unsure' }) }));
    const { runner } = harness({ hooks: [{ event: 'PermissionRequest', command: 'ask.sh' }], spawnImpl: impl });
    const outcome = await runner.run('PermissionRequest', baseInput);
    expect(outcome.action).toBe('allow');
    expect(outcome.records[0]!.status).toBe('ran');
    expect(outcome.records[0]!.decision).toBe('ask');
    expect(outcome.records[0]!.blocked).toBe(false);
  });
});

describe('blocking 语义', () => {
  test('blocking=false：block 决策降级为咨询记录，不阻断，后续继续', async () => {
    const { impl, calls } = stubSpawn((call) =>
      call.command === 'advisor.sh'
        ? { stdout: jsonLine({ action: 'block', reason: 'just advice' }) }
        : { stdout: jsonLine({ action: 'allow' }) },
    );
    const { runner } = harness({
      hooks: [
        { event: 'PreToolUse', command: 'advisor.sh', blocking: false },
        { event: 'PreToolUse', command: 'after.sh' },
      ],
      spawnImpl: impl,
    });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.action).toBe('allow');
    expect(outcome.ran).toBe(2);
    expect(calls.length).toBe(2);
    expect(outcome.records[0]!.decision).toBe('block');
    expect(outcome.records[0]!.blocked).toBe(false);
    expect(outcome.records[0]!.warning).toContain('advisory-block-ignored');
    expect(outcome.records[1]!.status).toBe('ran');
  });

  test('blocking 缺省 = true：block 决策阻断', async () => {
    const { impl } = stubSpawn(() => ({ stdout: jsonLine({ action: 'block', reason: 'default blocking' }) }));
    const { runner } = harness({
      hooks: [{ event: 'PreBash', command: 'gate.sh' }],
      spawnImpl: impl,
    });
    const outcome = await runner.run('PreBash', baseInput);
    expect(outcome.action).toBe('block');
    expect(outcome.reason).toBe('default blocking');
    expect(outcome.records[0]!.blocked).toBe(true);
  });
});

describe('参数与协议透传', () => {
  test('timeoutMs 缺省传 DEFAULT_HOOK_TIMEOUT_MS，显式值原样透传', async () => {
    const { impl, calls } = stubSpawn(() => ({ stdout: jsonLine({ action: 'allow' }) }));
    const { runner } = harness({
      hooks: [
        { event: 'PreToolUse', command: 'default-timeout.sh' },
        { event: 'PreToolUse', command: 'custom-timeout.sh', timeoutMs: 123 },
      ],
      spawnImpl: impl,
    });
    await runner.run('PreToolUse', baseInput);
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(10_000);
    expect(calls[0]!.timeoutMs).toBe(10_000);
    expect(calls[1]!.timeoutMs).toBe(123);
  });

  test('spawn cwd = input.cwd', async () => {
    const { impl, calls } = stubSpawn(() => ({ stdout: jsonLine({ action: 'allow' }) }));
    const { runner } = harness({ hooks: [{ event: 'PreToolUse', command: 'x.sh' }], spawnImpl: impl });
    await runner.run('PreToolUse', baseInput);
    expect(calls[0]!.cwd).toBe('/ws/demo');
  });

  test('注入 clock 驱动 durationMs 统计', async () => {
    const ticks = [0, 10, 100, 130];
    let cursor = 0;
    const clock = (): number => {
      const value = ticks[cursor];
      cursor += 1;
      return value ?? 999;
    };
    const { impl } = stubSpawn(() => ({ stdout: jsonLine({ action: 'allow' }) }));
    const { runner } = harness({
      hooks: [
        { event: 'PreToolUse', command: 'a.sh' },
        { event: 'PreToolUse', command: 'b.sh' },
      ],
      spawnImpl: impl,
      clock,
    });
    const outcome = await runner.run('PreToolUse', baseInput);
    expect(outcome.records[0]!.durationMs).toBe(10);
    expect(outcome.records[1]!.durationMs).toBe(30);
  });

  test('parseHookOutput：末行取值 / 空白 / reason 类型收敛', () => {
    expect(parseHookOutput('{"action":"allow"}\n')).toEqual({ ok: true, output: { action: 'allow' } });
    expect(parseHookOutput('noise\n{"action":"block","reason":"r"}\n')).toEqual({
      ok: true,
      output: { action: 'block', reason: 'r' },
    });
    expect(parseHookOutput('\r\n{"action":"ask"}\r\n')).toEqual({ ok: true, output: { action: 'ask' } });
    expect(parseHookOutput('{"action":"allow","reason":123}')).toEqual({
      ok: true,
      output: { action: 'allow' },
    });
    expect(parseHookOutput('   ')).toEqual({ ok: false, error: 'empty-stdout' });
    expect(parseHookOutput('nope').ok).toBe(false);
  });
});

describe('缺省 spawn 集成（真实子进程）', () => {
  const realCwd = process.cwd();

  test('真实 echo block JSON → 阻断', async () => {
    const { runner } = harness({
      hooks: [{ event: 'PreToolUse', command: `echo '{"action":"block","reason":"deny-all"}'` }],
      scanShellImpl: scanShell,
    });
    const outcome = await runner.run('PreToolUse', { ...baseInput, cwd: realCwd });
    expect(outcome.action).toBe('block');
    expect(outcome.reason).toBe('deny-all');
    expect(outcome.ran).toBe(1);
  });

  test('真实多行 stdout：噪声行 + 末行 JSON → 正常解析', async () => {
    const { runner } = harness({
      hooks: [
        {
          event: 'PreToolUse',
          command: `echo noise; echo '{"action":"block","reason":"late-verdict"}'`,
        },
      ],
      scanShellImpl: scanShell,
    });
    const outcome = await runner.run('PreToolUse', { ...baseInput, cwd: realCwd });
    expect(outcome.action).toBe('block');
    expect(outcome.reason).toBe('late-verdict');
  });

  test('真实超时（sleep 5 + 120ms 上限）→ hook-timeout 放行', async () => {
    const { runner } = harness({
      hooks: [{ event: 'PreToolUse', command: 'sleep 5', timeoutMs: 120 }],
      scanShellImpl: scanShell,
    });
    const outcome = await runner.run('PreToolUse', { ...baseInput, cwd: realCwd });
    expect(outcome.action).toBe('allow');
    expect(outcome.records[0]!.status).toBe('timeout');
    expect(outcome.records[0]!.reason).toBe('hook-timeout');
    expect(outcome.records[0]!.timedOut).toBe(true);
  });

  test('真实非零退出（exit 3）→ crash 放行', async () => {
    const { runner } = harness({
      hooks: [{ event: 'PreToolUse', command: 'exit 3' }],
      scanShellImpl: scanShell,
    });
    const outcome = await runner.run('PreToolUse', { ...baseInput, cwd: realCwd });
    expect(outcome.action).toBe('allow');
    expect(outcome.records[0]!.status).toBe('crash');
    expect(outcome.records[0]!.exitCode).toBe(3);
  });

  test('真实 stdin 透传：cat 回显 HookInput → 末行非 HookOutput → bad-output 放行', async () => {
    const { runner } = harness({
      hooks: [{ event: 'PreToolUse', command: 'cat' }],
      scanShellImpl: scanShell,
    });
    const outcome = await runner.run('PreToolUse', { ...baseInput, cwd: realCwd });
    expect(outcome.action).toBe('allow');
    expect(outcome.records[0]!.status).toBe('bad-output');
    expect(outcome.records[0]!.warning).toContain('invalid-action');
  });
});
