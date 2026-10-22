import type { SessionStorage } from "@plume/core";

type Loaded = Awaited<ReturnType<SessionStorage["load"]>>;

/*
 * 一个没在跑的会话，整份历史读一次，给同时来问的几个只读问题共用。
 *
 * 首次点开时，上下文读数和本轮交付前后脚都要它；各读各的，就是同一份 5MB 历史在主进程上解析两遍
 * （各 15ms）。只留最近一份、几秒后放掉：留着的是整份消息，而两个问题的答案各自另有缓存。
 */
const HOLD_MS = 5000;
let held: { key: string; reading: Promise<Loaded> } | null = null;

export function loadStoredHistory(store: SessionStorage, sessionId: string, seq: number): Promise<Loaded> {
	const key = `${sessionId}:${seq}`;
	if (held?.key === key) return held.reading;
	const entry = { key, reading: store.load(sessionId) };
	held = entry;
	const release = () => {
		if (held === entry) held = null;
	};
	setTimeout(release, HOLD_MS).unref();
	entry.reading.catch(release);
	return entry.reading;
}
