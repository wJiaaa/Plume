import { create } from "zustand";
import { bridge } from "../services/index.ts";

/**
 * 每个会话里还在跑的 `monitor` 有几个。它和定时唤醒一样会自己叫醒会话，所以卡片收着时按钮上也要亮点；
 * 普通后台命令不算——开着一个 dev server 是常态，算进去圆点就一直亮着，什么也不说明。
 *
 * `apply-event.ts` 按 `monitors` 事件写。窗口刚开、会话刚换过来时没听到过事件，用 `attachMonitors` 问一次。
 */

export const useMonitors = create<{ bySession: Record<string, number> }>(() => ({ bySession: {} }));

export function setMonitors(sessionId: string, running: number): void {
	useMonitors.setState((state) => ({ bySession: { ...state.bySession, [sessionId]: running } }));
}

export function monitorsOf(state: { bySession: Record<string, number> }, sessionId: string | null | undefined): number {
	return (sessionId && state.bySession[sessionId]) || 0;
}

/** 问不到就照旧：下一次事件会带来准数。 */
export function attachMonitors(sessionId: string): void {
	void Promise.resolve()
		.then(() => bridge.services.list(sessionId))
		.then(({ jobs }) => setMonitors(sessionId, jobs.filter((job) => job.kind === "monitor" && job.finishedAt === undefined).length), () => {});
}
