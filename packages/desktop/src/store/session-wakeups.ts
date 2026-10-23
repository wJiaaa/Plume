import { create } from "zustand";
import type { SessionWakeup } from "@plume/core";
import { bridge } from "../services/index.ts";

/**
 * 每个会话里模型安排的定时唤醒（`schedule_wakeup`、`cron_*`），还没触发的那些。
 *
 * 放在 `store/`：`apply-event.ts` 按 `wakeups` 事件写，环境卡片那一节和标题栏按钮上的圆点读——跨了层。
 * 表在主进程的会话内存里（core 的 `session-wakeups.ts`），这里只是它最近一次推过来的样子；窗口刚开、
 * 没听到过事件的会话用 `attachWakeups` 问一次。
 */

const NONE: SessionWakeup[] = [];

export const useWakeups = create<{ bySession: Record<string, SessionWakeup[]> }>(() => ({ bySession: {} }));

export function setWakeups(sessionId: string, wakeups: SessionWakeup[]): void {
	useWakeups.setState((state) => ({ bySession: { ...state.bySession, [sessionId]: wakeups } }));
}

/** 读一个会话的；没有就是同一个空数组，订阅它的组件不会因为每次一个新的 `[]` 重画。 */
export function wakeupsOf(state: { bySession: Record<string, SessionWakeup[]> }, sessionId: string | null | undefined): SessionWakeup[] {
	return (sessionId && state.bySession[sessionId]) || NONE;
}

/** 问主进程要一次。会话没起来就是空的：表只活在会话的内存里。问不到就照旧，下一次事件会带来整张表。 */
export function attachWakeups(sessionId: string): void {
	void Promise.resolve()
		.then(() => bridge.wakeups.list(sessionId))
		.then((wakeups) => setWakeups(sessionId, wakeups), () => {});
}

/**
 * 取消一个。取消了，主进程会把新表推过来；这里不先改本地，免得两边说的不一样。没取消掉（刚好触发了）
 * 就再问一次，手里那张可能已经旧了。
 */
export async function cancelWakeup(sessionId: string, wakeupId: string): Promise<boolean> {
	const done = await bridge.wakeups.cancel(sessionId, wakeupId);
	if (!done) attachWakeups(sessionId);
	return done;
}
