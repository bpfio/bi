/**
 * 缺省工具注册表面：buildDefaultToolset(cwd, options?) → ToolBinding[]。
 *
 * 职责边界（装配层只包装，器官零改动；ToolBinding 合约见 cli/headless.ts）：
 * - read_file：参考 cli/headless.test.ts readFileSyncBinding 形状（resolve + 逃逸
 *   守卫 + Bun.file 读文本）。守卫边界较参考形状收紧一档：路径段级前缀
 *   （root + sep），兄弟目录同前缀（/w → /w2）不再漏放。
 * - web_fetch：挂 BI-07.15 fetchWebPage（手动重定向/超时预算/字节上限/结构化
 *   WebFetchError 全在器官内）；readOnly:true = 无文件写语义。
 * - web_search：挂 BI-07.15 webSearch + DeepSeekSearchProvider（唯一已装配
 *   ProviderPort）。密钥走 api_key_env 同款间接引用语义：执行时读环境变量
 *   （缺省 DEEPSEEK_API_KEY），未设置 = 结构化报错，绝不假冒结果。
 * - bash（BI-28.1）：spawn(["bash","-c",command])，cwd=工具集根，stdin:"ignore"；
 *   默认超时 60_000ms，超时 kill 并标注 timedOut；stdout+stderr 合并，仅保留
 *   末尾 100KB（头部截断加标记行）；返回 JSON {exitCode, output, timedOut?,
 *   truncated?}；exitCode 非 0 不抛错（命令失败是正常工具结果）。spawn 经
 *   options.spawnImpl 注入（缺省真实 Bun.spawn；测试全走注入替身，零实弹）。
 * - edit / write（BI-28.2）：路径守卫 →（edit: 唯一性替换）→ atomicWriteFile
 *   原子写（utils/atomic-write.ts，同目录临时文件 + rename）。edit 的
 *   old_string 0 命中、或 >1 命中且未 replace_all = 结构化报错（报匹配数）；
 *   write 允许新建文件，父目录必须已存在。edit/write 的守卫在读写之前执行
 *   （较工单顺序更紧一档：根外路径一律 path-escape，绝不读入其内容）。
 * - glob / grep（BI-28.5）：只读两件。glob = Bun.Glob 扫描（零依赖；--embed rg
 *   面维持缓议，本卡不接，见 globBinding 注释）。grep = 递归正则扫描：跳过
 *   node_modules/隐藏条目（.git/.bi 等点开头目录与文件）、二进制文件（NUL
 *   启发式）、超 1MB 单文件；命中 200 条封顶 + 输出超 10KB 保留尾部（与 bash
 *   截断风格一致）。两件都走 assertInsideRoot + PathJail read 裁决；grep 再
 *   逐文件过 PathJail read（凭据文件名/工作区 .env 不入扫描结果，防内容外泄，
 *   与器官读语义一致）。
 * - 信号透传：web 两器官自身不带 AbortSignal，绑定层 withSignal 竞出 abort
 *   （中止即 reject，绝不悬挂）；bash 自带 abort 竞出（先 kill 子进程再
 *   reject）；edit/write 的 fs 段走 withSignal；read_file 同步读无需透传。
 *
 * 安全接线（BI-28.1/28.2 探明结论与边界备案）：
 * - shell-scan（src/sandbox/shell-scan.ts，注意在 sandbox/ 非 guard/）：bash 的
 *   argSummary 经 scanShell 纯函数分类，dangerous/opaque 时在命令摘要尾部追加
 *   `[shell-scan:…]` 标注（审批浮层可见；不阻断执行，manual 态 ask 由门禁出）。
 *   标注为后缀形态：前缀锚定的权限规则（如 `Bash(git *)`）不受影响；带标注的
 *   参数串会话记忆键与无标注串不同（dangerous 请求须单独裁决，属期望语义）。
 * - os-sandbox（src/sandbox/os-sandbox.ts）：landlock/bwrap/seatbelt 探针与
 *   OsSandbox 包装属重量级运行时装配（probe + 平台后端选择），本卡不接线；
 *   子进程沙箱 e2e 归 BI-28.4（工单允许的成本备案，不阻塞）。
 * - PathJail（src/sandbox/path-jail.ts）：edit/write 在段级前缀逃逸守卫之外，
 *   接入 checkPath(abs,"write") 第二层（家目录保护清单 / 工作区 .env / 凭据
 *   文件名 / 工作区外写拦）。bash 不接 PathJail——它是路径级器官，命令词级
 *   路径策略（checkScan 组合裁决）归 BI-28.4 评估。
 * - 原子写：复用 utils/atomic-write.ts atomicWriteFile（零新造轮子）。
 * - tools/bash.ts 已有更重的 runBash 器官（进程组击杀/环形缓冲/cwd 标记帧），
 *   本卡按工单规格在绑定层直实现；与 runBash 的合流归 BI-28.4 评估。
 *
 * 执行测试零外呼零实弹：fetch 经 BuildDefaultToolsetOptions.fetchImpl 注入
 * 替身；bash 经 BuildDefaultToolsetOptions.spawnImpl 注入替身（绝不真实执行
 * 命令）；fs 用临时目录。
 */

import { readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readdir } from "node:fs/promises";
import type { ToolBinding } from "./headless";
import { fetchWebPage, type FetchExecutor } from "../tools/web-fetch";
import {
	webSearch,
	TokenBucketRateLimiter,
	TtlResultCache,
	DEFAULT_SEARCH_RPS,
} from "../tools/web-search";
import { DeepSeekSearchProvider } from "../tools/search-providers/deepseek-search";
import { scanShell } from "../sandbox/shell-scan";
import { PathJail } from "../sandbox/path-jail";
import { atomicWriteFile } from "../utils/atomic-write";

// ---------------------------------------------------------------------------
// 公共面
// ---------------------------------------------------------------------------

/** web_search 密钥缺省环境变量名（api_key_env 间接引用语义）。 */
export const DEFAULT_SEARCH_API_KEY_ENV = "DEEPSEEK_API_KEY";

/** bash 子进程结构最小面（Bun.spawn 返回值的结构子集；测试注入替身用）。 */
export interface SpawnedProcess {
	/** 进程退出码（kill 后照常落定，如 SIGKILL → 137）。 */
	readonly exited: Promise<number>;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	/** 超时/中止路径的击杀入口（缺省实现发 SIGKILL）。 */
	kill(): void;
}

/** bash spawn 选项（绑定层所需的最小面）。 */
export interface BashSpawnOptions {
	readonly cwd: string;
	readonly stdin: "ignore";
	readonly stdout: "pipe";
	readonly stderr: "pipe";
}

/** spawn 注入面：bash 工具离屏测试的唯一出口（缺省真实 Bun.spawn）。 */
export type SpawnImpl = (cmd: readonly string[], options: BashSpawnOptions) => SpawnedProcess;

/** bash 默认超时（毫秒）。 */
export const DEFAULT_BASH_TOOL_TIMEOUT_MS = 60_000;
/** bash 输出保留末尾的字节上限（100KB，超出截头部并加标记行）。 */
export const BASH_OUTPUT_TAIL_LIMIT_BYTES = 100 * 1024;
/** bash argSummary 命令截断长度（权限门审计面）。 */
export const BASH_ARG_SUMMARY_MAX = 120;
/** bash 输出截断标记行（加在保留尾部之前）。 */
export const BASH_TRUNCATION_MARKER = "[bi] bash 输出超过 100KB，仅保留末尾 100KB（头部已截断）";

/** glob 结果条数上限（超出截断并标注 truncated；防巨型树拖垮上下文）。 */
export const GLOB_RESULT_LIMIT = 500;
/** grep 命中条数上限（超出截断并标注 truncated）。 */
export const GREP_MATCH_LIMIT = 200;
/** grep 输出保留末尾的字节上限（10KB，风格与 bash 尾部截断一致）。 */
export const GREP_OUTPUT_TAIL_LIMIT_BYTES = 10 * 1024;
/** grep 单文件参与扫描的大小上限（超过整文件跳过，防巨文件/伪装文本拖垮）。 */
export const GREP_FILE_SIZE_LIMIT_BYTES = 1024 * 1024;
/** grep 输出截断标记行（加在保留尾部之前）。 */
export const GREP_TRUNCATION_MARKER = "[bi] grep 输出超过 10KB，仅保留末尾 10KB（头部已截断）";

/** 缺省 spawn 实现：真实 Bun.spawn（测试绝不触达——全部经 spawnImpl 注入替身）。 */
const defaultSpawnImpl: SpawnImpl = (cmd, options) => {
	const proc = Bun.spawn([...cmd], { ...options });
	return {
		exited: proc.exited,
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		stderr: proc.stderr as ReadableStream<Uint8Array>,
		kill: () => proc.kill("SIGKILL"),
	};
};

/** buildDefaultToolset 选项（全部可选；主控接线只需 buildDefaultToolset(cwd)）。 */
export interface BuildDefaultToolsetOptions {
	/** 注入 fetch 执行器（web 两工具离屏执行测试用）；缺省全局 fetch。 */
	readonly fetchImpl?: FetchExecutor;
	/** web_search 密钥环境变量名；缺省 DEFAULT_SEARCH_API_KEY_ENV。 */
	readonly searchApiKeyEnv?: string;
	/** 环境变量源（密钥解析用）；缺省 process.env。 */
	readonly env?: Record<string, string | undefined>;
	/** 注入 spawn 执行器（bash 工具离屏测试用，零实弹）；缺省真实 Bun.spawn。 */
	readonly spawnImpl?: SpawnImpl;
}

/**
 * 缺省工具注册表面（BI-25.1 + BI-28.1/28.2 + BI-28.5）：read_file / web_fetch /
 * web_search / glob / grep（只读五件在前）+ bash / edit / write（写语义三件）。
 * 每个绑定 = definition（喂模型）+ readOnly + argSummary（截断摘要）+ execute
 * （真实器官调用，信号透传）。
 */
export function buildDefaultToolset(cwd: string, options: BuildDefaultToolsetOptions = {}): ToolBinding[] {
	const root = resolve(cwd);
	const fetchImpl: FetchExecutor = options.fetchImpl ?? ((input, init) => fetch(input, init));
	const env = options.env ?? process.env;
	const apiKeyEnv = options.searchApiKeyEnv ?? DEFAULT_SEARCH_API_KEY_ENV;
	const spawnImpl: SpawnImpl = options.spawnImpl ?? defaultSpawnImpl;
	// PathJail 裁决（edit/write 第二层写策略；glob/grep 读策略；home 取真实用户家目录）。
	const pathJail = new PathJail({ home: homedir(), workspaceRoot: root });
	// 会话级缓存/限速：随工具集实例隔离（默认全局单例会跨测试与跨会话串味）。
	const searchCache = new TtlResultCache();
	const searchLimiter = new TokenBucketRateLimiter(DEFAULT_SEARCH_RPS);
	return [
		readFileBinding(root),
		webFetchBinding(fetchImpl),
		webSearchBinding({ fetchImpl, env, apiKeyEnv, cache: searchCache, limiter: searchLimiter }),
		globBinding(root, pathJail),
		grepBinding(root, pathJail),
		bashBinding({ root, spawnImpl }),
		editBinding(root, pathJail),
		writeBinding(root, pathJail),
	];
}

// ---------------------------------------------------------------------------
// read_file —— 工作区文本读取（器官：Bun.file，绑定层守卫）
// ---------------------------------------------------------------------------

/**
 * cwd 逃逸守卫（read_file/edit/write 共用；边界为路径段级前缀 root+sep，
 * 兄弟目录同前缀（/w → /w2）不漏放）。edit/write 复用本函数后再过 PathJail。
 */
function assertInsideRoot(root: string, abs: string): void {
	if (abs !== root && !abs.startsWith(root + sep)) throw new Error("path-escape");
}

/**
 * edit/write 的写路径守卫：段级前缀逃逸守卫 + PathJail write 模式裁决。
 * 返回解析后的绝对路径（供读改写流水线使用）。
 */
function guardWritePath(root: string, jail: PathJail, rawPath: string): string {
	const abs = resolve(root, rawPath);
	assertInsideRoot(root, abs);
	const verdict = jail.checkPath(abs, "write");
	if (!verdict.allowed) throw new Error(`path-protected: ${verdict.reason ?? "protected"}`);
	return abs;
}

function readFileBinding(root: string): ToolBinding {
	return {
		definition: {
			name: "read_file",
			description: "读取工作区内文本文件（UTF-8）。超出了工作区根的路径一律拒绝。",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string", description: "相对工作区根的文件路径" } },
				required: ["path"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "path"),
		execute: async (args, signal) => {
			const path = takeStringArg(args, "path");
			const abs = resolve(root, path);
			assertInsideRoot(root, abs);
			return await withSignal(signal, () => Bun.file(abs).text());
		},
	};
}

// ---------------------------------------------------------------------------
// glob / grep —— 工作区只读检索（BI-28.5；路径守卫 + PathJail read 裁决）
// ---------------------------------------------------------------------------

/**
 * glob/grep 的读路径守卫：空 = 工作区根；段级前缀逃逸守卫 + PathJail read
 * 裁决（第二层防御；根外路径一律 path-escape，绝不读入其内容）。
 * 返回解析后的绝对路径（glob 扫描起点 / grep 搜索目标）。
 */
function guardReadPath(root: string, jail: PathJail, rawPath: string): string {
	const abs = rawPath === "" ? root : resolve(root, rawPath);
	assertInsideRoot(root, abs);
	const verdict = jail.checkPath(abs, "read");
	if (!verdict.allowed) throw new Error(`path-protected: ${verdict.reason ?? "protected"}`);
	return abs;
}

/**
 * glob —— 工作区文件模式匹配（Bun.Glob 扫描，零依赖）。
 * rg --embed 内嵌检索面维持缓议（工单原文），本卡不接 rg。
 * Bun.Glob 纯语义：不做 gitignore/node_modules 排除（dot:false 仅挡隐藏条目）；
 * 巨型树由 GLOB_RESULT_LIMIT 封顶防护。匹配只泄漏文件名不泄漏内容，故不做
 * 逐文件 PathJail 复核（grep 侧内容外泄面才需要，见 grepBinding）。
 */
function globBinding(root: string, jail: PathJail): ToolBinding {
	return {
		definition: {
			name: "glob",
			description:
				"按 glob 模式列出工作区内文件（Bun.Glob 语义，隐藏条目不参与）。path 可选（相对工作区根的扫描起点，缺省根）。返回 JSON {matches, count, truncated?}；matches 为按字典序排序的相对路径，上限 500 条。",
			inputSchema: {
				type: "object",
				properties: {
					pattern: { type: "string", description: "glob 模式（如 **/*.ts）" },
					path: { type: "string", description: "扫描起点（相对工作区根，可选，缺省根）" },
				},
				required: ["pattern"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeSearchArgs(args, "glob"),
		execute: async (args, signal) => {
			const pattern = takeStringArg(args, "pattern");
			const pathArg = optionalStringArg(args, "path");
			return await withSignal(signal, async () => {
				const base = guardReadPath(root, jail, pathArg);
				const glob = new Bun.Glob(pattern);
				const matches: string[] = [];
				let truncated = false;
				for await (const rel of glob.scan({ cwd: base, onlyFiles: true, dot: false })) {
					if (matches.length >= GLOB_RESULT_LIMIT) {
						truncated = true;
						break;
					}
					// scan 产出相对扫描起点的路径；统一改写为相对工作区根（与 grep 呈现一致）。
					matches.push(relative(root, resolve(base, rel)));
				}
				matches.sort();
				return JSON.stringify({ matches, count: matches.length, ...(truncated ? { truncated: true } : {}) });
			});
		},
	};
}

/**
 * grep —— 工作区递归正则搜索（只读；零依赖，不用 rg）。
 * 跳过面：node_modules、点开头条目（.git/.bi 与隐藏文件，rg 同款缺省）、
 * 二进制文件（内容含 NUL 即判）、超 GREP_FILE_SIZE_LIMIT_BYTES 的单文件；
 * 符号链接一律不跟随（杜绝环与越界）。命中 file:line:text 行，条数与输出
 * 双封顶（GREP_MATCH_LIMIT / GREP_OUTPUT_TAIL_LIMIT_BYTES，尾部截断风格与
 * bash 一致）。
 */
function grepBinding(root: string, jail: PathJail): ToolBinding {
	return {
		definition: {
			name: "grep",
			description:
				"在工作区内递归正则搜索文本文件（区分大小写）。跳过 node_modules/隐藏条目/二进制文件，单文件 1MB 上限；返回 JSON {count, output, truncated?, outputTruncated?}，output 为 file:line:text 行（上限 200 条，超 10KB 保留尾部）。include 可选（glob 过滤：无 / 时对文件名匹配如 *.ts，含 / 时对工作区相对路径匹配）。",
			inputSchema: {
				type: "object",
				properties: {
					pattern: { type: "string", description: "正则表达式（ECMAScript 语法）" },
					path: { type: "string", description: "搜索起点（文件或目录，相对工作区根，可选，缺省根）" },
					include: { type: "string", description: "文件名过滤 glob（如 *.ts；可选）" },
				},
				required: ["pattern"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeSearchArgs(args, "grep"),
		execute: async (args, signal) => {
			const pattern = takeStringArg(args, "pattern");
			const pathArg = optionalStringArg(args, "path");
			const include = optionalStringArg(args, "include");
			return await withSignal(signal, async () => {
				let regex: RegExp;
				try {
					regex = new RegExp(pattern);
				} catch (cause) {
					throw new Error(`grep-pattern-invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
				}
				const base = guardReadPath(root, jail, pathArg);
				const includeGlob = include === "" ? undefined : new Bun.Glob(include);
				const files = await collectGrepFiles(base);
				const matches: string[] = [];
				let truncated = false;
				search: for (const file of files) {
					const rel = relative(root, file);
					// include 过滤（rg 同款语义）：无 "/" 的 glob 对文件名匹配（*.ts 命中
					// 任意深度的 .ts，如 sub/b.ts），含 "/" 的 glob 对工作区相对路径匹配。
					if (includeGlob !== undefined && !includeGlob.match(include.includes("/") ? rel : basename(rel))) {
						continue;
					}
					// 逐文件 PathJail read 复核：凭据文件名/工作区 .env 不入扫描结果（防内容外泄）。
					if (!jail.checkPath(file, "read").allowed) continue;
					let size = 0;
					try {
						size = statSync(file).size;
					} catch {
						continue; // 探测不到（竞态删除/权限）一律跳过——扫描面绝不让异常冒泡中断。
					}
					if (size > GREP_FILE_SIZE_LIMIT_BYTES) continue;
					let text: string;
					try {
						text = await Bun.file(file).text();
					} catch {
						continue;
					}
					if (text.includes("\u0000")) continue; // 二进制启发式：含 NUL 即跳过
					const lines = text.split("\n");
					for (let i = 0; i < lines.length; i++) {
						const line = lines[i] ?? "";
						if (!regex.test(line)) continue;
						if (matches.length >= GREP_MATCH_LIMIT) {
							truncated = true;
							break search;
						}
						matches.push(`${rel}:${i + 1}:${line}`);
					}
				}
				return formatGrepResult(matches, truncated);
			});
		},
	};
}

/**
 * grep 扫描目标收集：目录 = 深度优先收集普通文件（跳过 node_modules 与
 * 点开头条目；符号链接既非 isDirectory 也非 isFile，天然不跟随）；单文件 =
 * 单元素。目标不存在 = 结构化报错。收集后按全路径字典序排序（确定性输出）。
 */
async function collectGrepFiles(base: string): Promise<string[]> {
	let baseIsDir = false;
	try {
		baseIsDir = statSync(base).isDirectory();
	} catch {
		throw new Error("grep-path-not-found");
	}
	if (!baseIsDir) return [base];
	const files: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // 不可读目录跳过（不中断整体扫描）
		}
		const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of sorted) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) files.push(full);
		}
	};
	await walk(base);
	return files;
}

/** 组装 grep 工具结果 JSON：条数 + 输出尾部 10KB 截断 + truncated/outputTruncated 标注。 */
function formatGrepResult(matches: string[], truncated: boolean): string {
	let output = matches.join("\n");
	let outputTruncated = false;
	const bytes = new TextEncoder().encode(output);
	if (bytes.byteLength > GREP_OUTPUT_TAIL_LIMIT_BYTES) {
		const tail = bytes.subarray(bytes.byteLength - GREP_OUTPUT_TAIL_LIMIT_BYTES);
		output = `${GREP_TRUNCATION_MARKER}\n${new TextDecoder().decode(tail)}`;
		outputTruncated = true;
	}
	return JSON.stringify({
		count: matches.length,
		output,
		...(truncated ? { truncated: true } : {}),
		...(outputTruncated ? { outputTruncated: true } : {}),
	});
}

/** glob/grep argSummary：模式 + 起点 + 过滤器（审批浮层审计面）。 */
function summarizeSearchArgs(args: unknown, tool: "glob" | "grep"): string {
	const pattern = optionalStringArg(args, "pattern");
	const path = optionalStringArg(args, "path");
	const include = optionalStringArg(args, "include");
	const head = pattern.length > 80 ? `${pattern.slice(0, 80)}…` : pattern;
	const base = path === "" ? "." : path;
	return tool === "glob"
		? `pattern=${head} path=${base}`
		: `pattern=${head} path=${base}${include === "" ? "" : ` include=${include}`}`;
}

// ---------------------------------------------------------------------------
// bash —— 工作区命令执行（BI-28.1；spawn 注入面 + shell-scan 标注）
// ---------------------------------------------------------------------------

interface BashDeps {
	readonly root: string;
	readonly spawnImpl: SpawnImpl;
}

function bashBinding(deps: BashDeps): ToolBinding {
	return {
		definition: {
			name: "bash",
			description:
				"在工作区根执行 bash 命令。返回 JSON {exitCode, output, timedOut?, truncated?}；exitCode 非 0 不抛错（命令失败是正常工具结果）。默认超时 60 秒（timeout_ms 可调），超时击杀并标注；stdout+stderr 合并，仅保留末尾 100KB。",
			inputSchema: {
				type: "object",
				properties: {
					command: { type: "string", description: "要执行的 bash 命令" },
					timeout_ms: { type: "number", description: "超时毫秒数（缺省 60000）" },
				},
				required: ["command"],
			},
		},
		readOnly: false,
		argSummary: bashArgSummary,
		execute: (args, signal) => {
			const command = takeStringArg(args, "command");
			const timeoutMs = takeOptionalPositiveInt(args, "timeout_ms") ?? DEFAULT_BASH_TOOL_TIMEOUT_MS;
			return runBashCommand({ ...deps, command, timeoutMs, signal });
		},
	};
}

/**
 * bash argSummary：命令截断 120 字符 + shell-scan 分类标注（后缀）。
 * dangerous（确定性危险清单命中）与 opaque（扫描器不认识的构造，fail-closed）
 * 都标注——审批浮层对"看不懂的命令"同样要显眼；分类器自身故障标 error。
 */
function bashArgSummary(args: unknown): string {
	let command = "";
	if (args !== null && typeof args === "object") {
		const raw = (args as Record<string, unknown>)["command"];
		if (typeof raw === "string") command = raw;
	}
	const head = command.length > BASH_ARG_SUMMARY_MAX ? `${command.slice(0, BASH_ARG_SUMMARY_MAX)}…` : command;
	const tag = shellScanTag(command);
	return tag === "" ? head : `${head} ${tag}`;
}

/** shell-scan 分类标注（纯函数、零 IO；异常 fail-visible 标 error）。 */
function shellScanTag(command: string): string {
	if (command.trim() === "") return "";
	try {
		const scan = scanShell(command);
		const tags: string[] = [];
		if (scan.dangerous) tags.push("dangerous");
		if (scan.opaque) tags.push("opaque");
		return tags.length > 0 ? `[shell-scan:${tags.join("+")}]` : "";
	} catch {
		return "[shell-scan:error]";
	}
}

/** 执行 bash 命令：spawn → 超时/中止竞出 → 合并输出 → 尾部 100KB → JSON 结果。 */
async function runBashCommand(input: {
	readonly root: string;
	readonly spawnImpl: SpawnImpl;
	readonly command: string;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
}): Promise<string> {
	const { root, spawnImpl, command, timeoutMs, signal } = input;
	if (signal.aborted) throw new Error("aborted");
	const proc = spawnImpl(["bash", "-c", command], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });

	const chunks: string[] = [];
	let timedOut = false;
	let settled = false;
	let onAbort = (): void => {};
	const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value !== undefined) chunks.push(decoder.decode(value, { stream: true }));
			}
		} catch {
			// 被击杀进程的流可能以错误收尾：已收到的块照常计入。
		} finally {
			// releaseLock 防御：子进程管道异常收尾（实测嵌套 bun test 触发）时，
			// 已出错的原生流 reader 释放锁可能抛原生错误——锁释放失败不影响已收
			// 块，吞掉即可，绝不让 pump 的 finally 打翻整条结果管线。
			try {
				reader.releaseLock();
			} catch {
				// 忽略：流已出错时的锁释放失败。
			}
		}
	};

	return await new Promise<string>((resolveResult, rejectResult) => {
		const settle = (finish: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			finish();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				proc.kill();
			} catch {
				// 已退出的进程 kill 会抛：照常走 exited 落定路径。
			}
		}, timeoutMs);
		onAbort = () => {
			try {
				proc.kill();
			} catch {
				// 同上。
			}
			settle(() => rejectResult(new Error("aborted")));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void pump(proc.stdout).then(() => pump(proc.stderr)).then(() => proc.exited).then(
			(exitCode) => settle(() => resolveResult(formatBashResult(exitCode, chunks.join(""), timedOut))),
			(error) => settle(() => rejectResult(error instanceof Error ? error : new Error(String(error)))),
		);
	});
}

/** 组装 bash 工具结果 JSON：尾部 100KB 截断 + timedOut/truncated 标注。 */
function formatBashResult(exitCode: number, output: string, timedOut: boolean): string {
	let text = output;
	let truncated = false;
	const bytes = new TextEncoder().encode(text);
	if (bytes.byteLength > BASH_OUTPUT_TAIL_LIMIT_BYTES) {
		const tail = bytes.subarray(bytes.byteLength - BASH_OUTPUT_TAIL_LIMIT_BYTES);
		text = `${BASH_TRUNCATION_MARKER}\n${new TextDecoder().decode(tail)}`;
		truncated = true;
	}
	return JSON.stringify({
		exitCode,
		output: text,
		...(timedOut ? { timedOut: true } : {}),
		...(truncated ? { truncated: true } : {}),
	});
}

// ---------------------------------------------------------------------------
// edit / write —— 工作区原子写（BI-28.2；唯一性替换 + PathJail 写裁决）
// ---------------------------------------------------------------------------

function editBinding(root: string, jail: PathJail): ToolBinding {
	return {
		definition: {
			name: "edit",
			description:
				"替换工作区内文本文件的片段（UTF-8 精确匹配）。old_string 必须恰有一处命中；多处命中需 replace_all=true 全量替换，零命中报错。替换为 new_string（可为空串=删除）。原子写落盘。",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "相对工作区根的文件路径" },
					old_string: { type: "string", description: "待替换原文（须唯一命中）" },
					new_string: { type: "string", description: "替换为的新文本（可为空串）" },
					replace_all: { type: "boolean", description: "多处命中时全量替换（缺省 false）" },
				},
				required: ["path", "old_string", "new_string"],
			},
		},
		readOnly: false,
		argSummary: (args) => summarizeEditArgs(root, args),
		execute: async (args, signal) => {
			const path = takeStringArg(args, "path");
			const oldString = takeRawStringArg(args, "old_string");
			const newString = takeRawStringArg(args, "new_string");
			const replaceAll = takeOptionalBooleanArg(args, "replace_all");
			return await withSignal(signal, async () => {
				// 守卫先于读写（较工单顺序更紧：根外路径绝不读入内容）。
				const abs = guardWritePath(root, jail, path);
				if (!(await Bun.file(abs).exists())) throw new Error("file-not-found");
				const content = await Bun.file(abs).text();
				const matches = content.split(oldString).length - 1;
				if (matches === 0) throw new Error("edit-no-match: matches=0");
				if (matches > 1 && !replaceAll) {
					throw new Error(`edit-ambiguous: matches=${matches} (set replace_all=true)`);
				}
				// split/join 字面替换：绕开 String.replace 的 $ 模式展开语义。
				const next = content.split(oldString).join(newString);
				await atomicWriteFile(abs, next);
				return JSON.stringify({ ok: true, path, matches });
			});
		},
	};
}

function writeBinding(root: string, jail: PathJail): ToolBinding {
	return {
		definition: {
			name: "write",
			description:
				"整文件写入工作区（UTF-8，覆盖或新建）。允许新建文件，但父目录必须已存在。原子写落盘。",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "相对工作区根的文件路径" },
					content: { type: "string", description: "完整文件内容（可为空串）" },
				},
				required: ["path", "content"],
			},
		},
		readOnly: false,
		argSummary: (args) => summarizeWriteArgs(args),
		execute: async (args, signal) => {
			const path = takeStringArg(args, "path");
			const content = takeRawStringArg(args, "content");
			return await withSignal(signal, async () => {
				const abs = guardWritePath(root, jail, path);
				let parentIsDir = false;
				try {
					parentIsDir = statSync(dirname(abs)).isDirectory();
				} catch {
					parentIsDir = false;
				}
				if (!parentIsDir) throw new Error("parent-dir-not-found");
				await atomicWriteFile(abs, content);
				return JSON.stringify({ ok: true, path, bytes: byteLengthOf(content) });
			});
		},
	};
}

// ---------------------------------------------------------------------------
// edit/write argSummary —— 路径 + 替换计数/字节数 + 片段（审批浮层审计面）
// ---------------------------------------------------------------------------

/** edit argSummary：路径 + 真实匹配计数（尽力而为同步读）+ old/new 首行片段。 */
function summarizeEditArgs(root: string, args: unknown, snippetMax = 60): string {
	const path = optionalStringArg(args, "path");
	const oldString = optionalStringArg(args, "old_string");
	const newString = optionalStringArg(args, "new_string");
	const replaceAll = optionalBooleanArg(args, "replace_all");
	let matches = "?";
	if (path !== "" && oldString !== "") {
		try {
			const abs = resolve(root, path);
			if (abs === root || abs.startsWith(root + sep)) {
				matches = String(readFileSync(abs, "utf8").split(oldString).length - 1);
			}
		} catch {
			// 读不到（不存在/是目录/二进制）一律 matches=?，绝不抛错——argSummary 是审计面。
		}
	}
	const all = replaceAll ? " replace_all" : "";
	return `path=${path} matches=${matches}${all} old=${snippet(oldString, snippetMax)} new=${snippet(newString, snippetMax)}`;
}

/** write argSummary：路径 + 内容字节数。 */
function summarizeWriteArgs(args: unknown): string {
	const path = optionalStringArg(args, "path");
	const content = optionalStringArg(args, "content");
	return `path=${path} bytes=${byteLengthOf(content)}`;
}

/** 首行片段（JSON.stringify 定界 + 截断；多行追加省略号）。 */
function snippet(text: string, max: number): string {
	const nl = text.indexOf("\n");
	const first = nl === -1 ? text : text.slice(0, nl);
	const elided = nl !== -1 ? "…" : "";
	const clipped = first.length > max ? `${first.slice(0, max)}…` : first;
	return JSON.stringify(`${clipped}${elided}`);
}

function byteLengthOf(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

// ---------------------------------------------------------------------------
// web_fetch / web_search —— BI-07.15 web 器官包装（readOnly = 无文件写语义）
// ---------------------------------------------------------------------------

function webFetchBinding(fetchImpl: FetchExecutor): ToolBinding {
	return {
		definition: {
			name: "web_fetch",
			description: "抓取网页并归一化为 Markdown/文本（HTML 取主内容；重定向、超时与字节上限受控）。",
			inputSchema: {
				type: "object",
				properties: { url: { type: "string", description: "http(s) 完整 URL" } },
				required: ["url"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "url"),
		execute: (args, signal) => {
			const url = takeStringArg(args, "url");
			return withSignal(signal, () => fetchWebPage(url, { fetchImpl }));
		},
	};
}

interface WebSearchDeps {
	readonly fetchImpl: FetchExecutor;
	readonly env: Record<string, string | undefined>;
	readonly apiKeyEnv: string;
	readonly cache: TtlResultCache;
	readonly limiter: TokenBucketRateLimiter;
}

function webSearchBinding(deps: WebSearchDeps): ToolBinding {
	return {
		definition: {
			name: "web_search",
			description: "Web 搜索（DeepSeek provider）。返回 { title, url, snippet } 结果列表；需经环境变量配置 API 密钥。",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string", description: "搜索词" } },
				required: ["query"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "query"),
		execute: async (args, signal) => {
			const query = takeStringArg(args, "query");
			// 密钥门：执行时解析（api_key_env 间接引用语义），未设置结构化报错，不假冒结果。
			const apiKey = (deps.env[deps.apiKeyEnv] ?? "").trim();
			if (apiKey === "") {
				throw new Error(`web_search 未配置：环境变量 ${deps.apiKeyEnv} 未设置（api_key_env 间接引用语义；导出后重试）`);
			}
			const provider = new DeepSeekSearchProvider({ apiKey, fetchImpl: deps.fetchImpl });
			return await withSignal(signal, () =>
				webSearch(query, {
					provider,
					cache: deps.cache,
					limiter: deps.limiter,
				}),
			);
		},
	};
}

// ---------------------------------------------------------------------------
// 绑定层小件：参数取值 / 摘要截断 / 信号竞出
// ---------------------------------------------------------------------------

/** 取字符串参数（缺省/非字符串/空串统一结构化报错）。 */
function takeStringArg(args: unknown, key: string): string {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	if (typeof raw !== "string" || raw.trim() === "") throw new Error(`${key} required`);
	return raw;
}

/**
 * 取字符串参数（允许空串：new_string=删除、content=清空文件是合法语义）。
 * 仅做类型检查：缺省/非字符串 = 结构化报错。
 */
function takeRawStringArg(args: unknown, key: string): string {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	if (typeof raw !== "string") throw new Error(`${key} required`);
	return raw;
}

/** 取可选布尔参数（缺省 false；非布尔 = 结构化报错）。 */
function takeOptionalBooleanArg(args: unknown, key: string): boolean {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	if (raw === undefined) return false;
	if (typeof raw !== "boolean") throw new Error(`${key} invalid`);
	return raw;
}

/** 取可选正整数参数（如 timeout_ms；undefined=缺省；非法 = 结构化报错）。 */
function takeOptionalPositiveInt(args: unknown, key: string): number | undefined {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	if (raw === undefined) return undefined;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) throw new Error(`${key} invalid`);
	return raw;
}

/** 静默取字符串（argSummary 容错面：缺省/非字符串回空串，绝不抛）。 */
function optionalStringArg(args: unknown, key: string): string {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	return typeof raw === "string" ? raw : "";
}

/** 静默取布尔（argSummary 容错面）。 */
function optionalBooleanArg(args: unknown, key: string): boolean {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	return raw === true;
}

/** argSummary：目标参数原文（缺省回退整参 JSON），截断到 200 字符（权限门审计面）。 */
function summarizeArg(args: unknown, key: string, max = 200): string {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	let text: string;
	if (typeof raw === "string") {
		text = raw;
	} else {
		try {
			text = JSON.stringify(args) ?? String(args);
		} catch {
			text = String(args);
		}
	}
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 信号透传（器官无 signal 入参时的绑定层补偿）：一旦 abort 立即 reject，
 * 不等器官自身超时。start 工厂惰性求值——已中止的信号不启动器官调用；
 * 竞出后器官侧结果/异常照常落定（已被本层接管，不产生未处理拒绝）。
 */
function withSignal<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	let pending: Promise<T>;
	try {
		pending = start();
	} catch (error) {
		return Promise.reject(error);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
