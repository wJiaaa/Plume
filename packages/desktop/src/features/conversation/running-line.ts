/**
 * 运行行该不该露面、怎么读数：这一轮跑了多久，末尾在流的正文是不是该让它让开。
 * 词表与小球的状态在 `lib/thinking-words.ts`。
 */

import type { Message } from "@plume/core/client-types";

/** 这一轮跑了多久：`42s`、`3m 05s`、`1h 12m`。 */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		return `${hours}h ${minutes % 60}m`;
	}
	return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/**
 * 末尾正在流的这段正文像不像结论。像，运行行就让开：挂在结论底下，字每折一行它就往下跳一行。
 *
 * 流到一半没有确定的信号：只有 OpenAI 的 Responses 会把开场白标成 `commentary`，别的接口不标，
 * 中转网关还会把开场白标成 `final_answer`。所以看长相。2026-10 在本机 1447 条开场白、410 条结论上量过：
 * 开场白中位 58 字、含换行的 1%；结论中位 885 字、含换行的 89%。按「出现换行或超过 150 字」判，
 * 开场白误判 2.8%（工具调用一到就回来），结论多半写到第一段末尾（中位第 73 个字）就判出来——
 * 一行能放六七十个字，判出来之前最多跳一两下。没长到这个地步的短回答本来也跳不了几下。
 */
export const ANSWER_CHARS = 150;

export function looksLikeAnswer(messages: Message[]): boolean {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant" || last.stopReason !== "pending") return false;
	const block = last.content[last.content.length - 1];
	// 标了 commentary 的一定是开场白，这一个信号是确定的。
	if (block?.type !== "text" || block.phase === "commentary") return false;
	const text = block.text.trim();
	return text.includes("\n") || text.length > ANSWER_CHARS;
}

/**
 * 末尾在流的是这一轮第一次调工具之前的话：不管它是结论还是开场白，桌面的运行行都让开。
 *
 * `looksLikeAnswer` 不在第一个字就判，运行行就挂在这句话底下，第一个字一来它被推下去一行——逐字显现
 * 的字那时还是透明的，看上去是它跳进了一片空白。2026-10 本机 651 个人开的轮次：纯回答 13.5%，开场白
 * 后调工具 51%。后一种让开之后是开场白写在它原来的位置、调用开始时它在下面淡入回来，原来是跳两次，
 * 所以两种一起让。只管第一次调工具之前：之后每批调用之间的话都让的话，它就围着每一批调用出没。
 *
 * 往回找到人开口的那条为止。中途插进来的送达不算开口，越过去接着找。
 */
export function leadsTheTurn(messages: Message[]): boolean {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant" || last.stopReason !== "pending") return false;
	const block = last.content[last.content.length - 1];
	if (block?.type !== "text" || !block.text.trim()) return false;
	for (let at = messages.length - 1; at >= 0; at--) {
		const message = messages[at];
		if (message.role === "user" && !message.delivery) return true;
		if (message.role === "assistant" && message.content.some((part) => part.type === "toolCall")) return false;
	}
	return true;
}
