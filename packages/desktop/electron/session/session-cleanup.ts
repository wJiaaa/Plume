/**
 * 会话记录占了多少地方，以及怎么把一段时间的删掉。
 *
 * 删的是聊天记录本身，**花掉的钱不跟着删**：每一次调用的用量另记在会话库的 `spend` 表里，
 * 用量页的总额读的是那张表，删会话动不到它（见 core 的 `session/spend.ts`）。所以这里能收回的
 * 只有空间，不能把账抹掉——一个叫「清除」的按钮让已经付过的钱从统计里消失，账就对不上服务商了。
 *
 * 删除的单位是一整条会话，不是某几条消息。一条会话的用量摊在它活跃的每一天上，按天把中间几段
 * 剜掉，留下的是一份读不通的对话和一份仍然对不上的账——两样都不值得要。所以时间范围筛的是
 * 「最后活动时间」：一条八月建、昨天还在写的会话，属于昨天。
 */

import type { SessionMeta, SessionStorage } from "@plume/core";
import type { ClearRange, ClearResult, StorageDay, StorageUse } from "@plume/contract";

/** 本地日期键，和用量页、扫描器用的是同一个口径——不是 ISO/UTC。 */
export function dayKey(ms: number): string {
	const date = new Date(ms);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** 落在这一段里吗。两头都含当天，空的那头表示不设限。 */
export function withinRange(meta: Pick<SessionMeta, "updatedAt">, range: ClearRange): boolean {
	const day = dayKey(meta.updatedAt);
	if (range.from && day < range.from) return false;
	if (range.to && day > range.to) return false;
	return true;
}

/**
 * 会话记录一共占多少，按最后活动的那一天摊开。
 *
 * 数的是记录本身，不是整个库文件：库里还有花销表和空闲页，那些删会话收不回来，算进来会让
 * 「删了却没少多少」变成常态。每条会话摊到它最后活动的那一天上，因为删除正是按这一天筛的。
 */
export async function storageUse(store: SessionStorage): Promise<StorageUse> {
	const sessions = await store.listSessions();
	const sizes = await store.sizes();
	const byDay = new Map<string, StorageDay>();
	let bytes = 0;
	for (const meta of sessions) {
		const size = sizes[meta.id] ?? 0;
		const day = dayKey(meta.updatedAt);
		const seen = byDay.get(day) ?? { day, sessions: 0, bytes: 0 };
		seen.sessions += 1;
		seen.bytes += size;
		bytes += size;
		byDay.set(day, seen);
	}
	const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
	return {
		bytes,
		sessions: sessions.length,
		earliest: days[0]?.day ?? null,
		latest: days[days.length - 1]?.day ?? null,
		days,
	};
}

/**
 * 把这一段里的会话删掉，连同它们写在项目外的东西。
 *
 * 正在跑的会话跳过，不打断。删一条正在执行工具调用的会话，省下的那几兆远不如它正在写的东西
 * 值钱。跳过几条要在结果里报出来，不能让它们无声地留下。
 *
 * 哪些在跑、删哪些，由 `remove` 一步决定并返回删掉的那些。判断和删除中间隔着一次 `await`，
 * 就有一个请求恰好在这时开始、随后连同会话一起被删掉（见主进程的 `deleteIdleSessions`）。
 *
 * 先量大小再删：删完之后记录就不在了，那时候再量得到的是 0，释放量会报成一片零。
 */
export async function clearSessions(
	store: SessionStorage,
	range: ClearRange,
	remove: (sessionIds: string[]) => Promise<string[]>,
): Promise<ClearResult> {
	const sizes = await store.sizes();
	const matched = (await store.listSessions()).filter((meta) => withinRange(meta, range));
	if (matched.length === 0) return { removed: 0, freed: 0, skipped: 0 };

	const removed = await remove(matched.map((meta) => meta.id));
	const freed = removed.reduce((sum, id) => sum + (sizes[id] ?? 0), 0);

	return { removed: removed.length, freed, skipped: matched.length - removed.length };
}
