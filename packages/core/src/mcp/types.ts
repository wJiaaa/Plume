/**
 * What an MCP server's configuration looks like, and what a connection to one reports — the shapes
 * only.
 *
 * Apart from `client.ts`, which starts servers, and `placeholders.ts`, which fills in what they
 * need, because both read these and one of them calls the other: with the shapes in the client, the
 * placeholder rules imported the client that imported them. The status and connection shapes are
 * here for the same reason: the pool, its slots and the client all read them.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpPromptEntry } from "../commands/mcp-prompt.ts";

/** 一个空位，以及包对它的说明（都来自包的 manifest，见 `plugins/loader.ts`）。 */
export interface McpNeed {
	name: string;
	/** 一句话：这是什么、拿来干什么。 */
	description?: string;
	/** 去哪里申请——界面上那个「去获取」的链接。 */
	url?: string;
	/** 是不是机密。默认按名字猜（见 `looksSecret`）；连接串之类不叫 KEY 的也可以声明成机密。 */
	secret?: boolean;
	/** 可以不填：不填就当空字符串，服务照样起。 */
	optional?: boolean;
}

/**
 * Where a server's configuration came from.
 *
 * Set for one installed from a registry, absent for one somebody typed in. The distinction is
 * what lets the settings page offer 卸载 for the first and 删除 for the second, and clean up the
 * bundle's directory when the last server it brought is gone.
 *
 * It replaced a `pluginId`, which said something that is no longer true: a plugin is a bundle of
 * *skills*. A directory whose entire content is a `.mcp.json` was never a plugin — it is an MCP
 * server that arrived in a git repository, and calling it a plugin is what put the same Context7
 * in two places at once, with two switches that could not see each other.
 */
export interface McpOrigin {
	/** Directory name under `~/.plume/mcp`; also the entry's id in the registry it came from. */
	bundle: string;
	/** Which registry listed it, for telling two entries of the same name apart. */
	registry?: string;
	version?: string;
}

export interface McpStdioServer {
	id: string;
	name: string;
	transport: "stdio";
	command: string;
	args?: string[];
	/**
	 * 启动时的环境变量。值里可以有 `${NAME}` 空位，连接时填——见 `mcp/placeholders.ts`。
	 * 人在界面上填的密钥也记在这里，落盘时进保险箱（`config/settings.ts`）。
	 */
	env?: Record<string, string>;
	/** 包对它那几个空位的说明：是什么、去哪申请、能不能不填。 */
	needs?: McpNeed[];
	enabled: boolean;
	origin?: McpOrigin;
	/** 外部管理的配置只在内存合并，不能写回 settings.json。 */
	managedBy?: "magpie";
	/** 人说过信任它对工具的只读声明：`auto` 模式下，它标了 `readOnlyHint` 的工具不再逐次确认。见 `mcp/tool.ts`。 */
	trustReadOnly?: boolean;
	/** 常驻：工具多到改成延迟加载时，这台的工具仍然每轮都放在工具表里。见 `tools/mcp-search.ts`。 */
	pinned?: boolean;
	/** 每个会话各起一份，不和别的会话共用连接：给状态存在进程里的服务器。见 `mcp/pool.ts`。 */
	perSession?: boolean;
}

export interface McpHttpServer {
	id: string;
	name: string;
	transport: "http" | "sse";
	url: string;
	/** 值里可以有 `${NAME}` 空位（典型的是 `Authorization: Bearer ${TOKEN}`），连接时填。 */
	headers?: Record<string, string>;
	/**
	 * 空位的取值处：人填的令牌记在这里。不是进程环境，也不随请求发出——只用来填 URL 和请求头里
	 * 的空位。和 stdio 共用一个字段名，是为了「填密钥」在两种服务上是同一件事。
	 */
	env?: Record<string, string>;
	needs?: McpNeed[];
	enabled: boolean;
	origin?: McpOrigin;
	/** 外部管理的配置只在内存合并，不能写回 settings.json。 */
	managedBy?: "magpie";
	/** 人说过信任它对工具的只读声明：`auto` 模式下，它标了 `readOnlyHint` 的工具不再逐次确认。见 `mcp/tool.ts`。 */
	trustReadOnly?: boolean;
	/** 常驻：工具多到改成延迟加载时，这台的工具仍然每轮都放在工具表里。见 `tools/mcp-search.ts`。 */
	pinned?: boolean;
	/** 每个会话各起一份，不和别的会话共用连接：给状态存在进程里的服务器。见 `mcp/pool.ts`。 */
	perSession?: boolean;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

export interface McpServerStatus {
	id: string;
	name: string;
	origin?: McpOrigin;
	/**
	 * `connecting`：第一次连，还没有结果。`reconnecting`：连上过、断了，正在按退避重连——工具还留在
	 * 工具表里。`needs-login`：远程服务器要 OAuth 登录，后台连接走不下去了。
	 */
	state: "connecting" | "connected" | "reconnecting" | "failed" | "disabled" | "needs-login";
	/** 连上了，而且用的是 OAuth 登录来的令牌——设置页据此给「退出登录」。 */
	signedIn?: boolean;
	toolCount: number;
	error?: string;
	/** stdio 服务器 stderr 的最后几行：起不来、半路崩掉时，原因多半写在这里。 */
	stderr?: string;
	/** 重连到第几次（`reconnecting`，以及重连放弃后的 `failed`）。 */
	attempt?: number;
	/** 没启动，是因为这几个值还没填——界面据此画「去填」，而不是一段报错。 */
	missing?: string[];
	tools: { name: string; description: string }[];
	/** 它提供的 prompt，给 `/` 菜单。没连上、或服务器不提供的，没有这一项。 */
	prompts?: McpPromptEntry[];
}

export interface McpConnection {
	config: McpServerConfig;
	client: Client;
	/** 服务器说列表变了（`notifications/prompts/list_changed`）就换成新的一份。 */
	prompts: McpPromptEntry[];
	/** 用的是 OAuth 登录来的令牌。 */
	signedIn: boolean;
	close(): Promise<void>;
}
