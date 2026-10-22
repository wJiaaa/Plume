/**
 * Reading a side request — a title, a summary, an extraction — to its end.
 *
 * These are one question and one answer with no tools, and they were each read with their own copy
 * of the same loop. Kept apart from the agent loop's streaming, which renders as it goes.
 */

import { addAbortListener } from "node:events";
import type { AssistantMessage, StreamEvent, Usage } from "../types.ts";

/**
 * Wait for the final message, or for the failure that ended the wait.
 *
 * With a `signal`, aborting stops the wait even if the stream never notices: a provider that is
 * stuck mid-response must not keep a cancelled request pending. On failure, `usage` is what the
 * stream reported before it stopped — that much was billed and still has to be counted.
 */
export async function readReply(
	stream: AsyncGenerator<StreamEvent, AssistantMessage>,
	signal?: AbortSignal,
): Promise<{ reply: AssistantMessage } | { error: unknown; usage?: Usage }> {
	let usage: Usage | undefined;
	let listener: Disposable | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		if (signal) listener = addAbortListener(signal, () => reject(signal.reason));
	});
	try {
		let next: IteratorResult<StreamEvent, AssistantMessage>;
		do {
			next = await Promise.race([stream.next(), aborted]);
			if (!next.done && (next.value.type === "done" || next.value.type === "error")) usage = next.value.message.usage;
		} while (!next.done);
		return { reply: next.value };
	} catch (error) {
		return { error, usage };
	} finally {
		listener?.[Symbol.dispose]();
	}
}

/** The reply's text blocks, joined. */
export function replyText(reply: AssistantMessage, separator = ""): string {
	return reply.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}
