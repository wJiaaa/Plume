/**
 * 设置页 MCP 卡片上的「登录」「退出登录」「重新连接」。
 *
 * 登录在主进程里走完（`loginMcpServer`：本机回调、系统浏览器、换令牌），令牌进 vault。之后要让
 * 已经连着、或者正卡在「需要登录」的那几处换上新状态：活着的会话断开这台服务器再重载能力，设置页
 * 探测记着的那份丢掉。
 */

import { forgetTokens, loginMcpServer, usesOAuth, type McpServerConfig } from "@plume/core";
import { ipcMain } from "electron";
import { settings } from "../app-settings.ts";
import { forgetProbe } from "../capabilities/mcp-probe.ts";
import { mcpPool, sessions } from "../session/session-hub.ts";
import { openExternalSafely } from "../app/window-security.ts";

type Outcome = { ok: true } | { ok: false; error: string };

/**
 * 把这台服务器的连接整个关掉，再让每个会话重载一遍：用的令牌变了，配置却没变，`connectAll` 自己看不出来。
 *
 * 先在池子上一次关完，再重载。逐个会话「断开、重载」时，先重载的会话会接上另一个会话还拿着的旧连接，
 * 用的还是旧令牌。
 */
async function reconnect(server: McpServerConfig): Promise<void> {
	forgetProbe(server);
	await mcpPool.disconnect((one) => one.id === server.id);
	await Promise.allSettled([...sessions.values()].map((session) => session.reloadCapabilities()));
}

function find(serverId: string): McpServerConfig | undefined {
	return settings().mcpServers.find((server) => server.id === serverId);
}

export function registerMcpAuthIpc(): void {
	ipcMain.handle("plugins:mcpLogin", async (_event, serverId: string): Promise<Outcome> => {
		const server = find(serverId);
		if (!server || !usesOAuth(server)) return { ok: false, error: `No OAuth MCP server "${serverId}"` };
		try {
			await loginMcpServer(server, {
				open: (url) => {
					if (!openExternalSafely(url)) throw new Error(`Refused to open ${url}`);
				},
			});
			await reconnect(server);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	/*
	 * 「重新连接」：只动这一台，不重载整个会话的能力——技能、插件、扩展都与它无关。重连在后台进行，
	 * 设置页看到「连接中」会自己再问几次（见 `McpSettings`）。
	 */
	ipcMain.handle("plugins:mcpReconnect", async (_event, serverId: string): Promise<void> => {
		const server = find(serverId);
		if (!server) return;
		forgetProbe(server);
		// 在池子上重连一次：逐个会话叫，共用的那条连接会被重启好几遍。
		await mcpPool.reconnect(serverId);
	});

	ipcMain.handle("plugins:mcpLogout", async (_event, serverId: string): Promise<Outcome> => {
		const server = find(serverId);
		if (!server || !usesOAuth(server)) return { ok: false, error: `No OAuth MCP server "${serverId}"` };
		await forgetTokens(server);
		await reconnect(server);
		return { ok: true };
	});
}
