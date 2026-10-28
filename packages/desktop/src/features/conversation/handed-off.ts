import type { SessionActivity } from "@plume/core/activity";

export interface HandedOff {
	id: string;
	title: string;
	activity: SessionActivity;
}

/**
 * 这个会话交出去、此刻值得在输入框上方说一声的会话：计划交接、建议的新会话、审阅会话，都是
 * `spawnedFrom` 指回这里的那些。
 *
 * 在跑、在等人的要说；跑完、出错的留到人点进去看过为止——`done`/`failed` 本来就是「你还没看」，
 * 打开那个会话时清掉，这一行跟着走。什么也没发生过的（`null`）不占地方。
 */
export function handedOffFrom(
	sessions: readonly { id: string; title: string; spawnedFrom?: { sessionId: string } }[],
	activity: Readonly<Record<string, SessionActivity>>,
	parentId: string | null,
): HandedOff[] {
	if (!parentId) return [];
	const out: HandedOff[] = [];
	for (const session of sessions) {
		const state = activity[session.id];
		if (session.spawnedFrom?.sessionId === parentId && state) out.push({ id: session.id, title: session.title, activity: state });
	}
	return out;
}
