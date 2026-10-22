/**
 * "What had happened by sequence N" — the question underneath forking from a point in the middle.
 *
 * Answered by the same replay `SessionStore.load` uses (`replayRecords`), over the records up to
 * that point. It used to be a second copy of the truncation and boundary rules, and two copies
 * would mean a fork and its source disagreeing about the same point.
 */

import { replayRecords, type CompactionMark } from "../session/replay-records.ts";
import type { SessionRecord, SessionStore } from "../session/store.ts";
import type { Message } from "../types.ts";

/** 到某一点为止仍然生效的压缩边界，以及写下它时对话走到了第几条（界面在那里画分隔线）。 */
export interface BoundaryAt {
	summary: string;
	keptFrom: number;
	markAt: number;
	before: number;
	after: number;
}

/**
 * 到某一点为止的消息，连同那一刻模型视图的起点。
 *
 * 光有消息不够：日志保留全部原文，模型看到的是「摘要 + 边界之后」，二者只差这个边界。分叉只抄
 * 消息时，新会话把压缩掉的历史整段展开重发，而保留尾部那几条回复的 usage 量的还是压缩后的小请求，
 * 计量就拿这个小数去报一个大得多的上下文。
 *
 * 其余的压缩（`dividers`）也要带走，否则分叉里那几条分隔线就没了；被取代的旧边界只作分隔线，
 * 不带 `kept`——带着的话，原会话靠截断作废的边界会在分叉里复活。
 */
export async function historyUpTo(
	store: Pick<SessionStore, "read">,
	sessionId: string,
	seq: number,
): Promise<{ messages: Message[]; boundary: BoundaryAt | null; dividers: CompactionMark[] }> {
	const records: SessionRecord[] = [];
	for await (const record of store.read(sessionId)) {
		if (record.seq > seq) break;
		records.push(record);
	}
	const { entries, compactions, compaction, boundaryMark } = replayRecords(records);
	const boundary =
		compaction && boundaryMark
			? { summary: compaction.summary, keptFrom: compaction.keptFrom, markAt: boundaryMark.at, before: boundaryMark.before, after: boundaryMark.after }
			: null;
	return {
		messages: entries.map((entry) => entry.message),
		boundary,
		dividers: compactions.filter((mark) => mark !== boundaryMark),
	};
}
