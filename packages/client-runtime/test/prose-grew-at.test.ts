/**
 * 结论上一次变长的时刻记在消息合并这一步：桌面运行行靠它判断字停了没有。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Message } from "@plume/core/client-types";

type AssistantMessage = Extract<Message, { role: "assistant" }>;
import { messageEvent, proseGrewAt } from "../src/message-event.ts";

function reply(text: string, ended = false): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text, ...(ended ? { ended: true as const } : {}) }],
		api: "openai-responses", provider: "p", model: "m", usage: {} as AssistantMessage["usage"], stopReason: "pending", timestamp: 7,
	};
}

function update(messages: Message[], message: AssistantMessage): Message[] {
	return messageEvent({ messages, pendingUserMessage: null }, { type: "message_update", message, delta: { type: "text_delta" } as never }, "s").messages;
}

test("the time travels with the reply, held while the text is unchanged and dropped once the text is written out", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	try {
		let messages = update([], reply("写"));
		assert.equal(proseGrewAt(messages.at(-1)), 1_000);

		// 别的块在变、正文没长（推理还在流、用量更新）：不算变长，沿用原来的时刻。
		t.mock.timers.tick(500);
		messages = update(messages, reply("写"));
		assert.equal(proseGrewAt(messages.at(-1)), 1_000);

		t.mock.timers.tick(500);
		messages = update(messages, reply("写完"));
		assert.equal(proseGrewAt(messages.at(-1)), 2_000);

		// 正文写完了：从这里到收尾的那段空档不是停住。
		messages = update(messages, reply("写完", true));
		assert.equal(proseGrewAt(messages.at(-1)), undefined);
	} finally {
		t.mock.timers.reset();
	}
});
