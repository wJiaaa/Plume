/**
 * Responses message 项的 `phase`：记下来、回放回去，界面和交给上级的答复据此不把同一段话说两遍。
 *
 * 实际撞上的形状（会话 40152d28，company/gpt-6.1-sol）：一次回复里两段 `commentary`
 * 「已收到…」「我会等…」，收尾一段 `final_answer` 把这两段原样再写一遍、再补一句。三段都当正文画，
 * 界面上就是整段重复。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import { toResponsesInput } from "../src/ai/openai-responses-request.ts";
import { restated } from "../src/reply-text.ts";
import { emptyUsage } from "../src/types.ts";
import type { AssistantMessage, Message, TextContent } from "../src/types.ts";

const provider = {
	id: "relay",
	name: "relay",
	baseUrl: "https://example.invalid",
	api: "openai-responses" as const,
	apiKey: "test",
	enabled: true,
	models: [],
};

const model = { modelId: "test-model", contextWindow: 128000, maxOutputTokens: 4096 };

const frame = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const completed = frame({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } });

/** 守规矩的流：每段 added、delta、done。 */
function fullStream(messages: { phase?: unknown; text: string }[]): string {
	return (
		messages
			.map(({ phase, text }, index) => {
				const id = `msg_${index}`;
				return [
					frame({ type: "response.output_item.added", output_index: index, item: { type: "message", id, phase, content: [] } }),
					frame({ type: "response.output_text.delta", output_index: index, item_id: id, delta: text }),
					frame({ type: "response.output_item.done", output_index: index, item: { type: "message", id, phase, content: [{ type: "output_text", text }] } }),
				].join("");
			})
			.join("") + completed
	);
}

async function run(sse: string): Promise<AssistantMessage> {
	const stream = openaiResponsesProvider.stream(
		provider,
		model,
		{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }], tools: [] },
		{
			// oxlint-disable-next-line no-explicit-any -- 测试里塞一个假 fetch
			fetch: (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as any,
			retryAttempts: 1,
		},
	);
	while (true) {
		const next = await stream.next();
		if (next.done) return next.value;
	}
}

const texts = (message: AssistantMessage) => message.content.filter((block): block is TextContent => block.type === "text");

test("每段文本记下自己的 phase；被最终答复重说过的播报算 restated，最终答复本身不算", async () => {
	const message = await run(
		fullStream([
			{ phase: "commentary", text: "已收到核对结果。" },
			{ phase: "commentary", text: "我会等剩余结果。" },
			{ phase: "final_answer", text: "已收到核对结果。\n\n我会等剩余结果。\n\n未修改代码。" },
		]),
	);
	assert.deepEqual(
		texts(message).map((block) => block.phase),
		["commentary", "commentary", "final_answer"],
	);
	assert.deepEqual(
		message.content.map((block) => restated(block, message.content)),
		[true, true, false],
	);
});

test("只发 done 的中转：phase 从 done 里补上", async () => {
	const sse =
		frame({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_0", phase: "commentary", content: [{ type: "output_text", text: "先看看" }] } }) +
		frame({ type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_1", phase: "final_answer", content: [{ type: "output_text", text: "看完了" }] } }) +
		completed;
	const message = await run(sse);
	assert.deepEqual(
		texts(message).map((block) => block.phase),
		["commentary", "final_answer"],
	);
});

test("不认识的 phase、没有 phase 的块不记，也不算 restated", async () => {
	const message = await run(fullStream([{ phase: "analysis", text: "甲" }, { text: "乙" }]));
	assert.deepEqual(
		texts(message).map((block) => block.phase),
		[undefined, undefined],
	);
	assert.ok(message.content.every((block) => !restated(block, message.content)));
});

test("调工具前的播报、最终答复还没写字时的播报，都不算 restated", () => {
	const beforeCall: AssistantMessage["content"] = [
		{ type: "text", text: "我先查一下时间。", phase: "commentary" },
		{ type: "toolCall", id: "call_1", name: "get_time", arguments: {} },
	];
	assert.equal(restated(beforeCall[0], beforeCall), false, "那是这一步唯一的一句话");

	const finalJustOpened: AssistantMessage["content"] = [
		{ type: "text", text: "已收到。", phase: "commentary" },
		{ type: "text", text: "", phase: "final_answer" },
	];
	assert.equal(restated(finalJustOpened[0], finalJustOpened), false, "答复还一个字没有，播报先留着");
});

test("回放时 phase 原样带回去，没有的不带", () => {
	const user: Message = { role: "user", content: [{ type: "text", text: "看看" }], timestamp: 0 };
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "先看看", phase: "commentary" },
			{ type: "text", text: "看完了", phase: "final_answer" },
			{ type: "text", text: "旧会话里的话" },
		],
		api: "openai-responses",
		provider: "relay",
		model: "test-model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 1,
	};
	const input = toResponsesInput([user, assistant, user], { provider: "relay", model: "test-model", leadingReasoning: false }) as { role?: string; phase?: string }[];
	assert.deepEqual(
		input.filter((item) => item.role === "assistant").map((item) => item.phase),
		["commentary", "final_answer", undefined],
	);
});
