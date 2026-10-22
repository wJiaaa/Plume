/**
 * Load a background pane's transcript without stealing the live slot.
 *
 * A restored four-pane window only `openSession`s the focused one. The others would sit on a
 * skeleton until clicked, which is the hitch the recording does not have — Codex's other panes
 * already show their chat. This writes the cache `SessionScope` reads, and refuses to touch
 * `activeSessionId`.
 */

import type { SessionMeta } from "@plume/core";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { readSideSession } from "../../store/session-read.ts";
import { useSubAgents } from "../../store/subAgents.ts";

export async function warmSession(meta: SessionMeta): Promise<void> {
	const state = useApp.getState();
	if (state.activeSessionId === meta.id) return;
	const cached = state.sessionCache[meta.id];
	if (cached && !cached.dirty && cached.messages.length > 0) return;
	// Its sub-agents too: the bar and panel in this screen show this conversation's, not the focused one's.
	void bridge.subAgents.list(meta.id).then((list) => {
		if (Array.isArray(list) && useApp.getState().activeSessionId !== meta.id) useSubAgents.getState().retain(meta.id, list);
	}).catch(() => {});
	/*
	 * 读法和侧边聊天一样：读的过程中到的事件先攒着，读完叠上去。只是读完时它若已经成了当前会话，
	 * 就不写——那时 `readSelectedSession` 正在读同一份，交给它。
	 */
	const set: Parameters<typeof readSideSession>[1] = (partial) => {
		if (useApp.getState().activeSessionId !== meta.id) useApp.setState(partial);
	};
	// A pane that cannot warm still opens when focused; a throw here would blank the workspace.
	await readSideSession(meta, set, useApp.getState).catch(() => {});
}
