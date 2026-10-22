/**
 * 正文写完（`text_end`）要让界面知道，而且只让界面知道。
 *
 * 会话 a931dccf：magpie 上一条五千字的回答，最后一个字之后隔了约两秒才收尾。这段时间里界面收不到
 * 任何东西，正文写完和写到一半停住长得一样，运行行按「停住」冒了出来，接着又被页脚顶掉。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { streamTurn } from "../src/agent/stream-turn.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import { useLlmRegistry } from "../src/ai/index.ts";
import { emptyUsage, type AssistantMessage, type ModelConfig, type Provider, type ProviderConfig, type StreamEvent } from "../src/types.ts";

const MODEL = { id: "p/m", providerId: "p", modelId: "m", name: "m", contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: true, supportsImages: false, supportsTools: true } as ModelConfig;
const PROVIDER = { id: "p", name: "p", baseUrl: "http://127.0.0.1:9", api: "openai-responses", apiKey: "k", enabled: true, models: [MODEL] } as ProviderConfig;

/** 像真的适配器一样：原地改块，每次交出浅拷贝。正文写完以后推理还在长——magpie 的推理项开到最后才收。 */
const scripted = {
	api: "openai-responses",
	stream() {
		return (async function* (): AsyncGenerator<StreamEvent, AssistantMessage> {
			const partial: AssistantMessage = { role: "assistant", content: [], api: "openai-responses", provider: "p", model: "m", usage: emptyUsage(), stopReason: "pending", timestamp: 1 };
			yield { type: "start", partial: { ...partial } };
			const thinking = { type: "thinking" as const, thinking: "想" };
			const text = { type: "text" as const, text: "" };
			partial.content.push(thinking, text);
			for (const piece of ["写", "完了"]) {
				text.text += piece;
				yield { type: "text_delta", index: 1, delta: piece, partial: { ...partial } };
			}
			yield { type: "text_end", index: 1 };
			thinking.thinking += "接着想";
			yield { type: "thinking_delta", index: 0, delta: "接着想", partial: { ...partial } };
			const message = { ...partial, stopReason: "stop" as const };
			yield { type: "done", message };
			return message;
		})();
	},
} as unknown as Provider;

test("text_end reaches the window as an update with the block marked ended, and the stored reply carries no mark", async () => {
	const events: AgentEvent[] = [];
	useLlmRegistry({ get: (api) => (api === "openai-responses" ? scripted : undefined) });
	try {
		const turn = await streamTurn(
			{ provider: PROVIDER, model: MODEL, liveModel: undefined, thinking: undefined, cacheKey: undefined, retryPolicy: undefined, streamFn: undefined, onContext: undefined, retryAttempts: 1 } as never,
			{ systemPrompt: "", messages: [], tools: [] },
			{ signal: undefined, state: undefined } as never,
			(event) => { events.push(event); },
		);
		const updates = events.filter((event): event is Extract<AgentEvent, { type: "message_update" }> => event.type === "message_update");
		const endedOf = (event: (typeof updates)[number]) => (event.message.content[1] as { ended?: true }).ended;
		assert.deepEqual(updates.map((event) => event.delta.type), ["text_delta", "text_delta", "text_end", "thinking_delta"]);
		assert.deepEqual(updates.map(endedOf), [undefined, undefined, true, true], "the mark is on the ended block from text_end on, including later updates");
		assert.equal((updates[2].message.content[1] as { text: string }).text, "写完了");
		assert.equal((turn.message.content[1] as { ended?: true }).ended, undefined, "the stored reply would carry the mark into the transcript");
	} finally {
		useLlmRegistry(null);
	}
});
