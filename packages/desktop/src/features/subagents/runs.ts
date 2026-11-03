/**
 * The tool records for a delegated run, rebuilt from its own transcript.
 *
 * The main conversation's cards look themselves up in the app store, which is filled by
 * `tool_start` / `tool_end` as they arrive. A sub-agent's never get there: `runSubAgent` emits the
 * messages it produced and nothing else, deliberately — a delegated run that read forty files
 * would otherwise put forty tool events on the parent's wire for work the parent did not do.
 *
 * So the records are derived instead, from what the transcript already says: a call is running
 * from the reply that made it until its result arrives, and the result says how it ended. Without
 * this the cards find no record, fall back to "the turn is over, so the call must have failed",
 * and a panel full of successful work is drawn entirely in red.
 */

import type { Message } from "@plume/core";
import { routedBlock, summarizeToolCall } from "../../lib/tool-summary.ts";
import type { ToolRun } from "../../store/index.ts";

export function subAgentRuns(messages: Message[]): Record<string, ToolRun> {
	const records: Record<string, ToolRun> = {};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const raw of message.content) {
				if (raw.type !== "toolCall") continue;
				// 和主对话一样，经 `mcp_call` 转手的按真正那个工具记。
				const block = routedBlock(raw);
				records[block.id] = {
					toolCallId: block.id,
					toolName: block.name,
					summary: summarizeToolCall(block.name, block.arguments),
					args: block.arguments,
					status: "running",
					startedAt: message.timestamp,
				};
			}
		} else if (message.role === "toolResult") {
			const record = records[message.toolCallId];
			// A result for a call that was never announced belongs to no card, and inventing a record
			// for it would draw one that the transcript above does not contain.
			if (!record) continue;
			record.status = message.isError ? "error" : "done";
			record.result = {
				content: message.content,
				details: message.details,
				isError: message.isError,
			};
			record.finishedAt = message.timestamp;
		}
	}
	return records;
}

/**
 * 子智能体此刻在等模型回话：返回从哪一刻起等的，不在等就是 `undefined`。
 *
 * 子智能体的转录只收说完的消息（`sub-agent-run.ts` 只转发 `message_end`），模型在想、在写第一个字时
 * 面板上什么都没有——任务卡下面一片空白，看着像没动。主会话靠底部那行运行指示补这段空档，它只认主会话。
 *
 * 末尾是一条回复就不算在等：要么它的调用还在跑（工具卡自己在说），要么这一段已经说完了。末尾是人插的
 * 一句、而上一条回复的调用还没全部回来，也不算：插话是在调用跑着的时候送进去的，这时在跑的是工具。
 */
export function waitingSince(messages: readonly Message[]): number | undefined {
	const last = messages.at(-1);
	if (!last || last.role === "assistant") return undefined;
	const reply = messages.findLast((message) => message.role === "assistant");
	if (reply?.role === "assistant") {
		const answered = new Set(messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])));
		if (reply.content.some((block) => block.type === "toolCall" && !answered.has(block.id))) return undefined;
	}
	return last.timestamp;
}
