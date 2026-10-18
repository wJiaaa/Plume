/**
 * 一条回复里哪些话算数，两个进程都要问，所以单独一个不碰 Node 的模块，渲染进程从 `@plume/core/reply-text` 拿。
 */

import type { AssistantContent } from "./types/message.ts";

/**
 * 这一块是不是被同一条回复里的最终答复重说过了。
 *
 * Responses 的模型在一次回复里先发几段 `commentary`（「已收到…」「我会等…」），收尾再发一段
 * `final_answer`，而最终答复按设计要能单独读懂，会把前面播报的原样再写一遍。两段都当正文用，
 * 界面上就是整段话说两遍，交给上级会话、命令行的答复也跟着翻倍。
 *
 * 只在同一条消息里有写了字的 `final_answer` 时才算：调工具前的那句播报后面跟的是工作不是答复，
 * 它就是这一步唯一的一句话，拿掉就没了；答复刚开头、还一个字没有时也先留着播报，不让正文空一下。
 * 没有 `phase` 的块（旧会话、别的协议）一律不算。
 */
export function restated(block: AssistantContent, content: readonly AssistantContent[]): boolean {
	if (block.type !== "text" || block.phase !== "commentary") return false;
	return content.some((other) => other.type === "text" && other.phase === "final_answer" && other.text.trim() !== "");
}
