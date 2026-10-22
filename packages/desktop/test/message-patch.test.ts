/**
 * 流式回复过 IPC 改成补丁之后，窗口还原出来的必须和主进程手里的逐字一致。
 *
 * 流用的是真的 provider 适配器，喂真形状的 SSE：适配器会原地改 `partial`、每个 token 重新解析一次工具
 * 参数、中途换掉思考签名——补丁要对付的就是这些，手写的事件序列测不出来。每条补丁都先过一遍
 * `structuredClone`，那就是 IPC 做的事。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { streamAssistant, type AgentEvent, type ModelConfig, type ProviderConfig } from "@plume/core";
import type { MessagePatch, WireAgentEvent } from "@plume/contract";
import { MessagePatcher, PatchReader, applyPatch } from "../shared/message-patch.ts";

type Reply = Extract<AgentEvent, { type: "message_update" }>["message"];

const sse = (frames: Record<string, unknown>[]) => frames.map((frame) => `event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`).join("");

/** 思考（中途换签名）、正文、一个参数分很多片到的工具调用、最后的用量。 */
function anthropicReply(paragraphs = 1): string {
	const text = "## 结论\n\n补丁只带新增的字。`message_update` 以前每次带整条消息，😀 表情和 \u{20000} 这种代理对也要原样到。\n".repeat(paragraphs);
	const input = JSON.stringify({ path: "src/a.ts", content: "export const a = 1;\n".repeat(6), replace: true, count: 12 });
	const frames: Record<string, unknown>[] = [
		{ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 40, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		...["先想", "一想，", "再动手。"].map((piece) => ({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: piece } })),
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
	];
	for (let at = 0; at < text.length; at += 3) frames.push({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(at, at + 3) } });
	frames.push({ type: "content_block_stop", index: 1 }, { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_1", name: "write", input: {} } });
	for (let at = 0; at < input.length; at += 7) frames.push({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: input.slice(at, at + 7) } });
	frames.push(
		{ type: "content_block_stop", index: 2 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 90 } },
		{ type: "message_stop" },
	);
	return sse(frames);
}

/** Chat Completions：推理、正文、两个并行工具调用的参数交错着到。 */
function chatCompletionsReply(): string {
	const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const parts = [chunk({ role: "assistant", content: "" })];
	for (const piece of ["想", "一下", "再说"]) parts.push(chunk({ reasoning_content: piece }));
	for (const piece of "好的，两件事一起做：读文件和跑测试。".match(/.{1,2}/gu)!) parts.push(chunk({ content: piece }));
	parts.push(chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read", arguments: "" } }] }));
	parts.push(chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "bash", arguments: "" } }] }));
	const a = JSON.stringify({ path: "src/读我.ts" });
	const b = JSON.stringify({ command: "pnpm test -- --grep \"补丁\"" });
	for (let at = 0; at < Math.max(a.length, b.length); at += 5) {
		if (at < a.length) parts.push(chunk({ tool_calls: [{ index: 0, function: { arguments: a.slice(at, at + 5) } }] }));
		if (at < b.length) parts.push(chunk({ tool_calls: [{ index: 1, function: { arguments: b.slice(at, at + 5) } }] }));
	}
	parts.push(chunk({}, "tool_calls"), `data: ${JSON.stringify({ id: "c1", choices: [], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } })}\n\n`, "data: [DONE]\n\n");
	return parts.join("");
}

const provider: ProviderConfig = { id: "p", name: "P", baseUrl: "https://example.test", api: "anthropic-messages", apiKey: "k", enabled: true, models: [] };
const model: ModelConfig = { id: "p/m", providerId: "p", modelId: "m", name: "M", contextWindow: 200_000, maxOutputTokens: 8_192, supportsThinking: true, supportsImages: false, supportsTools: true };

interface Frame {
	/** 主进程手里的那条事件发出那一刻的样子——适配器之后还会原地改它，所以当场拍下来。 */
	event: AgentEvent;
	/** 窗口收到的：编码之后过一遍克隆，就是 IPC 做的事。 */
	wire: WireAgentEvent;
	/** 这一刻有窗口来要关键帧的话，拿到的是什么。 */
	keyframe: MessagePatch | null;
}

/**
 * 照 `stream-turn.ts` 的样子把 provider 的流变成 AgentEvent，并且在**发出的那一刻**编码。
 *
 * 不能先攒齐再编码：适配器原地改 `partial`，攒到最后每条事件指向的都是最终那条消息。
 */
async function record(body: string, sessionId = "s", patcher = new MessagePatcher(), config = provider): Promise<Frame[]> {
	const frames: Frame[] = [];
	const fetchStub = async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	const stream = streamAssistant(config, model, { systemPrompt: "", messages: [], tools: [] }, { thinking: "high", retryAttempts: 0, fetch: fetchStub as typeof fetch });
	for await (const event of stream) {
		let agentEvent: AgentEvent;
		if (event.type === "start") agentEvent = { type: "message_start", message: event.partial };
		else if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta" || event.type === "toolcall_end") agentEvent = { type: "message_update", message: event.partial, delta: event };
		else if (event.type === "done" || event.type === "error") agentEvent = { type: "message_end", message: event.message };
		else continue;
		const wire = structuredClone(patcher.wire(sessionId, agentEvent));
		frames.push({ event: structuredClone(agentEvent), wire, keyframe: structuredClone(patcher.keyframe(sessionId)) });
	}
	return frames;
}

const messageOf = (event: AgentEvent | undefined) => (event?.type === "message_update" ? event.message : undefined);

test("真流：每一步还原出来的消息与主进程那一刻的逐字段一致，delta 也一样", async () => {
	const frames = await record(anthropicReply());
	const got: AgentEvent[] = [];
	const reader = new PatchReader(async () => assert.fail("全程接得上，不该要关键帧"), (_id, event) => got.push(event));
	for (const frame of frames) reader.read("s", frame.wire);
	assert.equal(got.length, frames.length);
	got.forEach((event, i) => {
		const sent = frames[i].event;
		if (sent.type !== "message_update") return assert.deepStrictEqual(event, sent);
		assert.equal(event.type, "message_update");
		assert.deepStrictEqual(messageOf(event), sent.message, `第 ${i} 条`);
		// 原 delta 的 `partial` 就是那条消息，所以整条事件逐字段相同。
		assert.deepStrictEqual(event, sent, `第 ${i} 条的 delta`);
	});
	const final = messageOf(got.findLast((event) => event.type === "message_update"))!;
	assert.equal(final.content.find((block) => block.type === "thinking")?.thinking, "先想一想，再动手。");
	assert.match(JSON.stringify(final.content.find((block) => block.type === "toolCall")), /"count":12/);
	assert.ok(frames.some((frame) => frame.wire.type === "message_patch" && frame.wire.ops.some((op) => op[1] === "a" && op[0].includes("argumentsText"))), "工具参数的原文也是按追加走的");
});

test("另一条链（Chat Completions，并行工具调用交错）也逐字一致", async () => {
	const frames = await record(chatCompletionsReply(), "s", new MessagePatcher(), { ...provider, api: "openai-chat-completions" });
	const got: AgentEvent[] = [];
	const reader = new PatchReader(async () => assert.fail("全程接得上，不该要关键帧"), (_id, event) => got.push(event));
	for (const frame of frames) reader.read("s", frame.wire);
	assert.deepStrictEqual(got, frames.map((frame) => frame.event));
	const final = messageOf(got.findLast((event) => event.type === "message_update"))!;
	assert.equal(final.content.filter((block) => block.type === "toolCall").length, 2);
});

test("补丁只带新增的部分：回复长到四倍，字节也是四倍，而不是十六倍", async () => {
	const bytes = async (paragraphs: number) => {
		const frames = await record(anthropicReply(paragraphs));
		return {
			patch: frames.filter((frame) => frame.wire.type === "message_patch").reduce((sum, frame) => sum + JSON.stringify(frame.wire).length, 0),
			full: frames.filter((frame) => frame.event.type === "message_update").reduce((sum, frame) => sum + JSON.stringify(messageOf(frame.event)).length, 0),
		};
	};
	const short = await bytes(16);
	const long = await bytes(64);
	assert.ok(long.full / short.full > 8, `整条：${short.full}B → ${long.full}B`);
	assert.ok(long.patch / short.patch < 4.2, `补丁：${short.patch}B → ${long.patch}B`);
	assert.ok(long.patch < long.full / 10, `补丁 ${long.patch}B，整条 ${long.full}B`);
});

test("交给 store 的旧消息不会被后来的补丁改掉", async () => {
	const frames = await record(anthropicReply());
	const got: Reply[] = [];
	const snapshots: string[] = [];
	const reader = new PatchReader(async () => null, (_id, event) => {
		if (event.type !== "message_update") return;
		got.push(event.message);
		snapshots.push(JSON.stringify(event.message));
	});
	for (const frame of frames) reader.read("s", frame.wire);
	got.forEach((message, i) => assert.equal(JSON.stringify(message), snapshots[i], `第 ${i} 条被原地改过`));
});

test("中途才开始听（窗口重载、后台会话没收到开头）：要一帧关键帧，攒着的补丁接上，结果一字不差", async () => {
	const frames = await record(anthropicReply());
	const cut = 40;
	let resolveKeyframe: (keyframe: MessagePatch | null) => void = () => {};
	let asked = 0;
	const got: AgentEvent[] = [];
	const reader = new PatchReader(() => {
		asked++;
		return new Promise((resolve) => (resolveKeyframe = resolve));
	}, (_id, event) => got.push(event));
	// 关键帧是主进程被问到那一刻的样子：第 cut+1 条补丁发出之后才答，期间到的 cut..cut+3 要攒着。
	for (let i = cut; i < frames.length; i++) {
		reader.read("s", frames[i].wire);
		if (i === cut + 3) resolveKeyframe(frames[cut + 1].keyframe);
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.equal(asked, 1);
	// 第一条交出去的是关键帧加上它之后攒着的两条，之后每一条都对得上。
	assert.deepStrictEqual(messageOf(got[0]), messageOf(frames[cut + 3].event));
	got.slice(1).forEach((event, k) => assert.deepStrictEqual(event, frames[cut + 4 + k].event, `第 ${cut + 4 + k} 条`));
	assert.equal(got.at(-1)!.type, "message_end");
});

test("断档（丢了一条补丁）：不拼错字，去要关键帧", async () => {
	const frames = await record(anthropicReply());
	const got: AgentEvent[] = [];
	let asked = 0;
	let now = 0;
	const reader = new PatchReader(async () => {
		asked++;
		return frames[now].keyframe;
	}, (_id, event) => got.push(event));
	for (now = 0; now < frames.length; now++) {
		if (now === 20) continue;
		const before = got.length;
		reader.read("s", frames[now].wire);
		await new Promise((resolve) => setImmediate(resolve));
		// 丢掉的那条之后，交出去的每一条都是那一刻主进程手里的样子，没有一条带错字。
		for (const event of got.slice(before)) if (event.type === "message_update") assert.deepStrictEqual(event.message, messageOf(frames[now].event), `第 ${now} 条`);
	}
	assert.equal(asked, 1);
	assert.equal(got.at(-1)!.type, "message_end");
});

test("关键帧回来之前回复已经收尾：过时的关键帧被丢掉，不会在 message_end 之后再画一次半截", async () => {
	const frames = await record(anthropicReply());
	let resolveKeyframe: (keyframe: MessagePatch | null) => void = () => {};
	const got: AgentEvent[] = [];
	const reader = new PatchReader(() => new Promise((resolve) => (resolveKeyframe = resolve)), (_id, event) => got.push(event));
	for (const frame of frames.slice(10)) reader.read("s", frame.wire);
	resolveKeyframe(frames[10].keyframe);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepStrictEqual(got.map((event) => event.type), ["message_end"]);
	assert.equal(frames.at(-1)!.keyframe, null, "收尾之后主进程不再留着这条");
});

test("切换会话、几个会话同时流：各自的补丁只接在自己那条上", async () => {
	// 同一个编码器、交错着发——主进程里就是这样。
	const patcher = new MessagePatcher();
	const [a, b] = await Promise.all([record(anthropicReply(), "a", patcher), record(anthropicReply().replaceAll("补丁", "关键帧"), "b", patcher)]);
	const got: Record<string, AgentEvent[]> = { a: [], b: [] };
	const reader = new PatchReader(async () => assert.fail("不该断档"), (id, event) => got[id].push(event));
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i]) reader.read("a", a[i].wire);
		if (b[i]) reader.read("b", b[i].wire);
	}
	assert.deepStrictEqual(got.a, a.map((frame) => frame.event));
	assert.deepStrictEqual(got.b, b.map((frame) => frame.event));
});

test("重试把内容清空重来、字段被删：整段换掉，照样一致", () => {
	const base = { role: "assistant", content: [{ type: "text", text: "第一次说了一半" }], usage: { input: 1, output: 2 }, errorMessage: "x", timestamp: 7 } as unknown as Reply;
	const patcher = new MessagePatcher();
	patcher.wire("s", { type: "message_start", message: structuredClone(base) });
	const next = { ...structuredClone(base), content: [], usage: { input: 1, output: 0 } } as unknown as Reply & { errorMessage?: string };
	delete next.errorMessage;
	const patch = structuredClone(patcher.wire("s", { type: "message_update", message: next, delta: { type: "text_delta", index: 0, delta: "", partial: next } })) as MessagePatch;
	assert.deepStrictEqual(applyPatch(structuredClone(base), patch), next);
});

test("变长了但不是接着长（改写了末尾）：整段换掉，不当成追加", () => {
	const base = { role: "assistant", content: [{ type: "text", text: "前面一段<thi" }], timestamp: 3 } as unknown as Reply;
	const patcher = new MessagePatcher();
	patcher.wire("s", { type: "message_start", message: structuredClone(base) });
	const next = { ...structuredClone(base), content: [{ type: "text", text: "前面一段，标签被拿掉了" }] } as unknown as Reply;
	const patch = structuredClone(patcher.wire("s", { type: "message_update", message: next, delta: { type: "text_delta", index: 0, delta: "", partial: next } })) as MessagePatch;
	assert.deepStrictEqual(patch.ops, [[["content", 0, "text"], "s", "前面一段，标签被拿掉了"]]);
	assert.deepStrictEqual(applyPatch(structuredClone(base), patch), next);
});

test("没见过开头的回复，主进程直接发关键帧，窗口不需要手里有东西", () => {
	const message = { role: "assistant", content: [{ type: "text", text: "直接从中间开始" }], timestamp: 9 } as unknown as Reply;
	const patch = structuredClone(new MessagePatcher().wire("s", { type: "message_update", message, delta: { type: "text_delta", index: 0, delta: "始", partial: message } })) as MessagePatch;
	const got: AgentEvent[] = [];
	new PatchReader(async () => assert.fail("关键帧不用再要"), (_id, event) => got.push(event)).read("s", patch);
	assert.deepStrictEqual((got[0] as { message: Reply }).message, message);
});
