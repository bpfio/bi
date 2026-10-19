/**
 * BI-29.1 —— /doctor 全链路体检(bi 自有面)。
 *
 * 五个检查项(配置装载 / 凭据门 / 所配 provider 网络 / 沙箱探针 / 工具注册面)全部走
 * 注入式探测端口,逐项产出 {name, ok, detail, fix?};测试离屏注入假端口,零真实 IO 依赖。
 *
 * BI-29.1 去母体化:
 * - 网络探测端点不再硬编码 open.bigmodel.cn,一律取自所配 provider 的 base_url
 *   (配置装载 → resolveModelPort 同一装配链,母体 zhipu 环境变量面退役);
 * - 凭据门 = BI-23.3 装配链原语(api_key_env → 环境变量,永不落盘、永不入日志),
 *   缺失时结构化报错携带修复指引;
 * - Python/pandas 母体遗产检查移除,换成沙箱探针(BI-06.10 OsSandbox 真探)与
 *   工具注册面体检(buildDefaultToolset 结构性核验);
 * - 配置装载 / 凭据门 / 网络探测共享一次装配(级联语义:前序未过,后序明确级联失败)。
 *
 * runDoctor 汇总为 DoctorReport(allOk + 逐项),formatDoctorReport 输出终端友好文本。
 */

import { existsSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import { ConfigService } from './config/config-service';
import type { BiConfig } from './config/schema';
import { ModelPortConfigError, resolveModelPort, type ModelSelection } from './cli/model-port';
import { buildDefaultToolset } from './cli/toolset';
import { OsSandbox } from './sandbox/os-sandbox';

// ---------------------------------------------------------------------------
// 端口与结果类型
// ---------------------------------------------------------------------------

export interface DoctorCheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** ok=false 时的修复建议 */
  fix?: string;
}

export type DoctorCheck = () => Promise<DoctorCheckResult> | DoctorCheckResult;

export interface ProbeOutcome {
  reachable: boolean;
  detail: string;
}

/** 沙箱探针汇总(缺省实现 = OsSandbox 真探的降维投影)。 */
export interface SandboxProbeSummary {
  available: boolean;
  detail: string;
}

/** 工具注册面探针汇总(缺省实现 = buildDefaultToolset 结构性核验)。 */
export interface ToolsetProbeSummary {
  ok: boolean;
  detail: string;
}

export interface DoctorPorts {
  /** 环境变量源(凭据门 api_key_env 解析;缺省 process.env,测试注入) */
  env: Record<string, string | undefined>;
  /** bi 主目录覆盖(ConfigService 注入;缺省 os.homedir(),测试必须注入临时目录) */
  homeDir?: string;
  /** 工作目录覆盖(local.toml 定位与工具集探针 cwd;缺省 process.cwd()) */
  workDir?: string;
  /** 网络探测超时(ms),缺省 3000 */
  timeoutMs: number;
  /** 仅 DNS/TCP 语义的可达性探测(不发业务请求) */
  probeNetwork: (url: string, timeoutMs: number) => Promise<ProbeOutcome>;
  /** 沙箱探针端口(缺省 OsSandbox 真探) */
  probeSandbox: () => Promise<SandboxProbeSummary> | SandboxProbeSummary;
  /** 工具注册面探针端口(缺省 buildDefaultToolset 结构性核验) */
  probeToolset: () => ToolsetProbeSummary | Promise<ToolsetProbeSummary>;
}

export const DOCTOR_CHECK_NAMES = {
  config: '配置装载',
  credentials: '凭据门',
  network: '所配 provider 网络',
  sandbox: '沙箱探针',
  tools: '工具注册面',
} as const;

// ---------------------------------------------------------------------------
// 缺省端口实现(真实 IO;测试一律注入假端口,不走到这里)
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** DNS 解析 + TCP 连通,语义仅到传输层,不发 HTTP */
async function defaultProbeNetwork(url: string, timeoutMs: number): Promise<ProbeOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reachable: false, detail: `无效端点 URL: ${url}` };
  }
  const host = parsed.hostname;
  const port = parsed.port !== '' ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443;
  let address: string;
  try {
    const resolved = await withTimeout(lookup(host), timeoutMs, `DNS 解析超时: ${host}`);
    address = typeof resolved === 'string' ? resolved : resolved.address;
  } catch (e) {
    return { reachable: false, detail: e instanceof Error ? e.message : String(e) };
  }
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const socket = connect({ host: address, port });
        const done = (err?: Error): void => {
          socket.destroy();
          if (err) reject(err);
          else resolve();
        };
        socket.once('connect', () => done());
        socket.once('error', (err: Error) => done(err));
      }),
      timeoutMs,
      `TCP 连接超时: ${address}:${port}`,
    );
    return { reachable: true, detail: `${host} (${address}:${port}) DNS/TCP 可达` };
  } catch (e) {
    return { reachable: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** 缺省沙箱探针:OsSandbox 真探(landlock 实创 ruleset / bwrap 功能探针)。 */
async function defaultProbeSandbox(): Promise<SandboxProbeSummary> {
  const probe = await new OsSandbox().probe();
  if (probe.available) {
    const preferred = probe.backends.find((b) => b.backend === probe.preferred);
    return {
      available: true,
      detail: `沙箱后端可用: ${probe.preferred} (${preferred?.detail ?? 'ok'})`,
    };
  }
  const lines = probe.backends.map((b) => `${b.backend}: ${b.detail}`).join('; ');
  return { available: false, detail: `无可用沙箱后端 — ${lines}` };
}

/** 缺省工具注册面探针:装配真实工具集,核验命名/描述唯一性与非空。 */
function defaultProbeToolset(workDir: string): ToolsetProbeSummary {
  const bindings = buildDefaultToolset(workDir);
  if (bindings.length === 0) {
    return { ok: false, detail: '工具集为空:buildDefaultToolset 未注册任何工具' };
  }
  const names: string[] = [];
  for (const binding of bindings) {
    const name = binding.definition.name;
    if (typeof name !== 'string' || name === '') {
      return { ok: false, detail: '存在无名工具绑定' };
    }
    if (names.includes(name)) {
      return { ok: false, detail: `工具重名: ${name}` };
    }
    const description = binding.definition.description;
    if (typeof description !== 'string' || description === '') {
      return { ok: false, detail: `工具 ${name} 缺 description` };
    }
    names.push(name);
  }
  return { ok: true, detail: `${bindings.length} 个工具注册: ${names.join(', ')}` };
}

export function buildDefaultPorts(overrides: Partial<DoctorPorts> = {}): DoctorPorts {
  const workDir = overrides.workDir ?? process.cwd();
  return {
    env: overrides.env ?? process.env,
    ...(overrides.homeDir !== undefined ? { homeDir: overrides.homeDir } : {}),
    ...(overrides.workDir !== undefined ? { workDir: overrides.workDir } : {}),
    timeoutMs: overrides.timeoutMs ?? 3000,
    probeNetwork: overrides.probeNetwork ?? defaultProbeNetwork,
    probeSandbox: overrides.probeSandbox ?? defaultProbeSandbox,
    probeToolset: overrides.probeToolset ?? (() => defaultProbeToolset(workDir)),
  };
}

// ---------------------------------------------------------------------------
// bi 自有面装配(配置装载 → 凭据门 → 端点解析;前序结果被后续检查项级联消费)
// ---------------------------------------------------------------------------

type BiFaceAssembly =
  | { kind: 'ok'; config: BiConfig; selection: ModelSelection }
  | { kind: 'config-fail'; detail: string; fix: string }
  /** 配置本身装载成功,仅凭据门未过(配置装载检查项仍按 ok 汇报) */
  | { kind: 'credential-fail'; config: BiConfig; detail: string };

async function assembleBiFace(ports: DoctorPorts): Promise<BiFaceAssembly> {
  try {
    const service = new ConfigService({
      env: ports.env,
      ...(ports.homeDir !== undefined ? { homeDir: ports.homeDir } : {}),
      ...(ports.workDir !== undefined ? { workDir: ports.workDir } : {}),
    });
    if (!existsSync(service.paths.globalConfig)) {
      return {
        kind: 'config-fail',
        detail: `配置文件不存在: ${service.paths.globalConfig}`,
        fix: '运行 bi init 生成配置骨架,或手写最小 config.toml(providers/models 两段)',
      };
    }
    const config = await service.load();
    const issues = service.issues;
    if (issues.length > 0) {
      const first = issues[0]!;
      const where = first.path === '' ? '根级' : first.path;
      return {
        kind: 'config-fail',
        detail: `配置装载诊断 ${issues.length} 条(首条: ${where} — ${first.message})`,
        fix: '按诊断修正 config.toml 对应键(类型回退/未知键都会改变运行行为)',
      };
    }
    let selection: ModelSelection;
    try {
      selection = resolveModelPort(config, { env: ports.env });
    } catch (e) {
      if (e instanceof ModelPortConfigError) {
        return { kind: 'credential-fail', config, detail: e.message };
      }
      throw e;
    }
    return { kind: 'ok', config, selection };
  } catch (e) {
    return {
      kind: 'config-fail',
      detail: e instanceof Error ? e.message : String(e),
      fix: '检查 ~/.bi/config.toml 语法与结构(TOML 解析失败 / 语义校验失败)',
    };
  }
}

// ---------------------------------------------------------------------------
// 检查项组装
// ---------------------------------------------------------------------------

/** 由端口装配五个缺省检查项(配置装载一次,凭据门/网络级联复用) */
export function buildDefaultChecks(ports: DoctorPorts): DoctorCheck[] {
  let cached: Promise<BiFaceAssembly> | undefined;
  const assembly = (): Promise<BiFaceAssembly> => {
    if (cached === undefined) cached = assembleBiFace(ports);
    return cached;
  };

  return [
    // 1. 配置装载(config.toml 存在性 + TOML/校验诊断 + 模型装配摘要)
    async () => {
      const a = await assembly();
      if (a.kind === 'config-fail') {
        return { name: DOCTOR_CHECK_NAMES.config, ok: false, detail: a.detail, fix: a.fix };
      }
      const providers = Object.keys(a.config.providers.entries).length;
      const models = Object.keys(a.config.models.entries).length;
      const summary =
        a.kind === 'ok'
          ? `,默认模型 ${a.selection.modelId}(provider ${a.selection.providerName},${a.selection.mode} 协议)`
          : '';
      return {
        name: DOCTOR_CHECK_NAMES.config,
        ok: true,
        detail: `config.toml 已装载: ${providers} provider / ${models} model${summary}`,
      };
    },
    // 2. 凭据门(api_key_env → 环境变量,与 BI-23.3 装配链同一原语)
    async () => {
      const a = await assembly();
      if (a.kind === 'config-fail') {
        return {
          name: DOCTOR_CHECK_NAMES.credentials,
          ok: false,
          detail: '配置装载未过,凭据门未探测',
          fix: '先解决「配置装载」检查项',
        };
      }
      if (a.kind === 'credential-fail') {
        return {
          name: DOCTOR_CHECK_NAMES.credentials,
          ok: false,
          detail: a.detail,
          fix: '密钥只经环境变量:导出对应 api_key_env 后重试(配置文件永不落明文密钥)',
        };
      }
      const envName =
        a.config.providers.entries[a.selection.providerName]?.api_key_env ?? '';
      const credFace = envName === '' ? '无静态 Key(OAuth/本地端点形态)' : `api_key_env=${envName} 已在位`;
      return {
        name: DOCTOR_CHECK_NAMES.credentials,
        ok: true,
        detail: `provider "${a.selection.providerName}" 凭据已解析(${credFace})`,
      };
    },
    // 3. 所配 provider 网络(base_url 来自所配 provider,仅 DNS/TCP 语义)
    async () => {
      const a = await assembly();
      if (a.kind !== 'ok') {
        return {
          name: DOCTOR_CHECK_NAMES.network,
          ok: false,
          detail: '配置未就绪,无法解析 provider 端点',
          fix: '先解决「配置装载」「凭据门」检查项',
        };
      }
      const r = await ports.probeNetwork(a.selection.baseUrl, ports.timeoutMs);
      return r.reachable
        ? { name: DOCTOR_CHECK_NAMES.network, ok: true, detail: r.detail }
        : {
            name: DOCTOR_CHECK_NAMES.network,
            ok: false,
            detail: r.detail,
            fix: `检查本机网络/代理,或核对 config.toml 中 provider base_url (${a.selection.baseUrl})`,
          };
    },
    // 4. 沙箱探针(landlock/bwrap/seatbelt 真探;至少一个后端可用即过)
    async () => {
      const r = await ports.probeSandbox();
      return r.available
        ? { name: DOCTOR_CHECK_NAMES.sandbox, ok: true, detail: r.detail }
        : {
            name: DOCTOR_CHECK_NAMES.sandbox,
            ok: false,
            detail: r.detail,
            fix: '安装 bubblewrap 或升级内核以启用 landlock;沙箱策略可在 config 中调整',
          };
    },
    // 5. 工具注册面(buildDefaultToolset 装配核验:非空/唯一命名/描述齐全)
    async () => {
      const r = await ports.probeToolset();
      return r.ok
        ? { name: DOCTOR_CHECK_NAMES.tools, ok: true, detail: r.detail }
        : {
            name: DOCTOR_CHECK_NAMES.tools,
            ok: false,
            detail: r.detail,
            fix: '检查 toolset 装配层(工具重名/缺描述会使模型侧工具面失真)',
          };
    },
  ];
}

// ---------------------------------------------------------------------------
// 汇总与格式化
// ---------------------------------------------------------------------------

export interface DoctorReport {
  allOk: boolean;
  checks: DoctorCheckResult[];
}

export interface DoctorDeps {
  /** 全量注入检查项数组(优先于 ports 装配) */
  checks?: readonly DoctorCheck[];
  /** 注入/覆盖部分端口,未覆盖项用缺省实现 */
  ports?: Partial<DoctorPorts>;
}

/** 逐项执行检查;单项抛错被捕获为 fail,绝不拖垮整份体检 */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const ports = buildDefaultPorts(deps.ports);
  const checks = deps.checks ?? buildDefaultChecks(ports);
  const results: DoctorCheckResult[] = [];
  for (const check of checks) {
    try {
      results.push(await check());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        name: check.name || '体检项',
        ok: false,
        detail: `探测异常: ${msg}`,
        fix: '重试或查看 bi doctor 日志定位端口实现',
      });
    }
  }
  return { allOk: results.length > 0 && results.every((r) => r.ok), checks: results };
}

/** 终端友好文本:✓/✗ 逐项 + 修复建议缩进 + 汇总行 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ['BI Doctor 体检报告', '──────────────────'];
  for (const c of report.checks) {
    lines.push(`${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
    if (!c.ok && c.fix) lines.push(`    修复建议: ${c.fix}`);
  }
  const passed = report.checks.filter((c) => c.ok).length;
  lines.push(
    report.allOk
      ? `汇总: ${passed}/${report.checks.length} 通过 — 全部健康`
      : `汇总: ${passed}/${report.checks.length} 通过 — 存在异常,请按修复建议处理`,
  );
  return lines.join('\n');
}
