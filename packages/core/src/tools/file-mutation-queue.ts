import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * 规范化文件写入互斥队列。
 *
 * 解决的问题：对同一个物理文件的两条不同提交路径（软链 vs 真身、相对 vs 绝对、
 * 含 `..` 的折叠写法）如果各开各的写入，互斥形同虚设。因此队列键一律先经
 * `canonicalPath` 归一化为物理路径，再按键串行：
 *
 * - 同键：按到达顺序经 Promise 链严格串行，前一个操作结算（含失败）后才轮到下一个；
 * - 异键：各自独立成链，互不阻塞；
 * - 错误隔离：单次操作失败只落到该次调用的 promise 上，不毒化队列链，后续照常执行。
 *
 * 注意：本队列是非重入锁。`fn` 内部不得对同一路径再次入队，否则自我死锁。
 */

/**
 * 把任意路径解析为物理规范路径（即队列键）。
 *
 * 算法（两层回退）：
 * 1. 先 `path.resolve` 折叠 `.`/`..` 与相对段得到绝对路径，再尝试 `fs.realpath`：
 *   目标存在时直接得到消解软链后的物理路径。
 * 2. realpath 失败（写前目标通常尚不存在）时，自路径末端逐层上溯：
 *   每剥掉末段就对剩余前缀再试 realpath，首个成功的前缀即"最近存在祖先"，
 *   返回 `realpath(祖先)` + 余下不存在段按原顺序拼接。
 *   于是"经软链前缀指向的尚不存在文件"与"经真身前缀写的同一文件"会归一到同一个键。
 *   若 realpath 因 ENOENT 以外的原因失败（如权限、ELOOP），同样走该上溯回退——
 *   只要同一路径重复提交结果仍然确定一致，满足队列键的幂等要求。
 * 3. 连祖先都全不存在时一路退到文件系统根；根目录解析失败属极端环境异常，原样抛出。
 *
 * 并发去重：同一绝对路径的在途解析共享同一个 promise——既省系统调用，也保证
 * 同键并发提交的入队顺序与调用顺序一致（realpath 在线程池完成，各自独立解析时
 * 完成顺序不可复现）。去重窗口仅为单次解析在途期间，结算即失效，不影响后续新鲜度。
 */
export function canonicalPath(rawPath: string): Promise<string> {
	const absolute = resolve(rawPath);
	const inFlight = canonicalInFlight.get(absolute);
	if (inFlight) return inFlight;
	const promise = computeCanonicalPath(absolute).finally(() => {
		if (canonicalInFlight.get(absolute) === promise) canonicalInFlight.delete(absolute);
	});
	canonicalInFlight.set(absolute, promise);
	return promise;
}

/** 同一绝对路径的在途解析去重表（见 canonicalPath 文档）。 */
const canonicalInFlight = new Map<string, Promise<string>>();

async function computeCanonicalPath(absolute: string): Promise<string> {
	try {
		return await realpath(absolute);
	} catch {
		// 目标不存在或无法完整解析，进入"最近存在祖先 + 余段"上溯。
	}
	const tail: string[] = [];
	let current = absolute;
	for (;;) {
		const parent = dirname(current);
		if (parent === current) {
			// 已上溯到根（POSIX 为 "/"）：根必然存在，realpath 失败则原样抛出。
			return join(await realpath(current), ...tail);
		}
		tail.unshift(current.slice(parent.length + 1));
		current = parent;
		try {
			return join(await realpath(current), ...tail);
		} catch {
			// 该层祖先也不存在（或不可解析），继续上溯。
		}
	}
}

/** 单个队列键的串行链状态。 */
interface QueueEntry {
	/** 链尾结算 promise：永不 reject（失败在此被吞掉，仅用于维持时序），保证失败不堵死队列。 */
	tail: Promise<void>;
	/** 已入队但尚未开始执行的操作数。 */
	pending: number;
}

const queues = new Map<string, QueueEntry>();

/**
 * 把 `fn` 排入以 `canonicalPath(path)` 为键的串行队列。
 *
 * - 返回 `fn` 本身的结算结果：返回值与异常都原样透传给本次调用方；
 * - 同键操作按到达顺序执行：前一个结算（含失败）后才开始下一个；
 * - 异键操作并行不阻塞；
 * - 单次失败不毒化队列链，同键后续操作照常执行。
 */
export function withFileMutationQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
	return canonicalPath(path).then((key) => {
		const existing = queues.get(key);
		const entry: QueueEntry = existing ?? { tail: Promise.resolve(), pending: 0 };
		if (!existing) queues.set(key, entry);
		entry.pending += 1;

		const result = entry.tail.then(() => {
			entry.pending -= 1;
			return fn();
		});
		const settlement = result.then(
			() => undefined,
			() => undefined,
		);
		entry.tail = settlement;
		settlement.then(() => {
			// 结算后若没有新操作接上（本条仍是链尾），回收条目避免 map 无界增长。
			if (queues.get(key) === entry && entry.tail === settlement) queues.delete(key);
		});
		return result;
	});
}

export interface FileMutationQueueStats {
	/** 当前仍在追踪的队列键数量（含正在执行与仍有排队操作的键）。 */
	activeKeys: number;
	/** 每个被追踪键上"已入队但尚未开始执行"的操作数（正在执行的键值为 0）。 */
	pendingCounts: Map<string, number>;
}

/** 调试观测：当前队列的键数与各键排队深度。 */
export function getQueueStats(): FileMutationQueueStats {
	const pendingCounts = new Map<string, number>();
	for (const [key, entry] of queues) pendingCounts.set(key, entry.pending);
	return { activeKeys: queues.size, pendingCounts };
}

/**
 * 清空内部全部状态（队列 map 与在途路径解析去重表），仅供测试隔离使用。
 * 应在无在途操作时调用：已入队操作各自持有自己的链引用，不会被终止或重排，
 * 但 reset 后的新提交不再与 reset 前的链互斥。
 */
export function resetFileMutationQueueForTests(): void {
	queues.clear();
	canonicalInFlight.clear();
}
