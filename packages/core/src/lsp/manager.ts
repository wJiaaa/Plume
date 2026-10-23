/**
 * Which backend answers, and what happens while it is still waking up.
 *
 * A language server is heavy: `tsserver` on a mid-sized TypeScript project is several hundred
 * megabytes and takes seconds before it can answer anything. Two consequences shape this file.
 *
 * It starts lazily. Most sessions never ask a symbol question, and warming up on session start
 * would mean every window costs that memory for a feature it does not use.
 *
 * And a call that arrives before it is ready gets the textual answer *now* rather than a wait. The
 * agent asked because it is about to change something; an answer that arrives after it has already
 * moved on is worth less than a caveated one that arrives immediately.
 */

import { extname, resolve } from "node:path";
import { LANGUAGE_SERVERS } from "./servers.ts";
import { StdioLspBackend } from "./stdio.ts";
import { TsServerBackend } from "./tsserver.ts";
import type { CodeIntelBackend } from "./types.ts";

/** TypeScript 走 tsserver，其余按 `servers.ts` 那张表，每种语言一台、各自懒启动。 */
const defaultBackends = (): CodeIntelBackend[] => [new TsServerBackend(), ...LANGUAGE_SERVERS.map((spec) => new StdioLspBackend(spec))];

/**
 * How long a first call may block on a server that is still starting.
 *
 * Short on purpose. This is not "how long until tsserver is ready" — it is how long a tool call may
 * hang before a degraded answer beats an accurate one.
 */
const READY_WAIT_MS = 3000;

/**
 * 空闲多久之后把语言服务器杀掉。
 *
 * 一台 tsserver 几百兆内存，而一个会话开着一整天里真正问它的时间加起来不到十分钟。
 * 十分钟是计划 18 定的数——比一次「想一想再问」长，比一顿饭短。下次问它会重新起，
 * 代价是那一次多等几秒。
 */
export const IDLE_MS = 10 * 60 * 1000;

export class CodeIntelManager {
	private readonly backends: CodeIntelBackend[];
	/** 正在起的，按后端去重；起完（成没成都算）就拿掉，失败的下次再问会重新起。 */
	private readonly starting = new Map<CodeIntelBackend, Promise<void>>();
	private readonly idleMs: number;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(backends: CodeIntelBackend[] = defaultBackends(), options: { idleMs?: number } = {}) {
		this.backends = backends;
		this.idleMs = options.idleMs ?? IDLE_MS;
	}

	/**
	 * 有人问了：重新计时。
	 *
	 * `unref`，跟子进程本身一样：一个还没到期的计时器不该成为进程活着的理由——CLI 跑完一件事
	 * 之后不该因为十分钟后要杀一个服务器而挂着不退。
	 */
	private touch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => void this.recycle(), this.idleMs);
		this.idleTimer.unref();
	}

	/**
	 * 到期了：杀掉在跑的，忘掉在起的。
	 *
	 * 管理器自己留着——下次 `acquire` 会重新起。跟 `dispose` 的区别就在这儿：那个是会话结束，
	 * 这个只是没人问了一阵。
	 */
	private async recycle(): Promise<void> {
		this.idleTimer = null;
		await Promise.all(this.backends.filter((b) => b.ready()).map((b) => b.dispose().catch(() => {})));
		this.starting.clear();
	}

	backendFor(file: string): CodeIntelBackend | null {
		const ext = extname(file).toLowerCase();
		return this.backends.find((backend) => backend.extensions.includes(ext)) ?? null;
	}

	/**
	 * Get a backend that can answer about `file`, or null to use the fallback.
	 *
	 * Null covers three different situations on purpose — no backend for this language, the binary
	 * is not installed, and it is still starting — because the caller does the same thing in all
	 * three, and distinguishing them would only move the branching one level up.
	 *
	 * `waitMs` is how long this call may wait on a startup. Edits pass 0: tsserver is up the moment
	 * it is spawned and still answers, while a server that needs a handshake is started and left to
	 * the next edit instead of holding this one.
	 */
	async acquire(file: string, root: string, { waitMs = READY_WAIT_MS }: { waitMs?: number } = {}): Promise<CodeIntelBackend | null> {
		const backend = this.backendFor(file);
		if (!backend) return null;
		if (!(await backend.available())) return null;

		if (backend.ready()) {
			this.touch();
			return backend;
		}

		let pending = this.starting.get(backend);
		if (!pending) {
			pending = backend
				.start(root)
				.catch(() => {})
				.finally(() => this.starting.delete(backend));
			this.starting.set(backend, pending);
		}

		/*
		 * Race the startup against the deadline rather than awaiting it.
		 *
		 * Losing the race is not a failure — the startup keeps going, and the next call finds it
		 * ready. What must not happen is the first call blocking for the fifteen seconds a cold
		 * `tsserver` can take on a large project.
		 */
		const won = await Promise.race([pending.then(() => true), delay(waitMs).then(() => false)]);
		// 起来了就开始计时——起不来的不计，它没占着什么。
		if (backend.ready()) this.touch();
		return won && backend.ready() ? backend : null;
	}

	/**
	 * `acquire` 给了 null 之后，为什么——写进工具结果里的那句话。
	 *
	 * `acquire` 把几种情况并成一个 null，是因为调用方在每种情况下做的事一样：退回文本搜索。
	 * 说的话却不一样，而说清楚正是降级可以被接受的前提：「没装 gopls」是人能去解决的，
	 * 「还在启动」是等一下就好的。没有为这种文件配置任何服务器时返回 null，工具照旧只说文本搜索。
	 */
	async unavailable(file: string): Promise<string | null> {
		const backend = this.backendFor(file);
		if (!backend) return null;
		if (!(await backend.available())) return `这个语言没有可用的语言服务器（需要安装 ${backend.install ?? backend.name}）。`;
		if (!backend.ready()) return `语言服务器 ${backend.name} 还没有就绪（正在启动或启动失败），这次先用文本搜索。`;
		return null;
	}

	async dispose(): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		await Promise.all(this.backends.map((backend) => backend.dispose().catch(() => {})));
		this.starting.clear();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export const CODE_INTEL_KEY = "codeIntel";

/** 一份 state 借着的那一套：在哪个目录。真正的管理器在 `shared` 里，几份 state 共用。 */
class CodeIntelLease {
	readonly root: string;
	readonly manager: CodeIntelManager;

	constructor(root: string, manager: CodeIntelManager) {
		this.root = root;
		this.manager = manager;
	}
}

/**
 * 每个目录一套，谁在用记在 `users` 里。
 *
 * 原来每个会话、每次派出去的子代理各起一套：同一个项目开三个会话就是三个 tsserver，每个几百兆；
 * 子代理每派一次冷启动一次，跑完杀掉，下一次再冷启动。它们看的是同一个目录里的同一批文件，
 * 一套就够。worktree 里的会话目录不同，照旧各用各的——那确实是另一批文件。
 */
const shared = new Map<string, { manager: CodeIntelManager; users: Set<Map<string, unknown>> }>();

/**
 * 这份 state 在 `root` 下用的管理器：`lsp` 工具和编辑后的诊断共用，同一个目录的会话和子代理也共用。
 * 用完由 `releaseCodeIntel` 还回去。
 *
 * state 里已经放着一个管理器的（测试、宿主自己装的），就用它，不进共用的那份。
 */
export function codeIntelFor(state: Map<string, unknown>, root: string): CodeIntelManager {
	const existing = state.get(CODE_INTEL_KEY);
	if (existing instanceof CodeIntelManager) return existing;
	const key = resolve(root);
	if (existing instanceof CodeIntelLease) {
		if (existing.root === key) return existing.manager;
		void releaseCodeIntel(state);
	}
	let entry = shared.get(key);
	if (!entry) {
		entry = { manager: new CodeIntelManager(), users: new Set() };
		shared.set(key, entry);
	}
	entry.users.add(state);
	state.set(CODE_INTEL_KEY, new CodeIntelLease(key, entry.manager));
	return entry.manager;
}

/**
 * 会话、子代理结束时：还回它借的那一套，最后一个还的把语言服务器停掉。自己装进去的管理器直接停。
 *
 * 语言服务器每个几百兆，不停的话会一直活到进程退出。
 */
export async function releaseCodeIntel(state: Map<string, unknown>): Promise<void> {
	const existing = state.get(CODE_INTEL_KEY);
	state.delete(CODE_INTEL_KEY);
	if (existing instanceof CodeIntelManager) {
		await existing.dispose().catch(() => {});
		return;
	}
	if (!(existing instanceof CodeIntelLease)) return;
	const entry = shared.get(existing.root);
	if (!entry || entry.manager !== existing.manager) return;
	entry.users.delete(state);
	if (entry.users.size > 0) return;
	shared.delete(existing.root);
	await entry.manager.dispose().catch(() => {});
}
