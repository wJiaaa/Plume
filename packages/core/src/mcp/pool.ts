/**
 * Who owns an MCP connection: the pool, not the session.
 *
 * Every session used to start its own copy of every configured server — eight live conversations
 * were eight sets of child processes, and a side chat was one more. The servers come from one
 * global list (`.plume/config.json` may not set `mcpServers`, see `config/layers.ts`) and a stdio
 * server is launched without the session's directory, so all those copies were the same process.
 * Now each session holds a lease on one shared slot and the last one to let go closes it.
 *
 * A server marked `perSession` still gets a slot of its own per session: one whose state lives in
 * the process (a browser it drives, an open transaction) would otherwise have two conversations
 * stepping on each other.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { commandEnv } from "../sandbox/login-path.ts";
import type { McpPromptEntry } from "../commands/mcp-prompt.ts";
import { elicitationCapability, ElicitationQueue, handleElicitation, type AskPerson } from "./elicitation.ts";
import { BackgroundOAuthProvider, usesOAuth } from "./oauth.ts";
import { resolveServer } from "./placeholders.ts";
import { listPrompts } from "./prompts.ts";
import { listAllTools, Slot, withTimeout, type McpHolder, type SlotOwner } from "./slot.ts";
import { TreeKillingStdioTransport } from "./stdio.ts";
import type { RawMcpTool } from "./tool.ts";
import type { McpConnection, McpServerConfig } from "./types.ts";

const CONNECT_TIMEOUT_MS = 30_000;

/**
 * How long the first start of a server launched through a package runner may take.
 *
 * `npx -y pkg@latest` and `uvx pkg@latest` download the package — and for a Python server its whole
 * dependency tree — the first time they are run on a machine. Measured cold: markitdown 131s,
 * mongodb 106s, grafana 60s, the first Python server about a minute. Against a 30s deadline every
 * one of those failed the first time it was switched on and worked the second, which reads as
 * "this server is broken" rather than "it was downloading". Once one start has succeeded in this
 * process the package is cached and the ordinary deadline applies again.
 */
const FIRST_RUN_TIMEOUT_MS = 180_000;
const PACKAGE_RUNNERS = new Set(["npx", "uvx", "bunx", "pnpx", "uv", "pnpm", "yarn", "pipx"]);
/** Servers that have started once in this process, by what starts them. */
const warmed = new Set<string>();

function startKey(server: McpServerConfig): string | null {
	if (server.transport !== "stdio") return null;
	const runner = server.command.split(/[\\/]/).pop()?.replace(/\.(cmd|exe)$/i, "") ?? "";
	return PACKAGE_RUNNERS.has(runner) ? JSON.stringify([server.command, ...(server.args ?? [])]) : null;
}

/** 一次工具调用多久没回复、也没进度就算超时：五分钟。见 `tool.ts`。 */
const CALL_TIMEOUT_MS = 5 * 60_000;

/**
 * 断线重连的节奏：0.5s 起翻倍，封顶 30s，最多 8 次（合计约一分半），够一台远程服务器重启、
 * 一次短暂断网。连上之后稳定 30s 才把计数清零——否则一台每次调用都崩的服务器会「重连成功、
 * 再崩、再重连」永远转下去。参数照 deepseek-harness 的 `mcp-client`。
 */
const RECONNECT = { baseMs: 500, maxMs: 30_000, attempts: 8, stableMs: 30_000 };
/** 服务器常常一口气发好几个 list_changed（每加一个工具一个），合成一次重列。 */
const LIST_CHANGED_DEBOUNCE_MS = 300;

export interface McpPoolOptions {
	/** How long connecting, and then listing tools, may each take. Tests shorten it. */
	timeoutMs?: number;
	/** 一次工具调用没有回复也没有进度时等多久。测试缩短它。 */
	callTimeoutMs?: number;
	/** 断线重连的节奏。测试缩短它。 */
	reconnect?: Partial<typeof RECONNECT>;
	/**
	 * 向服务器声明能回答 elicitation。声明与否在连接那一刻定下，之后每次反问再看问谁（`askFor`）；
	 * 问不了人的宿主（命令行、设置页临时连的那一下）不声明，服务器硬发来就回 decline。
	 */
	elicitation?: boolean;
}

/** 一个槽和借着它的人。`slot` 会换：重启是换上一个新槽，借的人不必重新借。 */
export interface McpLease {
	readonly key: string;
	slot: Slot;
	readonly holders: Set<McpHolder>;
}

export class McpPool implements SlotOwner {
	readonly timeoutMs: number;
	readonly callTimeoutMs: number;
	readonly reconnectPolicy: typeof RECONNECT;
	private readonly elicitation: boolean;
	private readonly leases = new Map<string, McpLease>();
	private readonly elicitations = new ElicitationQueue();

	constructor(options: McpPoolOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
		this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
		this.reconnectPolicy = { ...RECONNECT, ...options.reconnect };
		this.elicitation = options.elicitation === true;
	}

	/**
	 * Lend `holder` the slot for `server`, starting one if nobody has it.
	 *
	 * A slot that has failed or is backing off between reconnects is restarted rather than handed
	 * over as it is: a reload is also how somebody retries a server by hand, and that used to work
	 * per session.
	 */
	acquire(holder: McpHolder, server: McpServerConfig): McpLease {
		const key = poolKey(server, holder);
		let lease = this.leases.get(key);
		if (!lease) {
			const slot = new Slot(this, key, server);
			lease = { key, slot, holders: new Set() };
			this.leases.set(key, lease);
			slot.begin();
		} else if (!lease.slot.healthy()) {
			void this.restart(lease, server);
		} else {
			// 名字、信任开关这类不影响进程的改动，换上新的就行。
			lease.slot.declared = server;
		}
		lease.holders.add(holder);
		return lease;
	}

	/** `holder` 不再用它了；没人用了才关。 */
	async release(holder: McpHolder, lease: McpLease): Promise<void> {
		lease.holders.delete(holder);
		lease.slot.calls.delete(holder);
		if (lease.holders.size > 0 || this.leases.get(lease.key) !== lease) return;
		this.leases.delete(lease.key);
		await lease.slot.close();
	}

	/**
	 * 换上一个新槽，计数清零。
	 *
	 * 换是同步的、开始连要等旧的关完：同一时刻几个会话都在重载，第二个看到的已经是「连接中」的
	 * 新槽，不会再重启一次；而旧进程没退之前不起新的——占着端口、锁着文件的服务器起两份会失败。
	 */
	async restart(lease: McpLease, server: McpServerConfig = lease.slot.declared): Promise<void> {
		const old = lease.slot;
		const slot = new Slot(this, lease.key, server);
		lease.slot = slot;
		for (const holder of lease.holders) holder.changed(slot);
		await old.close();
		if (this.leases.get(lease.key) === lease && lease.slot === slot) slot.begin();
	}

	/** 设置页的「重新连接」、登录之后：这台服务器的每一条连接都重来，不管是谁借着。 */
	async reconnect(serverId: string): Promise<void> {
		await Promise.all([...this.leases.values()].filter((lease) => lease.slot.declared.id === serverId).map((lease) => this.restart(lease)));
	}

	/**
	 * Close the connections to the servers `match` picks, whoever holds them, and take them away from
	 * every holder.
	 *
	 * For when what they were started with is about to stop being true: an MCP bundle's files being
	 * replaced (on Windows a running server holds its own executable open), a token being swapped.
	 * Letting go session by session is not enough for the second — a session reloading while another
	 * still held the old connection would simply join it again.
	 */
	async disconnect(match: (server: McpServerConfig) => boolean): Promise<McpConnection[]> {
		const closing = [...this.leases.values()].filter((lease) => match(lease.slot.declared));
		for (const lease of closing) {
			this.leases.delete(lease.key);
			for (const holder of lease.holders) holder.lost(lease.slot);
		}
		await Promise.all(closing.map((lease) => lease.slot.close()));
		return closing.flatMap((lease) => (lease.slot.connection ? [lease.slot.connection] : []));
	}

	/** 一个槽的状态变了，告诉借着它的每一个会话。换下来的旧槽不再报。 */
	changed(slot: Slot): void {
		const lease = this.leases.get(slot.key);
		if (!lease || lease.slot !== slot) return;
		for (const holder of lease.holders) holder.changed(slot);
	}

	/**
	 * 服务器中途反问人时，问谁。
	 *
	 * 只有一个会话借着它，就问那个会话——哪怕此刻没有调用在跑，和每个会话一份连接时一样。几个会话
	 * 共用时，问正在这条连接上调用工具的那一个；没有、或者不止一个在调用，就拒绝。stdio 上的反问
	 * 不带它是为哪一次调用发的，猜错的代价是把一张表弹给另一段对话里的人，他填进去的东西交给了
	 * 别人的任务。
	 */
	private askFor(slot: Slot): AskPerson | undefined {
		const lease = this.leases.get(slot.key);
		if (!lease || lease.slot !== slot) return undefined;
		const askers = [...lease.holders].filter((holder) => holder.ask);
		if (askers.length <= 1) return askers[0]?.ask;
		const calling = askers.filter((holder) => (slot.calls.get(holder) ?? 0) > 0);
		return calling.length === 1 ? calling[0]!.ask : undefined;
	}

	/**
	 * One attempt at a connection: start the process or open the transport, initialize, list.
	 *
	 * Every way out of here that does not hand the connection over closes it.
	 */
	async open(slot: Slot): Promise<{ connection: McpConnection; listed: RawMcpTool[] }> {
		const declared = slot.declared;
		/*
		 * 空位先填上，缺值就不启动——见 `mcp/placeholders.ts`。取值的环境和启动用的是同一份（登录
		 * shell 的），所以「我在 .zshrc 里 export 过」的人不用再填一遍。
		 */
		const server = resolveServer(declared, commandEnv(process.env));
		let connection: McpConnection | undefined;
		const client = new Client(
			{ name: "plume", version: "0.1.0" },
			{
				capabilities: this.elicitation ? elicitationCapability : {},
				/*
				 * 列表变了就自己重列（翻页的那种列法），不用 SDK 自带的自动刷新：它只取第一页。
				 *
				 * 工具表的新版本不是当场换给模型：它在提示缓存前缀的最前面，改了整个前缀重算；而一轮里的
				 * 系统提示、记下来的上下文都是按这一轮开始时的工具表写的。会话在下一轮组装时读到新的那份
				 * ——见 `SessionCapabilities` 的 `onChange`。
				 */
				listChanged: {
					tools: {
						autoRefresh: false,
						debounceMs: LIST_CHANGED_DEBOUNCE_MS,
						onChanged: () => {
							if (connection && slot.connection === connection) void slot.refreshTools();
						},
					},
					prompts: {
						autoRefresh: false,
						onChanged: () => {
							void listPrompts(client, declared, this.timeoutMs)
								.then((prompts) => {
									if (connection) connection.prompts = prompts;
								})
								.catch(() => {});
						},
					},
				},
			},
		);
		handleElicitation(client, declared, this.elicitation ? () => this.askFor(slot) : undefined, this.elicitations);
		// 远程服务器、没自己配 Authorization 的，挂上 OAuth：用不上的话（服务器不回 401）它一次也不会被调用。
		const oauth = usesOAuth(server) ? await BackgroundOAuthProvider.for(server) : undefined;
		const authOptions = oauth ? { authProvider: oauth, fetch: oauth.fetch } : {};
		const transport =
			server.transport === "stdio"
				? new TreeKillingStdioTransport(server)
				: server.transport === "sse"
					? new SSEClientTransport(new URL(server.url), { requestInit: { headers: server.headers }, ...authOptions })
					: new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers }, ...authOptions });
		slot.stderrOf = transport instanceof TreeKillingStdioTransport ? () => transport.stderrTail() : undefined;

		/*
		 * A server that never answers must not hold anything up, so there is a deadline — but giving
		 * up on a promise does not stop the process behind it. The SDK's own request timeout was 60s
		 * against our 30s, and a server answering in between finished connecting a client nobody
		 * held; one that connected and then failed `tools/list` was dropped the same way. Both kept
		 * running until the app quit.
		 *
		 * The SDK is handed the same timeout so it gives up on its request when we do. Ours stays as
		 * well: it also covers what the SDK does not time — an SSE stream that opens and never sends
		 * its endpoint, the `initialized` notification over HTTP.
		 */
		const cold = startKey(declared);
		const deadline = cold && !warmed.has(cold) ? Math.max(this.timeoutMs, FIRST_RUN_TIMEOUT_MS) : this.timeoutMs;
		let listed: RawMcpTool[];
		let prompts: McpPromptEntry[];
		try {
			await withTimeout(client.connect(transport, { timeout: deadline }), deadline, `Connecting to MCP server "${server.name}"`);
			listed = await withTimeout(listAllTools(client, this.timeoutMs), this.timeoutMs, `Listing tools of "${server.name}"`);
			// 列不出 prompt 不算连接失败：工具照样能用，菜单里少几条而已。
			prompts = await withTimeout(listPrompts(client, declared, this.timeoutMs), this.timeoutMs, `Listing prompts of "${server.name}"`).catch(() => []);
		} catch (error) {
			await client.close().catch(() => {});
			throw error;
		}
		if (cold) warmed.add(cold);
		connection = {
			// 记声明本身，不记填好的那份：密钥只在启动那一刻用，不跟着连接到处传。
			config: declared,
			client,
			prompts,
			signedIn: Boolean(oauth && (await oauth.tokens())),
			close: async () => {
				await client.close().catch(() => {});
			},
		};
		return { connection, listed };
	}
}

/** 两份声明起出的进程、连到的地方是不是同一个：名字、来源、信任开关、常驻开关不算。 */
function launchOf({ name: _name, origin: _origin, trustReadOnly: _trust, pinned: _pinned, ...rest }: McpServerConfig): string {
	return JSON.stringify(rest);
}

/** 同一个键共用一个槽：启动配置一样就是同一台；每个会话独立的，再按会话分开。 */
export function poolKey(server: McpServerConfig, holder: McpHolder): string {
	const launch = launchOf(server);
	return server.perSession === true ? `${launch}\0${holder.id}` : launch;
}
