/**
 * 跑完的一轮只留回答：回答之前的过程和中途说的话收成一行（画法见 `TurnWork`）。
 *
 * 和 `turn-blocks.ts` 分开：那边定一轮里有哪几行，这里定跑完以后哪几行收起来。规则性的东西要能单独测。
 */

import type { Call } from "./grouping.ts";
import type { TurnItem } from "./turn-blocks.ts";

export interface TurnFold {
	/** 收起的第一行。它前面的（出过错的那一截）留在外面。 */
	start: number;
	/** 回答那一行。收起的是 `start` 到它之前；它和它后面的都留在外面。 */
	answer: number;
	/** 落在收起范围里、却要留在外面的行：页面预览、等人点的会话建议。它们是给人看的结果，不是过程。 */
	pinned: Set<string>;
	/** 收起的那几段活里的每一次调用，那一行用它说做了什么。 */
	calls: Call[];
	/** 收起的推理有几次。推理默认不画时早在分组时拿掉了，这里是 0。 */
	thought: number;
}

/**
 * 跑完的一轮里收起哪几行；不收就是 `null`。
 *
 * 回答是最后一句有正文的话。中途的汇报（「推送完成……」「Docker 就绪……」）长得和回答一样，位置决定它是
 * 哪一种，所以一起收进去——要的就是跑完只看见结论。回答后面还有活（被停下时没执行的调用）照旧留在后面。
 *
 * 出过事的证据不收：出错的回复、还在等或放弃了的断线，碰到就停在它后面，只收它之后的那一截。收进去的话，
 * 出过错的一轮看上去和顺利跑完的一样。没有回答、或回答之前一段活都没有的一轮，不收。
 */
export function turnFold(items: TurnItem[]): TurnFold | null {
	let answer = items.length - 1;
	while (answer >= 0 && !spoken(items[answer])) answer--;
	if (answer <= 0) return null;
	let start = answer;
	while (start > 0 && !standsOut(items[start - 1])) start--;
	const folded = items.slice(start, answer);
	if (!folded.some((item) => item.kind === "step")) return null;
	return {
		start,
		answer,
		pinned: new Set(folded.filter((item) => item.kind === "run" && item.run.kind === "tools").map((item) => item.key)),
		calls: folded.flatMap((item) => (item.kind === "step" ? item.step.calls : [])),
		thought: folded.reduce((n, item) => n + (item.kind === "step" ? item.step.members.filter((member) => member.kind === "thinking").length : reasoning(item) ? 1 : 0), 0),
	};
}

/** 一句有正文的话。收尾那句的页脚单独成的一行（`trailer`）和那句话是同一段，但它不画正文。 */
function spoken(item: TurnItem): boolean {
	if (item.kind !== "run" || item.run.kind !== "message" || item.run.trailer) return false;
	const { message, from, upTo } = item.run;
	return message.role === "assistant" && message.content.slice(from ?? 0, upTo).some((block) => block.type === "text" && block.text.trim() !== "");
}

/** 这一轮出过事的证据。 */
function standsOut(item: TurnItem): boolean {
	if (item.kind !== "run") return false;
	const { run } = item;
	if (run.kind === "hiccup") return run.hiccup.outcome === "waiting" || run.hiccup.outcome === "gave_up" || run.hiccup.outcome === "stopped";
	return run.kind === "message" && run.message.role === "assistant" && run.message.stopReason === "error";
}

/** 不在任何一段活里的一行推理：一轮开头想过、后面没等到调用。 */
function reasoning(item: TurnItem): boolean {
	if (item.kind !== "run" || item.run.kind !== "message" || item.run.message.role !== "assistant") return false;
	const { message, from, upTo } = item.run;
	return message.content.slice(from ?? 0, upTo).some((block) => block.type === "thinking");
}
