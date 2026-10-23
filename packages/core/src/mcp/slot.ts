/**
 * One server's connection, and where it is in getting one: connecting, connected, reconnecting,
 * failed. A slot belongs to the pool (`pool.ts`), not to a session — every session that uses the
 * server holds the same slot, so a reconnect or a crash is one event that all of them see.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AskPerson } from "./elicitation.ts";
import { McpMissingValues } from "./placeholders.ts";
import { McpNeedsLogin } from "./oauth.ts";
import type { RawMcpTool } from "./tool.ts";
import type { McpConnection, McpServerConfig, McpServerStatus } from "./types.ts";

/** 一次工具调用碰上服务器正在重连时，最多等它多久。 */
const RECONNECT_WAIT_MS = 15_000;
/** 一台服务器的 `nextCursor` 永远不为空时，翻到这么多页就当它坏了。和 prompt 一样。 */
const MAX_PAGES = 50;

type SlotState = McpServerStatus["state"];

/** 借用一个槽的一方：一个会话手里的 `McpManager`。 */
export interface McpHolder {
	/** 每个会话独立的服务器按它分开。 */
	readonly id: string;
	/** 服务器中途要人填表时怎么问到这个会话的人；没有人可问的不给。 */
	readonly ask: AskPerson | undefined;
	/** 它借着的槽状态变了。 */
	changed(slot: Slot): void;
	/** 它借着的槽被整个池子收走了（`McpPool.disconnect`）。 */
	lost(slot: Slot): void;
}

/** 槽向谁要连接、向谁报变化：`McpPool`。写成接口，槽就不必认得池子。 */
export interface SlotOwner {
	readonly timeoutMs: number;
	readonly reconnectPolicy: { baseMs: number; maxMs: number; attempts: number; stableMs: number };
	open(slot: Slot): Promise<{ connection: McpConnection; listed: RawMcpTool[] }>;
	changed(slot: Slot): void;
}

/**
 * Tools ask it for a client on every call (`McpToolHandle`), so a reconnect behind them is invisible
 * to the tool list the model already has.
 */
export class Slot {
	declared: McpServerConfig;
	/** 池子里的键：同一个键的会话共用这一个槽。 */
	readonly key: string;
	state: SlotState = "connecting";
	connection: McpConnection | undefined;
	/** 最近一次列出的工具。重连期间留着：服务器回来了，工具表不必变。 */
	listed: RawMcpTool[] = [];
	error: string | undefined;
	/** 让这次连接失败的那个错误本身，`connect()` 原样抛给调用的人。 */
	failure: unknown;
	stderr: string | undefined;
	missing: string[] | undefined;
	/** 连续第几次重连。0 表示没在重连。 */
	attempt = 0;
	startedAt = Date.now();
	stderrOf: (() => string) | undefined;
	/** 服务器自己的一句介绍。断线重连期间留着上一次的：延迟加载的目录写在提示词里，不该跟着断线变。 */
	about: string | undefined;
	/** 谁正在这条连接上调用工具、各几次。服务器中途反问人时，据此找到该问的那个会话（`McpPool.askFor`）。 */
	readonly calls = new Map<McpHolder, number>();
	private connectedAt = 0;
	private closed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private refreshing: Promise<void> | undefined;
	private refreshAgain = false;
	private readonly waiters = new Set<() => void>();
	private readonly pool: SlotOwner;

	constructor(pool: SlotOwner, key: string, declared: McpServerConfig) {
		this.pool = pool;
		this.key = key;
		this.declared = declared;
	}

	offersTools(): boolean {
		return this.state === "connected" || this.state === "reconnecting";
	}

	/** 还连着、或者正在第一次连：留着用就行，不必为一次重载重启它。 */
	healthy(): boolean {
		return !this.closed && (this.state === "connected" || this.state === "connecting");
	}

	/** One connection attempt; its outcome lands in `state`. Never throws. */
	begin(): void {
		// 重启时新槽要等旧的那个关完才开始（`McpPool.restart`），这期间它可能已经被关掉了。
		if (this.closed) return;
		this.state = this.attempt > 0 ? "reconnecting" : "connecting";
		this.startedAt = Date.now();
		void this.pool.open(this).then(
			({ connection, listed }) => this.adopt(connection, listed),
			(error: unknown) => this.fail(error),
		);
	}

	/** 一次工具调用从开始到结束都记在调用它的那个会话名下。 */
	async track<T>(holder: McpHolder, run: () => Promise<T>): Promise<T> {
		this.calls.set(holder, (this.calls.get(holder) ?? 0) + 1);
		try {
			return await run();
		} finally {
			const left = (this.calls.get(holder) ?? 1) - 1;
			if (left > 0) this.calls.set(holder, left);
			else this.calls.delete(holder);
		}
	}

	private adopt(connection: McpConnection, listed: RawMcpTool[]): void {
		if (this.closed) {
			// Closed while this one was starting: nobody is going to read this connection, or close it.
			void connection.close();
			return;
		}
		this.connection = connection;
		this.connectedAt = Date.now();
		this.about = serverAbout(connection.client);
		this.state = "connected";
		this.error = undefined;
		this.failure = undefined;
		this.stderr = undefined;
		this.missing = undefined;
		this.setListed(listed);
		connection.client.onclose = () => {
			if (this.connection === connection && !this.closed) this.dropped();
		};
		this.wake();
		this.pool.changed(this);
	}

	private async fail(error: unknown): Promise<void> {
		// stderr 经 PassThrough 转一手，比进程的 close 晚一拍到；等它一下再读最后几行。
		await new Promise((resolve) => setImmediate(resolve));
		if (this.closed) return;
		this.failure = error;
		this.error = error instanceof Error ? error.message : String(error);
		this.stderr = this.stderrOf?.() || undefined;
		this.missing = error instanceof McpMissingValues ? error.missing : undefined;
		if (error instanceof McpNeedsLogin) this.state = "needs-login";
		// 只有重连才再试：第一次就连不上、或者缺着要人填的值，再试一遍也是同样的结果。
		else if (this.attempt > 0 && !(error instanceof McpMissingValues)) this.retryOrGiveUp(this.attempt + 1, this.error);
		else this.state = "failed";
		this.wake();
		this.pool.changed(this);
	}

	/** 连着的连接断了：进程退出，或者远端断线。 */
	private dropped(): void {
		const stable = Date.now() - this.connectedAt >= this.pool.reconnectPolicy.stableMs;
		this.connection = undefined;
		this.error = `The connection to "${this.declared.name}" was lost`;
		this.stderr = this.stderrOf?.() || undefined;
		// 连得够久才断的是一次新的断线，从第一次重连数起；刚连上就断的接着上一轮往下数。
		this.retryOrGiveUp(stable ? 1 : this.attempt + 1, "it keeps disconnecting right after it connects");
		this.wake();
		this.pool.changed(this);
		// stderr 比 close 晚一拍到，补一次；状态没变，只是原因写全了。
		setImmediate(() => {
			if (this.closed || this.state === "connected") return;
			const tail = this.stderrOf?.() || undefined;
			if (tail !== this.stderr) {
				this.stderr = tail;
				this.pool.changed(this);
			}
		});
	}

	/** 排上第 `next` 次重连；超出 `attempts` 就放弃，`attempt` 停在已经试过的次数上。 */
	private retryOrGiveUp(next: number, why: string): void {
		if (next > this.pool.reconnectPolicy.attempts) {
			this.state = "failed";
			this.error = `Gave up after ${next - 1} reconnect attempts: ${why}`;
			return;
		}
		this.attempt = next;
		this.state = "reconnecting";
		this.schedule();
	}

	private schedule(): void {
		const policy = this.pool.reconnectPolicy;
		const delay = Math.min(policy.baseMs * 2 ** (this.attempt - 1), policy.maxMs);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.closed) this.begin();
		}, delay);
		// 退避等待不该让一个本来要退出的进程（命令行）多活一分半。
		this.timer.unref?.();
	}

	/** `tools/list_changed` 之后重列。同一时刻只列一次，列的过程中又变了就再列一次。 */
	async refreshTools(): Promise<void> {
		if (this.refreshing) {
			this.refreshAgain = true;
			return this.refreshing;
		}
		const connection = this.connection;
		if (!connection) return;
		this.refreshing = (async () => {
			do {
				this.refreshAgain = false;
				const listed = await withTimeout(listAllTools(connection.client, this.pool.timeoutMs), this.pool.timeoutMs, `Listing tools of "${this.declared.name}"`).catch(() => null);
				// 重列失败就留着旧的：少一个新工具，好过整台服务器的工具都不见了。
				if (listed && this.connection === connection && !this.closed && this.setListed(listed)) this.pool.changed(this);
			} while (this.refreshAgain);
		})().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	/** 换上新的工具表；和原来一模一样就不换，返回有没有变。 */
	private setListed(listed: RawMcpTool[]): boolean {
		const unique = [...new Map(listed.map((raw) => [raw.name, raw])).values()];
		const signature = (tools: RawMcpTool[]) => JSON.stringify(tools.map(({ name, title, description, inputSchema, annotations }) => [name, title, description, inputSchema, annotations]));
		if (signature(unique) === signature(this.listed)) return false;
		// 换成新的对象：各会话按对象缓存它们包好的工具，旧对象认不出新表。
		this.listed = unique;
		return true;
	}

	/** 等它离开「第一次连」，最多等到 `deadline`。 */
	async settle(deadline: number): Promise<void> {
		while (this.state === "connecting" && !this.closed) {
			const left = deadline - Date.now();
			if (left <= 0) return;
			await this.nextChange(left);
		}
	}

	async client(signal?: AbortSignal): Promise<Client> {
		const deadline = Date.now() + RECONNECT_WAIT_MS;
		// oxlint-disable-next-line no-unmodified-loop-condition -- signal.aborted 由外部的 abort 改变，nextChange 会在那时返回
		while ((this.state === "connecting" || this.state === "reconnecting") && !this.closed && !signal?.aborted) {
			const left = deadline - Date.now();
			if (left <= 0) break;
			await this.nextChange(left, signal);
		}
		if (this.state === "connected" && this.connection && !this.closed) return this.connection.client;
		if (signal?.aborted) throw new Error("cancelled");
		const where =
			this.state === "reconnecting"
				? `is reconnecting (attempt ${this.attempt} of ${this.pool.reconnectPolicy.attempts})`
				: this.state === "connecting"
					? "is still starting"
					: "is not connected";
		throw new Error(`MCP server "${this.declared.name}" ${where}${this.error ? `: ${this.error}` : ""}${this.explain()}`);
	}

	explain(): string {
		if (this.state === "connected") return "";
		const tail = this.stderr ?? this.stderrOf?.();
		return tail ? `\nLast lines the server wrote to stderr:\n${tail}` : "";
	}

	private nextChange(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				this.waiters.delete(done);
				resolve();
			};
			const timer = Number.isFinite(ms) ? setTimeout(done, ms) : undefined;
			signal?.addEventListener("abort", done, { once: true });
			this.waiters.add(done);
		});
	}

	private wake(): void {
		// 每个 waiter 会把自己从集合里删掉；Set 迭代时删当前项是安全的。
		for (const waiter of this.waiters) waiter();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		if (this.state !== "failed" && this.state !== "needs-login") {
			this.error ??= `MCP server "${this.declared.name}" was disconnected`;
			this.state = "failed";
		}
		this.wake();
		await this.connection?.close();
	}
}

/** 一行以内，够写进延迟加载的目录；`instructions` 往往是几段使用说明，只取第一行。 */
function serverAbout(client: Client): string | undefined {
	const text = client.getServerVersion()?.description?.trim() || client.getInstructions()?.trim().split("\n")[0]?.trim();
	if (!text) return undefined;
	return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** 工具表也要翻页：只拿第一页，工具多的服务器会在工具表里少掉一截，而且没有人会发现。 */
export async function listAllTools(client: Client, timeoutMs: number): Promise<RawMcpTool[]> {
	const tools: RawMcpTool[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
		tools.push(...(listed.tools as RawMcpTool[]).filter(offeredToModel));
		cursor = listed.nextCursor;
		if (!cursor) break;
	}
	return tools;
}

/**
 * MCP Apps 的 `_meta.ui.visibility` 不含 `"model"`：这个工具只给服务器自己的页面调用。
 *
 * Plume 不托管 MCP Apps 页面，所以这类工具谁也用不上；放进工具表只是每轮白付它的说明书，还可能
 * 被模型拿去调一个本来不该由它调的东西。没写 `visibility`（或写得不是数组）按规范缺省 `["model", "app"]`。
 */
function offeredToModel(tool: RawMcpTool): boolean {
	const visibility = tool._meta?.ui?.visibility;
	return !Array.isArray(visibility) || visibility.includes("model");
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
