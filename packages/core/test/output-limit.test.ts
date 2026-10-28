/**
 * 回复撞上输出上限：接着写，或把一次写不完的拆开；一再撞上就停下说清楚，不空耗轮数。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import { runConfig } from "./run-config.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig, type Tool } from "../src/types.ts";

const model: ModelConfig = { id: "t/m", providerId: "t", modelId: "m", name: "M", contextWindow: 100_000, maxOutputTokens: 256, supportsThinking: false, supportsImages: false, supportsTools: true };
const provider: ProviderConfig = { id: "t", name: "T", baseUrl: "http://127.0.0.1:1", api: "openai-chat-completions", apiKey: "x", enabled: true, models: [model] };
const reply = (stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant", content, api: provider.api, provider: provider.id, model: model.modelId, stopReason, usage: emptyUsage(), timestamp: Date.now(),
});
const user: Message = { role: "user", content: [{ type: "text", text: "写一篇长文" }], timestamp: 1 };

async function run(replies: AssistantMessage[], tools: Tool[] = []) {
	const sent: Message[][] = [];
	const events: { type: string; message?: string }[] = [];
	const result = await runAgent(
		runConfig({
			session: { messages: [user] },
			model: { provider, model, streamFn: async (context) => {
				sent.push([...context.messages]);
				const next = replies.shift();
				if (!next) throw new Error("no more replies");
				return next;
			} },
			tools: { available: tools },
		}),
		async (event) => { events.push(event as { type: string; message?: string }); },
	);
	return { result, sent, events };
}

test("a text reply cut off by the output limit continues from where it stopped", async () => {
	const { result, sent } = await run([reply("length", [{ type: "text", text: "前半段" }]), reply("stop", [{ type: "text", text: "后半段" }])]);
	assert.equal(result.reason, "done");
	assert.equal(sent.length, 2, "接着写了一次，而不是当作答完");
	const resume = sent[1].at(-1);
	assert.equal(resume?.role, "user");
	assert.equal(resume?.role === "user" && resume.synthetic, true, "是运行时在说话，界面不画成人说的");
	assert.match(JSON.stringify(resume?.content), /输出长度上限/);
});

test("a reply that keeps hitting the limit stops after a bounded number of continuations and says so", async () => {
	const { result, sent, events } = await run(Array.from({ length: 10 }, () => reply("length", [{ type: "text", text: "……" }])));
	assert.equal(sent.length, 4, "三次接着写之后停下");
	assert.equal(result.reason, "done");
	assert.ok(events.some((event) => event.type === "notice" && /输出长度上限/.test(event.message ?? "")));
});

test("tool calls cut off mid-arguments are not run, ask for smaller pieces, and stop when it keeps happening", async () => {
	let ran = 0;
	const write: Tool = { name: "write", description: "w", parameters: { type: "object", properties: {} }, execute: async () => { ran++; return { content: [{ type: "text", text: "ok" }] }; } };
	const cut = () => reply("length", [{ type: "toolCall", id: `c${Math.random()}`, name: "write", arguments: {}, argumentsText: "{\"content\":\"…" }]);
	const { result, sent } = await run([cut(), cut(), cut(), cut(), cut()], [write]);
	assert.equal(ran, 0, "参数可能不完整的调用不执行");
	assert.match(JSON.stringify(sent[1].at(-1)?.content), /in parts/, "失败说明里要它拆开写");
	assert.equal(sent.length, 4);
	assert.equal(result.reason, "error");
	assert.match(result.error ?? "", /输出长度上限/);
});

test("thinking that eats the whole output budget stops at the limit instead of being nudged as an empty reply", async () => {
	// 只有思考、正文为空的截断：从前超限后交给空回复那条规则再催三次，每次照样把上限打满。
	const thinkingOnly = () => reply("length", [{ type: "thinking", thinking: "想了很久……" }]);
	const { result, sent, events } = await run(Array.from({ length: 10 }, thinkingOnly));
	assert.equal(sent.length, 4, "三次接着写之后就停");
	assert.equal(result.reason, "done");
	assert.equal(events.filter((event) => event.type === "notice" && /输出长度上限/.test(event.message ?? "")).length, 1, "「已停下」只说一次，说了就真停");
	assert.ok(!sent.flat().some((message) => /没有正文/.test(JSON.stringify(message.content))), "没有被当成空回复去催");
});

test("a reply cut off on the last step ends at the step limit, so the continuation chain picks it up", async () => {
	/*
	 * 从前这里按 `done` 收场：续跑链只认 `max_turns`，一条写到一半的回答就此算答完，还先报了一句
	 * 「连续多次达到输出长度上限，已停下」——而它只被截断了一次。
	 */
	const events: { type: string; message?: string }[] = [];
	const result = await runAgent(
		runConfig({
			session: { messages: [user] },
			model: { provider, model, streamFn: async () => reply("length", [{ type: "text", text: "写到一半" }]) },
			control: { maxTurns: 1 },
		}),
		async (event) => { events.push(event as { type: string; message?: string }); },
	);
	assert.equal(result.reason, "max_turns", "步数上限收场，续跑链接得上");
	assert.ok(!events.some((event) => event.type === "notice" && /输出长度上限/.test(event.message ?? "")), "只截断了一次，不说「连续多次」");
	const last = result.view.at(-1);
	assert.equal(last?.role === "user" && last.synthetic, true, "续跑那次请求以「接着写」结尾，不以半截回复结尾");
	assert.match(JSON.stringify(last?.content), /输出长度上限/);
});
