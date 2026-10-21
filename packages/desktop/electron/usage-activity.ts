/**
 * 用量页「Token 构成」「耗时构成」：会话记录回放出来的那部分（core 的 `usage-replay.ts`），按会话的
 * `seq` 增量读。
 *
 * 和 `usage-scan.ts` 的 spend 不同，这里的数随会话删掉而消失——删掉的会话不在游标里，它的行和
 * 回放状态一起扔掉。缓存单独一个文件：改价格会让 spend 那份整张重算，而这里和价格无关，不该跟着
 * 把所有记录再解析一遍。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyReplayRow, foldUsageRecord, newUsageReplayState, plumeHome, REPLAY_NUMBERS, type SessionStorage, type UsageReplayRow, type UsageReplayState } from "@plume/core";
import type { UsageActivity } from "./usage-types.ts";

/** 改了「从记录里读什么」就加一，理由同 `USAGE_CACHE_VERSION`。 */
const ACTIVITY_CACHE_VERSION = 2;

interface ActivityCache {
	version: number;
	source: string;
	cursors: Record<string, number>;
	/** 每个会话回放到哪里，下次从这里接着走。 */
	states: Record<string, UsageReplayState>;
	rows: UsageReplayRow[];
}

const keyOf = (row: Pick<UsageReplayRow, "day" | "session" | "provider" | "model">) => [row.day, row.session, row.provider, row.model].join("\u0000");

async function readCache(path: string, source: string): Promise<ActivityCache> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ActivityCache>;
		const valid =
			parsed.version === ACTIVITY_CACHE_VERSION &&
			parsed.source === source &&
			typeof parsed.cursors === "object" &&
			parsed.cursors !== null &&
			typeof parsed.states === "object" &&
			parsed.states !== null &&
			Array.isArray(parsed.rows) &&
			parsed.rows.every((row) => typeof row?.day === "string" && typeof row.session === "string" && typeof row.provider === "string" && typeof row.model === "string" && REPLAY_NUMBERS.every((key) => Number.isFinite(row[key])));
		if (valid) return parsed as ActivityCache;
	} catch {
		// 没有或读不懂：从头读。
	}
	return { version: ACTIVITY_CACHE_VERSION, source, cursors: {}, states: {}, rows: [] };
}

export async function scanActivity(store: SessionStorage, home = plumeHome()): Promise<UsageActivity[]> {
	const path = join(home, "activity-cache.json");
	const source = await store.storeId();
	const cache = await readCache(path, source);
	const sessions = await store.usageCursors();
	const live = new Map(sessions.map((session) => [session.id, session]));

	const rows = new Map<string, UsageReplayRow>();
	for (const row of cache.rows) if (live.has(row.session)) rows.set(keyOf(row), row);
	const rowOf = (key: Pick<UsageReplayRow, "day" | "session" | "provider" | "model">) => {
		const id = keyOf(key);
		let row = rows.get(id);
		if (!row) rows.set(id, (row = emptyReplayRow(key)));
		return row;
	};

	const states: Record<string, UsageReplayState> = {};
	let changed = sessions.length !== Object.keys(cache.cursors).length;
	for (const session of sessions) {
		const from = cache.cursors[session.id] ?? 0;
		const state = (states[session.id] = cache.states[session.id] ?? newUsageReplayState());
		if (session.seq <= from) continue;
		changed = true;
		for await (const record of store.usageRecords(session.id, from)) foldUsageRecord(state, session.id, record, rowOf);
	}

	if (changed) {
		const cursors = Object.fromEntries(sessions.map((session) => [session.id, session.seq]));
		// 写不下只是下次多读一遍，不值得为它让页面报错。
		await writeFile(path, JSON.stringify({ version: ACTIVITY_CACHE_VERSION, source, cursors, states, rows: [...rows.values()] }), "utf8").catch(() => {});
	}
	return [...rows.values()].map((row) => ({ ...row, archived: live.get(row.session)?.archived ?? false }));
}
