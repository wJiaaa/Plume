/**
 * 手动添加的 MCP 服务，刚建出来的样子。入口只有设置 › 插件 › MCP 标签右侧的 ⋯。
 */

import type { McpServerConfig } from "@plume/core";
import { translate } from "../../i18n/index.ts";

/** A blank server of the given kind, ready to be edited. */
export function newMcpServer(transport: "stdio" | "http"): McpServerConfig {
	const id = `mcp-${Date.now().toString(36)}`;
	return transport === "stdio"
		? { id, name: translate("mcp.newStdio"), transport: "stdio", command: "npx", args: [], enabled: true }
		: { id, name: translate("mcp.newHttp"), transport: "http", url: "https://", enabled: true };
}
