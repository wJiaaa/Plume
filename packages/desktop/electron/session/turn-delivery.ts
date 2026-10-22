import { readFileChange, undoFileChangeBatches, type Message, type SessionStorage } from "@plume/core";
import { sessions } from "./session-hub.ts";

import type { TurnDelivery } from "@plume/contract";
import { collectDelivery, deliveryMessages } from "./delivery-record.ts";
import { loadStoredHistory } from "./stored-history.ts";

/*
 * 没在跑的会话，那一轮的消息读一次就记着，直到日志动了（`seq`）。
 *
 * 每次点开会话都要问一遍最后一轮交付了什么，而读出那一轮要把整份历史解析一遍——5MB 的会话在主进程上
 * 15ms，切一次会话付一次。记的只是切出来的那一小段；文件现在什么样（能不能撤销）照旧每次现查。
 */
const storedTurns = new Map<string, Message[]>();

async function storedTurn(store: SessionStorage, sessionId: string, seq: number, timestamp: number): Promise<Message[]> {
	const key = `${sessionId}:${seq}:${timestamp}`;
	const kept = storedTurns.get(key);
	if (kept) return kept;
	const messages = (await loadStoredHistory(store, sessionId, seq))?.messages;
	if (!messages) throw new Error("会话记录不存在");
	const turn = deliveryMessages(messages, timestamp);
	storedTurns.set(key, turn);
	if (storedTurns.size > 32) storedTurns.delete(storedTurns.keys().next().value!);
	return turn;
}

export async function sessionDelivery(store: SessionStorage, sessionId: string, timestamp: number): Promise<TurnDelivery> {
	const live = sessions.get(sessionId);
	const meta = live?.meta ?? (await store.get(sessionId));
	if (!meta) throw new Error("会话不存在");
	const turn = live ? deliveryMessages(live.messages, timestamp) : await storedTurn(store, sessionId, meta.seq, timestamp);
	return collectDelivery(sessionId, meta.cwd, turn, timestamp);
}
export async function undoDeliveryFile(store: SessionStorage, sessionId: string, timestamp: number, path?: string): Promise<void> {
	const delivery = await sessionDelivery(store, sessionId, timestamp);
	const files = path === undefined ? delivery.files : delivery.files.filter((entry) => entry.path === path);
	if (!files.length || files.some((file) => !file.canUndo)) throw new Error("文件没有可安全撤销的本轮改动");
	const meta = await store.get(sessionId);
	if (!meta || [...sessions.values()].some((session) => session.cwd === meta.cwd && session.running)) throw new Error("项目仍有任务运行，请结束后再撤销");
	await undoFileChangeBatches(meta.cwd, await Promise.all(files.map((file) => Promise.all(file.changeIds.map((id) => readFileChange(sessionId, id))))));
}
