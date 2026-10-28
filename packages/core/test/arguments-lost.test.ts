/**
 * 并行调用的参数在路上丢光：不跑，说清原因；说过还这样才停。
 *
 * 来自一个真实会话：某中转的 `gpt-6.1-sol` 每次并行调用参数都变成 `{}`，单个调用正常。原来逐个照跑，
 * 模型拿到一排「path is required」照样并行重发，重复检测再把它说成「同样的参数问了多次」，五轮后停掉。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import { runConfig } from "./run-config.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type Tool } from "../src/types.ts";

const model: ModelConfig = { id: "m", modelId: "m", providerId: "p", name: "m", contextWindow: 100_000, maxOutputTokens: 100, supportsThinking: false, supportsImages: false, supportsTools: true };

function calls(...args: Record<string, unknown>[]): AssistantMessage {
	return {
		role: "assistant", api: "openai-responses", provider: "p", model: "m", stopReason: "toolUse", usage: emptyUsage(), timestamp: 0,
		content: args.map((a, index) => ({ type: "toolCall" as const, id: `c${Math.random()}-${index}`, name: "read", arguments: a, argumentsText: JSON.stringify(a) })),
	};
}

function says(text: string): AssistantMessage {
	return { ...calls(), stopReason: "stop", content: [{ type: "text", text }] };
}

const textOf = (message: Message) => (message.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("");

async function run(script: AssistantMessage[]) {
	const ran: unknown[] = [];
	const tool: Tool = {
		name: "read", snippet: "read", description: "read",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		execute: async (args) => {
			ran.push(args);
			return typeof args.path === "string" ? { content: [{ type: "text", text: "ok" }] } : { content: [{ type: "text", text: "`path` is required." }], isError: true };
		},
	};
	let requests = 0;
	const result = await runAgent(runConfig({
		session: { sessionId: "t", messages: [{ role: "user", content: [{ type: "text", text: "读文件" }], timestamp: 0 }] },
		model: {
			model,
			provider: { id: "p", name: "p", api: "openai-responses", baseUrl: "http://localhost", apiKey: "", enabled: true, models: [model] },
			streamFn: async () => {
				requests += 1;
				return script.shift() ?? says("完");
			},
		},
		tools: { available: [tool], env: { cwd: "/test" }, requestApproval: async () => "allow" },
	}), async () => {});
	return { result, ran, requests };
}

test("几个并行调用参数全空：一个也不跑，每条结果都说清是路上丢的、该一次调一个", async () => {
	const { result, ran } = await run([calls({}, {}, {}), says("好")]);
	assert.equal(ran.length, 0, "参数已知丢了，跑了只会各报一句缺参");
	const results = result.messages.filter((message) => message.role === "toolResult");
	assert.equal(results.length, 3, "每个调用都要有结果");
	for (const message of results) {
		assert.equal(message.role === "toolResult" && message.isError, true);
		assert.match(textOf(message), /dropping the arguments of parallel tool calls/);
		assert.match(textOf(message), /one tool call per reply/);
	}
	const nudges = result.messages.filter((message) => message.role === "user" && message.synthetic);
	assert.deepEqual(nudges.map(textOf), [], "三条一样的结果不能被重复检测说成「同样的参数问了多次」");
	assert.equal(result.reason, "done");
});

test("纠正过还连着丢三轮：停下并说明，不再发第四次请求", async () => {
	const { result, ran, requests } = await run([calls({}, {}), calls({}, {}, {}, {}), calls({}, {}), says("不该走到这")]);
	assert.equal(ran.length, 0);
	assert.equal(requests, 3);
	assert.equal(result.reason, "error");
	assert.match(result.error ?? "", /连续 3 轮丢失了工具调用的参数/);
});

test("中间改成单个调用，计数从头来", async () => {
	const { result, ran } = await run([calls({}, {}), calls({}, {}), calls({ path: "a" }), calls({}, {}), calls({}, {}), says("好")]);
	assert.deepEqual(ran, [{ path: "a" }]);
	assert.equal(result.reason, "done");
});

test("单个空调用、或混着正常调用的，照常跑、照常报缺参", async () => {
	const { result, ran } = await run([calls({}), calls({}, { path: "a" }), says("好")]);
	assert.deepEqual(ran, [{}, {}, { path: "a" }]);
	const texts = result.messages.filter((message) => message.role === "toolResult").map(textOf);
	assert.equal(texts.filter((text) => /path` is required/.test(text)).length, 2);
	assert.ok(texts.every((text) => !/dropping the arguments/.test(text)));
});
