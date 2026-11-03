import { activeLocale, translate } from "../../i18n/translate.ts";
import type { ResolvedUiLocale } from "../../i18n/index.ts";
import type { Message } from "@plume/core";
import { readable, spokenText } from "../../lib/spoken.ts";

export type Question = { index: number; text: string; answer: string };

/** Message indices preserve distinct targets for identical questions and attachment-only turns. */
export function questionsIn(messages: readonly Message[]) {
	const questions: Question[] = [];
	for (const [index, message] of messages.entries()) ask(message, index, questions);
	return questions;
}

/**
 * `questionsIn` 的一步。拆出来是因为 `transcript-shape.ts` 从最后一轮开头接着折，规则只写这一处。
 *
 * 回答落到最后一问上时换一份而不是原地改：接着折的那一版，前面那几问是存着、下一拍还要用的。
 */
export function ask(message: Message, index: number, questions: Question[]): void {
	if (!readable(message)) return;
	if (message.role === "assistant") {
		const question = questions.at(-1);
		const answer = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n").trim();
		if (question && answer) questions[questions.length - 1] = { ...question, answer: answer.slice(0, 600) };
		return;
	}
	if (message.role !== "user" || message.synthetic) return;
	const text = spokenText(message).trim();
	questions.push({ index, text: text || translate("questionNav.imageMessage"), answer: "" });
}

export const QUESTION_LIMIT = 15;

/** A fixed-size neighbourhood, including both ends without stretching short conversations. */
export function questionWindow(total: number, position: number) {
	const size = Math.min(QUESTION_LIMIT, total);
	const start = Math.max(0, Math.min(total - size, position - Math.floor(size / 2)));
	return { start, end: start + size };
}

export function timeSeparators(messages: readonly Message[]) {
	const result = new Set<number>();
	let previous: number | undefined;
	for (const [index, message] of messages.entries()) previous = separate(message, index, previous, result);
	return result;
}

/** `timeSeparators` 的一步：要分隔就记进 `out`，交回下一步要比的那个时刻。同 `ask`，规则只写这一处。 */
export function separate(message: Message, index: number, previous: number | undefined, out: Set<number>): number | undefined {
	if (!readable(message)) return previous;
	if (message.role === "user" && !message.synthetic) {
		if (previous === undefined || message.timestamp - previous >= 30 * 60_000 || new Date(previous).toDateString() !== new Date(message.timestamp).toDateString()) out.add(index);
	}
	return "synthetic" in message && message.synthetic ? previous : message.timestamp;
}

export function conversationTime(timestamp: number, now = Date.now(), locale: ResolvedUiLocale = activeLocale()) {
	const date = new Date(timestamp);
	const today = new Date(now);
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	const day = date.toDateString() === today.toDateString() ? translate("recency.today") : date.toDateString() === yesterday.toDateString() ? translate("recency.yesterday") : date.toLocaleDateString(locale, { month: "long", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
	// The language's own clock, so 2:28 PM in English. `numeric` rather than `hourStyle`: this label
	// has always written 9:05, not 09:05.
	return `${day} ${date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}`;
}
