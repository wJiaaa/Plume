import { useApp } from "./index.ts";
import { sessionTitle } from "../lib/session-title.ts";

const PEER_REF = /^(.*?)\s*\[([0-9a-f]{6,12})\]$|^([0-9a-f]{6,12})$/i;

/**
 * 地址里的名字：`修登录 [a1b2c3]` 画成「修登录」，ref 是给模型认人的。
 *
 * ref 对得上本机的会话时说它现在的标题：模型常只写 ref，地址里的名字也可能是改名之前抄的。ref 是 id
 * 去掉横线的前几位（`electron/peer/peer-address.ts` 的 `peerRef`）。对不上、或那个会话还没有标题，
 * 才退回地址里的名字，再退回 ref 本身。
 */
export function peerName(address: string): string {
	const parsed = PEER_REF.exec(address);
	if (!parsed) return address;
	const ref = (parsed[2] ?? parsed[3])!.toLowerCase();
	const titled = useApp.getState().sessions.filter((session) => session.id.replace(/-/g, "").toLowerCase().startsWith(ref));
	const title = titled.length === 1 ? titled[0]!.title.trim() : "";
	return (title && sessionTitle(title) === title ? title : parsed[1]) || address;
}
