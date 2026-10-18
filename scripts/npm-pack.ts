#!/usr/bin/env bun
/**
 * BI-25.4 —— npm 平台二进制包组装（esbuild/turbo 同款模式）。
 *
 * 用法：bun scripts/npm-pack.ts [--outdir <dir>]
 *
 * 产物：<outdir>/ 下三个可发布包目录（npm publish 逐个执行，本脚本不发布、不持凭据）：
 *   bi-linux-x64/     @bpfio-yp/bi-linux-x64   含 linux-x64 原生二进制
 *   bi-darwin-arm64/  @bpfio-yp/bi-darwin-arm64 含 darwin-arm64 原生二进制（尽力交叉，失败即整包跳过并记录）
 *   bi/               @bpfio-yp/bi 元包：bin/bi.js shim 按平台选装 optionalDependencies 后 spawn 二进制
 *
 * 设计：
 * - 终端用户 `npm i -g @bpfio-yp/bi` 运行期**不需要 Node/Bun 之外的任何依赖**——
 *   二进制由 scripts/build-bin.ts（Bun Compile 单文件）产出，本脚本只做拼装。
 * - 平台包缺一不可与 optionalDependencies 严格一致：某平台构建失败 → 该平台包
 *   跳过且从元包 optionalDependencies 中剔除（结构化 warnings），绝不发布会装不
 *   出二进制的元包。
 * - 凭据零接触：本脚本不读不写任何 npm token；发布由调用方经环境变量注入。
 */
import { cp, mkdir, chmod, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const SCOPE = "@bpfio"; // 2026-10-19 起迁移至 bpfio org（原 @bpfio-yp 用户 scope 已发布 0.1.0 并 deprecate 指引迁移）
const REPO_URL = "https://github.com/bpfio/bi";
const DESCRIPTION =
	"bi — a terminal CLI Agent built with Bun + TypeScript. Independent implementation, not a fork of any existing agent CLI.";

interface TargetSpec {
	pkg: string;
	target: string;
	os: string;
	cpu: string;
}

const TARGETS: readonly TargetSpec[] = [
	{ pkg: "bi-linux-x64", target: "linux-x64", os: "linux", cpu: "x64" },
	{ pkg: "bi-darwin-arm64", target: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
];

const warnings: string[] = [];

function parseArgs(argv: readonly string[]): { outdir: string } {
	let outdir = "/tmp/bi-npm/pkgs";
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--outdir") {
			const value = argv[i + 1];
			if (value === undefined) throw new Error("--outdir 需要值");
			outdir = value;
			i += 1;
		}
	}
	return { outdir };
}

async function buildBinary(target: TargetSpec, binDir: string): Promise<boolean> {
	const proc = Bun.spawnSync({
		cmd: ["bun", "scripts/build-bin.ts", "--target", target.target, "--outdir", binDir],
		cwd: import.meta.dir + "/..",
		stdout: "pipe",
		stderr: "pipe",
	});
	const text = `${proc.stdout.toString()}${proc.stderr.toString()}`;
	// build-bin 成功态=BuildReport（多行 pretty JSON，无 ok 字段）；失败态={"ok":false,...} 且退出码 1。
	// 判据：退出码 0 且文本不含显式失败标志（产物存在性由调用方 dirExistsNonEmpty 兜底）。
	const ok = proc.exitCode === 0 && !/"ok"\s*:\s*false/.test(text);
	if (!ok) warnings.push(`${target.pkg}: 构建失败（${text.slice(-300)}）——整包跳过`);
	return ok;
}

async function dirExistsNonEmpty(path: string): Promise<boolean> {
	try {
		return (await readdir(path)).length > 0;
	} catch {
		return false;
	}
}

async function main(): Promise<number> {
	const { outdir } = parseArgs(Bun.argv.slice(2));
	const root = import.meta.dir + "/..";
	const pkgRootVersion = (await readFile(join(root, "package.json"), "utf8")) as unknown as { version?: string };
	// Bun.file().json() 更直接；此处保留同步文本解析以显式校验 version 字段存在。
	const version = JSON.parse(String(pkgRootVersion)).version as string;
	if (typeof version !== "string" || version === "") throw new Error("根 package.json 缺 version");
	await rm(outdir, { recursive: true, force: true });
	await mkdir(outdir, { recursive: true });

	const built: TargetSpec[] = [];
	for (const target of TARGETS) {
		const pkgDir = join(outdir, target.pkg);
		const binDir = join(pkgDir, "bin");
		await mkdir(binDir, { recursive: true });
		const ok = await buildBinary(target, binDir);
		if (!ok) continue;
		const binary = join(binDir, "bi");
		const binaryReady = await dirExistsNonEmpty(binDir);
		if (!binaryReady) {
			warnings.push(`${target.pkg}: 构建产物缺 bi 二进制——整包跳过`);
			continue;
		}
		await chmod(binary, 0o755);
		const pkg = {
			name: `${SCOPE}/${target.pkg}`,
			version,
			description: `bi native binary for ${target.os}-${target.cpu} (internal platform package of ${SCOPE}/bi).`,
			license: "MIT",
			repository: { type: "git", url: REPO_URL },
			os: [target.os],
			cpu: [target.cpu],
			files: ["bin", "LICENSE", "README.md"],
		};
		await writeFile(join(pkgDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
		await writeFile(
			join(pkgDir, "README.md"),
			`# ${SCOPE}/${target.pkg}\n\n${target.os}-${target.cpu} 平台原生二进制（${SCOPE}/bi 元包自动选装，勿直接安装）。\n`,
		);
		await cp(join(root, "LICENSE"), join(pkgDir, "LICENSE"));
		built.push(target);
	}

	// 元包：shim 按 platform-arch 选装平台包后 spawn 二进制。
	const metaDir = join(outdir, "bi");
	const metaBin = join(metaDir, "bin");
	await mkdir(metaBin, { recursive: true });
	const platformMap = Object.fromEntries(built.map((t) => [`${t.os}-${t.cpu}`, `${SCOPE}/${t.pkg}`]));
	const shim = `#!/usr/bin/env node
// ${SCOPE}/bi 平台选装 shim（BI-25.4）：定位平台二进制后 spawn，转发参数与退出码。
const map = ${JSON.stringify(platformMap, null, 2)};
const key = \`\${process.platform}-\${process.arch}\`;
const pkg = map[key];
if (pkg === undefined) {
	console.error(\`bi: 暂不支持的平台 \${key}（已发布平台：\${Object.keys(map).join(", ") || "无"}）\`);
	process.exit(3);
}
let binPath;
try {
	binPath = require.resolve(pkg + "/bin/bi");
} catch (cause) {
	console.error("bi: 平台二进制缺失（" + pkg + " 未安装？" + String(cause) + "）");
	process.exit(3);
}
const { spawnSync } = require("node:child_process");
const result = spawnSync(binPath, process.argv.slice(2), { stdio: "inherit" });
if (result.error !== undefined) {
	console.error("bi: 启动失败：" + String(result.error));
	process.exit(1);
}
process.exit(result.status ?? 1);
`;
	await writeFile(join(metaBin, "bi.js"), shim);
	await chmod(join(metaBin, "bi.js"), 0o755);
	const meta = {
		name: `${SCOPE}/bi`,
		version,
		description: DESCRIPTION,
		license: "MIT",
		repository: { type: "git", url: REPO_URL },
		bin: { bi: "./bin/bi.js" },
		engines: { node: ">=18" },
		files: ["bin", "LICENSE", "README.md"],
		optionalDependencies: Object.fromEntries(built.map((t) => [`${SCOPE}/${t.pkg}`, version])),
	};
	await writeFile(join(metaDir, "package.json"), `${JSON.stringify(meta, null, 2)}\n`);
	await writeFile(
		join(metaDir, "README.md"),
		`# ${SCOPE}/bi\n\n${DESCRIPTION}\n\n\`\`\`bash\nnpm install -g ${SCOPE}/bi\nbi --version\nbi --prompt "你好"\nbi            # 交互 REPL\n\`\`\`\n\n原生单文件二进制（Bun Compile），运行期无需 Node/Bun；平台包经 optionalDependencies 自动选装（linux-x64 / darwin-arm64）。\n`,
	);
	await cp(join(root, "LICENSE"), join(metaDir, "LICENSE"));

	console.log(
		JSON.stringify(
			{
				ok: true,
				outdir,
				version,
				scope: SCOPE,
				packages: built.map((t) => `${SCOPE}/${t.pkg}`),
				meta: `${SCOPE}/bi`,
				warnings,
			},
			null,
			2,
		),
	);
	return 0;
}

process.exitCode = await main();
