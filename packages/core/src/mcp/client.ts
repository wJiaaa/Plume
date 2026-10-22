/**
 * MCP integration.
 *
 * Each configured server is connected over stdio or streamable HTTP and every tool is exposed to the
 * agent under a `mcp__<server>__<tool>` name (`names.ts`). Each server lives in its own slot with
 * its own state — connecting, connected, reconnecting, failed — so one that is slow, broken or
 * gone never holds up another, or the session.
 *
 * The slots belong to a pool (`pool.ts`) that the host shares between its sessions; what a session
 * holds here is its view of them — which servers it asked for, and its leases on their slots.
 */

import type { McpPromptEntry } from "../commands/mcp-prompt.ts";
import type { Tool, UserContent } from "../types.ts";
import type { AskPerson } from "./elicitation.ts";
import { dedupeToolNames, qualifiedToolName } from "./names.ts";
import { McpPool, poolKey, type McpLease, type McpPoolOptions } from "./pool.ts";
import { promptContent } from "./prompts.ts";
import { withTimeout, type McpHolder, type Slot } from "./slot.ts";
import { toAgentTool, type McpToolHandle, type RawMcpTool } from "./tool.ts";
import type { McpConnection, McpServerConfig, McpServerStatus } from "./types.ts";

/*
 * The shapes of a server's configuration live in `types.ts`, apart from the client that starts them,
 * so the placeholder rules (`placeholders.ts`) can read them without importing the client that
 * imports those rules.
 */
export type { McpConnection, McpServerConfig, McpServerStatus, McpStdioServer } from "./types.ts";
export { qualifiedToolName } from "./names.ts";

export interface McpManagerOptions extends McpPoolOptions {
	/**
	 * 共用的那个池子，宿主给。不给就自己建一个只给自己用的：命令行、设置页临时连的那一下，
	 * 和每个会话各起一份时一样。给了的话，上面那几个时限和节奏以池子的为准。
	 */
	pool?: McpPool;
	/**
	 * 服务器中途要人填表时怎么问到人。给了才声明 elicitation 能力；不给的（命令行、设置页临时连的
	 * 那一下）不声明，服务器硬发来就回 decline。见 `elicitation.ts`。
	 */
	ask?: AskPerson;
	/**
	 * 后台有了变化——连上了、断了、重连上了、放弃了、工具表变了——就叫一声。会话据此重算工具表，
	 * 新的那份从下一轮起生效（见 `SessionCapabilities`）。
	 */
	onChange?: (status: McpServerStatus) => void;
}

let holders = 0;

export class McpManager implements McpHolder {
	readonly id = `mcp-holder-${++holders}`;
	readonly ask: AskPerson | undefined;
	private readonly pool: McpPool;
	/** 这一份借着的槽，按服务器 id。 */
	private leases = new Map<string, McpLease>();
	/** 最近一次 `connectAll` 给的名单：关着的服务器也要出现在状态里。 */
	private declared: McpServerConfig[] = [];
	private readonly onChange: ((status: McpServerStatus) => void) | undefined;
	/** 包好给模型的工具，按服务器列出来的那个对象：槽重列、重启之后是新对象，自然换新。 */
	private readonly built = new WeakMap<RawMcpTool, Map<string, Tool>>();
	private readonly handles = new WeakMap<Slot, McpToolHandle>();
	/**
	 * Bumped by every `closeAll`, so a replacement that was already under way when it ran can tell
	 * that it must not start anything.
	 */
	private epoch = 0;
	private disposed = false;
	/** The replacement in progress; the next one starts after it. See `connectAll`. */
	private replacing: Promise<unknown> = Promise.resolve();

	constructor(options: McpManagerOptions = {}) {
		this.pool = options.pool ?? new McpPool({ ...options, elicitation: Boolean(options.ask) });
		this.ask = options.ask;
		this.onChange = options.onChange;
	}

	get timeoutMs(): number {
		return this.pool.timeoutMs;
	}

	/**
	 * Replace every connection with ones to `servers`.
	 *
	 * Every server connects on its own, in parallel, under its own deadline. `wait` is how long to wait
	 * for them before answering: by default until each has a result — the settings page's probe and
	 * the command line want that — while a session passes 0 and lets the slow ones finish in the
	 * background (`settled` is where its first turn waits a little).
	 *
	 * One replacement at a time. Three things reload a session's capabilities — the file watcher,
	 * the end of a turn releasing a change it held back, and the desktop app saving an agent
	 * definition — and nothing kept them apart. Two replacements running together each closed what
	 * was there when they started and then both connected; the second to finish overwrote the
	 * first's connection in the map without closing it, and that server ran until the app quit.
	 */
	connectAll(servers: McpServerConfig[], options: { wait?: number } = {}): Promise<McpServerStatus[]> {
		const run = this.replacing.then(() => this.replaceAll(servers, options.wait ?? Number.POSITIVE_INFINITY));
		this.replacing = run.catch(() => {});
		return run;
	}

	private async replaceAll(servers: McpServerConfig[], wait: number): Promise<McpServerStatus[]> {
		// A reload that was queued behind the one running when the session was disposed.
		if (this.disposed) return [];
		this.declared = servers;
		/*
		 * 配置没变、连接还活着（或者正在连）的原样留下。重载多半是改了一条技能（见
		 * `AgentSession.reloadCapabilities`），跟 MCP 无关；每次都关掉重启，等于让每台服务器为一个
		 * markdown 文件冷启动一遍。改了启动配置、关过再开、失败了、正在重连的，都立刻重来——这也是
		 * 想手动重连一台服务器时的办法。
		 */
		const wanted = new Map(servers.filter((server) => server.enabled).map((server) => [server.id, server]));
		const releasing: McpLease[] = [];
		for (const [id, lease] of this.leases) {
			const next = wanted.get(id);
			if (next && poolKey(next, this) === lease.key && lease.slot.healthy()) {
				// 名字、信任开关这类不影响进程的改动，换上新的就行，不必重启。
				lease.slot.declared = next;
				continue;
			}
			releasing.push(lease);
			this.leases.delete(id);
		}
		const epoch = this.epoch;
		await Promise.all(releasing.map((lease) => this.pool.release(this, lease)));
		const mine = new Map<string, McpLease>();
		for (const server of wanted.values()) {
			let lease = this.leases.get(server.id);
			if (!lease && !this.disposed && epoch === this.epoch) {
				lease = this.pool.acquire(this, server);
				this.leases.set(server.id, lease);
			}
			if (lease) mine.set(server.id, lease);
		}
		await this.settled(wait, [...mine.values()].map((lease) => lease.slot));
		return servers.map((server) => {
			if (!server.enabled) return disabledStatus(server);
			const lease = mine.get(server.id);
			return lease ? this.statusOf(lease.slot) : { ...disabledStatus(server), state: "failed", error: `MCP server "${server.name}" was disconnected while it was still starting` };
		});
	}

	/**
	 * Connect one server and wait for the answer; throws what stopped it.
	 *
	 * The low-level step under `connectAll`, also used directly where one server is all there is.
	 */
	async connect(declared: McpServerConfig): Promise<McpConnection> {
		if (this.disposed) throw new Error(`MCP server "${declared.name}" was not started: its session has been closed`);
		const previous = this.leases.get(declared.id);
		if (previous) {
			this.leases.delete(declared.id);
			await this.pool.release(this, previous);
		}
		const lease = this.pool.acquire(this, declared);
		this.leases.set(declared.id, lease);
		await lease.slot.settle(Number.POSITIVE_INFINITY);
		const slot = lease.slot;
		if (slot.state === "connected" && slot.connection) return slot.connection;
		throw slot.failure ?? new Error(slot.error ?? `MCP server "${declared.name}" did not connect`);
	}

	/**
	 * 等还在第一次连的服务器，每台最多等到它开始连之后 `graceMs` 为止。
	 *
	 * 会话在每一轮开始前调它：刚打开的会话里，大多数服务器几百毫秒就连上了，第一句话应该用得上
	 * 它们；而一台要冷启动三分钟的服务器不该让人对着「发送中」干等三分钟——它连上以后从下一轮起
	 * 加入工具表。已经连过、正在重连的不等：它们的工具还在表里，调用时自己会等一会儿。
	 */
	async settled(graceMs = Number.POSITIVE_INFINITY, slots: Slot[] = this.slots()): Promise<void> {
		await Promise.all(slots.map((slot) => slot.settle(slot.startedAt + graceMs)));
	}

	/**
	 * 手动重连一台：关掉、计数清零、立刻重新连。共用的那条连接重连了，借着它的会话都跟着重连；
	 * 宿主要把一台服务器的每一条连接都重来，用 `McpPool.reconnect`。
	 */
	reconnect(serverId: string): Promise<void> {
		const run = this.replacing.then(async () => {
			const lease = this.leases.get(serverId);
			if (!lease || this.disposed) return;
			await this.pool.restart(lease);
		});
		this.replacing = run.catch(() => {});
		return run;
	}

	/** 它借着的一个槽状态变了。`closeAll` 以后不再报：会话已经不在听了。 */
	changed(slot: Slot): void {
		if (this.disposed || this.leases.get(slot.declared.id)?.slot !== slot) return;
		this.onChange?.(this.statusOf(slot));
	}

	/** 池子把它借着的一个槽收走了。照这份声明不再有这台服务器，会话据此重算工具表。 */
	lost(slot: Slot): void {
		const id = slot.declared.id;
		if (this.leases.get(id)?.slot !== slot) return;
		this.leases.delete(id);
		this.declared = this.declared.filter((server) => server.id !== id);
		if (!this.disposed) this.onChange?.(disabledStatus(slot.declared));
	}

	private slots(): Slot[] {
		return [...this.leases.values()].map((lease) => lease.slot);
	}

	/**
	 * Every tool from every server that has (or, while it reconnects, had) a connection, ready to hand
	 * to the agent loop.
	 *
	 * 按名字排序，不按连接完成的先后：工具表在提示缓存前缀的最前面，服务器谁先连上每次都可能不同，
	 * 顺序一变整个前缀就失效。名字以 `mcp__<服务器>__` 开头，所以这也是按服务器、再按工具排。
	 *
	 * `reserved` 是宿主已经占用的名字：撞上的 MCP 工具换成带哈希的名字，不覆盖、也不被覆盖。
	 */
	allTools(reserved: ReadonlySet<string> = new Set()): Tool[] {
		return this.named(reserved)
			.map(({ slot, raw, name }) => this.tool(slot, raw, name))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	private named(reserved: ReadonlySet<string> = new Set()): { slot: Slot; raw: RawMcpTool; name: string }[] {
		const entries = this.slots()
			.filter((slot) => slot.offersTools())
			.flatMap((slot) => slot.listed.map((raw) => ({ slot, raw, serverId: slot.declared.id, toolName: raw.name, name: qualifiedToolName(slot.declared.id, raw.name) })));
		const names = dedupeToolNames(entries, reserved);
		return entries.map((entry, index) => ({ slot: entry.slot, raw: entry.raw, name: names[index]! }));
	}

	/** 工具按会话包：调用记在这个会话名下，服务器中途反问时才知道该问谁（`McpPool.askFor`）。 */
	private tool(slot: Slot, raw: RawMcpTool, name: string): Tool {
		let byName = this.built.get(raw);
		if (!byName) {
			byName = new Map();
			this.built.set(raw, byName);
		}
		let tool = byName.get(name);
		if (!tool) {
			tool = toAgentTool(this.handle(slot), raw, name);
			byName.set(name, tool);
		}
		return tool;
	}

	private handle(slot: Slot): McpToolHandle {
		let handle = this.handles.get(slot);
		if (!handle) {
			handle = {
				config: () => slot.declared,
				client: (signal) => slot.client(signal),
				callTimeoutMs: this.pool.callTimeoutMs,
				explain: () => slot.explain(),
				describe: () => slot.about,
				track: (run) => slot.track(this, run),
			};
			this.handles.set(slot, handle);
		}
		return handle;
	}

	private connected(): McpConnection[] {
		return this.slots().flatMap((slot) => (slot.state === "connected" && slot.connection ? [slot.connection] : []));
	}

	/** 每台连着的服务器提供的 prompt，给 `/` 菜单。按名字排，和工具一样不随连接先后变。 */
	allPrompts(): McpPromptEntry[] {
		return this.connected()
			.flatMap((c) => c.prompts)
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	/**
	 * 取一个 prompt 展开后的内容，作为一条用户输入发出去。
	 *
	 * 参数在这之前已经对过（`bindPromptArguments`），这里不再猜；服务器嫌参数不对会回错误，原样抛给
	 * 调用的人——那是能据以改正的一句话。
	 */
	async getPrompt(name: string, args: Record<string, string>): Promise<UserContent[]> {
		const wanted = name.toLowerCase();
		for (const connection of this.connected()) {
			const entry = connection.prompts.find((prompt) => prompt.name.toLowerCase() === wanted);
			if (!entry) continue;
			const result = await connection.client.getPrompt({ name: entry.prompt, arguments: args }, { timeout: this.timeoutMs });
			const content = promptContent(result.messages);
			if (content.length === 0) throw new Error(`MCP prompt "${entry.prompt}" 没有返回任何内容。`);
			return content;
		}
		throw new Error(`没有连着的 MCP 服务器提供 "${name}"。`);
	}

	/**
	 * 每台服务器声明的资源，给 `mcp://`。
	 *
	 * 一台服务器不支持 resources 是**正常**的（协议里它是可选的），所以拿不到就当没有：
	 * 一台服务器把整个列表变成错误，会让另外三台的资源也跟着不可见。每次现列，不缓存——
	 * 所以 `resources/list_changed` 不需要做任何事。
	 */
	async allResources(): Promise<{ server: string; uri: string; name?: string; description?: string }[]> {
		const perServer = await Promise.all(
			this.connected().map(async (connection) => {
				const listed = await withTimeout(connection.client.listResources(), this.timeoutMs, `Listing resources of "${connection.config.name}"`).catch(() => null);
				return (listed?.resources ?? []).map((resource) => ({
					server: connection.config.id,
					uri: String(resource.uri),
					name: typeof resource.name === "string" ? resource.name : undefined,
					description: typeof resource.description === "string" ? resource.description : undefined,
				}));
			}),
		);
		return perServer.flat();
	}

	/**
	 * 读一个资源。
	 *
	 * 一个资源可以有多段内容（协议允许），拼起来给模型——挑第一段会静默丢掉后面的，
	 * 而「只读到了一部分」是这里最难被发现的一种错。二进制段跳过：它进不了文本上下文，
	 * 而把 base64 塞进去只会烧掉一屏 token。
	 */
	async readResource(serverId: string, uri: string): Promise<string> {
		const connection = this.connected().find((one) => one.config.id === serverId);
		if (!connection) throw new Error(`没有连着叫 "${serverId}" 的 MCP 服务器。`);

		const result = await withTimeout(connection.client.readResource({ uri }), this.timeoutMs, `Reading ${uri}`);
		const parts = (result.contents ?? [])
			.map((part) => (typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : null))
			.filter((text): text is string => text !== null);

		if (parts.length === 0) throw new Error(`${uri} 没有可读的文本内容（可能是二进制资源）。`);
		return parts.join("\n\n");
	}

	/** Every configured server's state, in the order they were configured. */
	statuses(): McpServerStatus[] {
		const out: McpServerStatus[] = [];
		const seen = new Set<string>();
		for (const server of this.declared) {
			seen.add(server.id);
			const lease = this.leases.get(server.id);
			if (lease) out.push(this.statusOf(lease.slot));
			else if (!server.enabled) out.push(disabledStatus(server));
		}
		for (const slot of this.slots()) if (!seen.has(slot.declared.id)) out.push(this.statusOf(slot));
		return out;
	}

	private statusOf(slot: Slot): McpServerStatus {
		const server = slot.declared;
		const tools = slot.offersTools()
			? this.named()
					.filter((entry) => entry.slot === slot)
					.map(({ raw, name }) => ({ name, description: raw.description ?? raw.name }))
			: [];
		const connection = slot.state === "connected" ? slot.connection : undefined;
		return {
			id: server.id,
			name: server.name,
			origin: server.origin,
			state: slot.state,
			toolCount: tools.length,
			tools,
			...(connection ? { prompts: connection.prompts } : {}),
			...(connection?.signedIn ? { signedIn: true } : {}),
			...(slot.error && slot.state !== "connected" ? { error: slot.error } : {}),
			...(slot.stderr && slot.state !== "connected" ? { stderr: slot.stderr } : {}),
			...(slot.attempt > 0 && slot.state !== "connected" ? { attempt: slot.attempt } : {}),
			...(slot.missing ? { missing: slot.missing } : {}),
		};
	}

	async closeAll(): Promise<void> {
		this.epoch += 1;
		const open = [...this.leases.values()];
		this.leases = new Map();
		await Promise.all(open.map((lease) => this.pool.release(this, lease)));
	}

	/**
	 * Let go of the servers `match` picks, and forget them. A connection closes once nobody else holds
	 * it — every live session doing this closes it; `McpPool.disconnect` closes it outright.
	 *
	 * For when their files are about to change — an MCP bundle being updated or uninstalled. On
	 * Windows a running server holds its own executable and modules open, and nothing in its
	 * directory can be moved or deleted until it stops. Queued behind a replacement in progress, so a
	 * server that replacement is still connecting is let go as well, not registered a moment after
	 * this returned.
	 */
	disconnect(match: (server: McpServerConfig) => boolean): Promise<McpConnection[]> {
		const run = this.replacing.then(async () => {
			const closing = [...this.leases.values()].filter((lease) => match(lease.slot.declared));
			for (const lease of closing) this.leases.delete(lease.slot.declared.id);
			this.declared = this.declared.filter((server) => !match(server));
			await Promise.all(closing.map((lease) => this.pool.release(this, lease)));
			return closing.flatMap((lease) => (lease.slot.connection ? [lease.slot.connection] : []));
		});
		this.replacing = run.catch(() => {});
		return run;
	}

	/**
	 * Close everything, for good.
	 *
	 * Separate from `closeAll`, which a reload also uses: a reload that was already queued when the
	 * session went away would otherwise start every server again, for a session nobody will close.
	 */
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.closeAll();
	}
}

function disabledStatus(server: McpServerConfig): McpServerStatus {
	return { id: server.id, name: server.name, origin: server.origin, state: "disabled", toolCount: 0, tools: [] };
}
