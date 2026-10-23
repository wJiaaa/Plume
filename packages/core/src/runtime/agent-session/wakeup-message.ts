/**
 * 定时唤醒到点时送进对话的那条消息（`session-wakeups.ts`）。
 *
 * 要说清三件事：它不是人说的话，是模型自己留的；是哪一个任务；还会不会再来。最后一件最要紧——
 * 模型不知道这是最后一次，就会接着等一个不会再来的唤醒；不知道还会再来，就会自己再排一个，一件事
 * 被盯两遍。
 *
 * `delivery` 给界面画成一行「定时唤醒 · 理由」，和后台结果送达同一种过程行，不是一个人发的气泡。
 */

import type { SessionWakeup } from "../../agent/events.ts";
import type { Message } from "../../types.ts";

/** 本地时间，带时区偏移：`2026-10-23 14:05 (UTC+08:00)`。模型据此和用户说「两点零五分」时不必换算。 */
export function localTime(ms: number): string {
	const date = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const zone = `UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} (${zone})`;
}

/** 给人看的那一句：唤醒写了理由用理由，否则是 prompt 的第一行。 */
function wakeupLabel(wakeup: Pick<SessionWakeup, "reason" | "prompt">): string {
	const line = wakeup.reason?.trim() || (wakeup.prompt.split("\n").find((one) => one.trim()) ?? "").trim();
	return [...line].length > 80 ? `${[...line].slice(0, 79).join("")}…` : line;
}

/**
 * `next` 是下一次触发，null 表示这是最后一次（一次性的，或循环任务过期前的最后一次）。
 * `skipped` 是上一次送达之后因为那一轮还没结束而跳过的次数。
 */
export function wakeupMessage(wakeup: SessionWakeup, info: { next: number | null; skipped: number }): Message {
	const lead = wakeup.kind === "wakeup"
		? `（运行时送达）你之前用 schedule_wakeup 安排的唤醒到点了（id="${wakeup.id}"${wakeup.reason ? `，理由：${wakeup.reason}` : ""}）。`
		: `（运行时送达）你之前用 cron_create 建的定时任务到点了（id="${wakeup.id}"，cron="${wakeup.cron}"${wakeup.recurring ? `，第 ${wakeup.fired} 次触发` : ""}）。`;
	const own = "它不是用户说的话，是你自己留下的：照下面的内容接着做，做完照常回复用户。";
	const skipped = info.skipped > 0 ? `上一次触发开的那一轮还没结束时它又到点了 ${info.skipped} 次，那几次跳过了。` : "";
	const after = !wakeup.recurring
		? wakeup.kind === "wakeup"
			? "这是一次性的，之后不会再唤醒你；还要再等，就再调用一次 schedule_wakeup。"
			: "这是一次性的（recurring: false），触发这一次后已经删掉。"
		: info.next === null
			? "这是它过期前的最后一次触发，之后不会再唤醒你。事情还没办完的话，告诉用户，或者用 cron_create 重新建一个。"
			: `下一次在 ${localTime(info.next)}；它在 ${localTime(wakeup.expiresAt ?? info.next)} 过期，之后不再触发。要等的事办完了就用 cron_delete 删掉它，不要让它空转。`;
	return {
		role: "user",
		synthetic: true,
		timestamp: Date.now(),
		delivery: [{ id: wakeup.id, kind: "wakeup", agent: "", description: wakeupLabel(wakeup), status: "done", ...(wakeup.cron ? { command: wakeup.cron } : {}) }],
		content: [
			{ type: "text", text: [lead, own, skipped, after].filter(Boolean).join("") },
			{ type: "text", text: `<wakeup id="${wakeup.id}">\n${wakeup.prompt}\n</wakeup>` },
		],
	};
}
