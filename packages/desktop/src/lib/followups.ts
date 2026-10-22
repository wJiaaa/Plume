/**
 * 对话此刻停在哪条回复上，以及它末尾写下的下一步建议：输入框空着时的灰字，Tab 填入。
 */

import type { AssistantMessage, Message } from "@plume/core";
import { followups } from "@plume/core/followups";
import { restated } from "@plume/core/reply-text";

/**
 * 从末尾往回找最近一条回复；中间隔着人说的话就没有——人已经接过话了，那条回复的下一步不再是下一步。
 * 运行时塞进来的消息（续跑提醒、送达的报告、同伴的来信）不算人开口。
 */
function latestReply(messages: readonly Message[]): AssistantMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return message;
		if (message.role === "user" && !message.synthetic && !message.peer?.length && !message.delivery?.length) return null;
	}
	return null;
}

/** 写完了的那条回复里的下一步建议；还在写、或者停在工具调用上的不算。 */
export function nextFollowup(messages: readonly Message[]): string | undefined {
	const reply = latestReply(messages);
	if (!reply || reply.stopReason === "pending" || reply.stopReason === "toolUse") return undefined;
	const text = reply.content
		.filter((block) => block.type === "text" && !restated(block, reply.content))
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n\n");
	return followups(text)[0]?.prompt;
}
