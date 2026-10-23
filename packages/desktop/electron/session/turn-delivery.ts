import { undoFileChangeBatches, type Message, type SessionStorage } from "@plume/core";
import { sessions } from "./session-hub.ts";

import type { TurnDelivery } from "@plume/contract";
import { changedFiles, collectDelivery, deliveryMessages, recordedChanges } from "./delivery-record.ts";
import { storedTurn } from "./stored-readings.ts";

async function turnOf(store: SessionStorage, sessionId: string, timestamp: number): Promise<{ cwd: string; turn: Message[] }> {
	const live = sessions.get(sessionId);
	const meta = live?.meta ?? (await store.get(sessionId));
	if (!meta) throw new Error("会话不存在");
	const turn = live ? deliveryMessages(live.messages, timestamp) : await storedTurn(store, sessionId, meta.seq, timestamp);
	if (!turn) throw new Error("会话记录不存在");
	return { cwd: meta.cwd, turn };
}
export async function sessionDelivery(store: SessionStorage, sessionId: string, timestamp: number): Promise<TurnDelivery> {
	const { cwd, turn } = await turnOf(store, sessionId, timestamp);
	return collectDelivery(sessionId, cwd, turn, timestamp);
}
/**
 * Undo the turn's changes to one file, or to every file it lists, and answer with the turn as it now
 * stands. Whether a file can be undone is left to `undoFileChangeBatches`, which checks it again
 * before writing anyway — asked here first, its specific reason used to be replaced by a generic one.
 */
export async function undoDeliveryFile(store: SessionStorage, sessionId: string, timestamp: number, path?: string): Promise<TurnDelivery> {
	const { cwd, turn } = await turnOf(store, sessionId, timestamp);
	if ([...sessions.values()].some((session) => session.cwd === cwd && session.running)) throw new Error("项目仍有任务运行，请结束后再撤销");
	// The files the card lists, the same way it lists them.
	const listed = changedFiles((await recordedChanges(sessionId, turn)).groups).filter((file) => path === undefined || file.path === path);
	await undoFileChangeBatches(cwd, listed.map((file) => file.changes));
	return collectDelivery(sessionId, cwd, turn, timestamp);
}
