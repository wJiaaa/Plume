/**
 * 派出去的子代理还没回来时，循环不逼模型交结论（见 `awaiting.ts`）。
 *
 * 守三件事：隔 `AWAIT_EVERY` 次带工具的请求说一遍还在等谁、名单一变就从头数；收尾时不追问清单；
 * 空回复的催促要的是「在等谁」。没有 `awaiting` 的运行（子代理、评测）和以前一样。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { runAgent, type AgentRunResult } from "../src/agent/loop.ts";
import { AWAIT_EVERY, awaitingEmptyNudge, awaitingNote } from "../src/agent/awaiting.ts";
import type { AwaitedDispatch } from "../src/agent/run-config.ts";
import { runConfig } from "./run-config.ts";
import { readTool } from "../src/tools/read.ts";
import { todoTool, type TodoItem } from "../src/tools/todo.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig, Tool } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

let cwd: string;
before(async () => {
	cwd = await mkdtemp(join(tmpdir(), "ly-awaiting-"));
	// 每轮读一个不同的文件：连读同一个会被重复检测叫停。
	for (let i = 0; i < 20; i++) await writeFile(join(cwd, `f${i}.ts`), `export const f${i} = ${i};\n`, "utf8");
});
after(async () => {
	await rm(cwd, { recursive: true, force: true });
});

const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://l", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason, timestamp: Date.now(), content };
}
const text = (value: string) => ({ type: "text" as const, text: value });
const readCall = (n: number) => ({ type: "toolCall" as const, id: `r${n}`, name: "read", arguments: { path: `f${n}.ts` }, argumentsText: "{}" });
const reads = (count: number) => Array.from({ length: count }, (_, n) => reply([readCall(n)], "toolUse"));
const OPEN: TodoItem[] = [
	{ content: "派子代理调研", status: "completed" },
	{ content: "合并结论", status: "in_progress", activeForm: "合并结论中" },
];
const todoCall = { type: "toolCall" as const, id: "t1", name: "todo_write", arguments: { todos: OPEN }, argumentsText: "{}" };

const ARCH: AwaitedDispatch = { id: "s:sub:1", agent: "explore", description: "梳理运维架构" };
const LOGIN: AwaitedDispatch = { id: "s:sub:2", agent: "explore", description: "梳理登录流程" };

/** `awaiting` 每次被问到时按请求数给名单：`roster(requests)`。不给就是不派活的运行。 */
async function run(script: AssistantMessage[], roster?: (requests: number) => AwaitedDispatch[]): Promise<{ result: AgentRunResult; requests: number }> {
	let requests = 0;
	const result = await runAgent(
		runConfig({
			session: { sessionId: "awaiting", systemPrompt: "x", messages: [{ role: "user", content: [text("梳理整体架构")], timestamp: Date.now() }], state: new Map() },
			model: {
				provider: PROVIDER,
				model: MODEL,
				temperature: 0,
				streamFn: async () => {
					const next = script[requests++];
					assert.ok(next, `request ${requests} was not expected`);
					return next;
				},
			},
			tools: { available: [todoTool, readTool] as unknown as Tool[], env: { cwd } },
			control: { maxTurns: 30, ...(roster ? { awaiting: () => roster(requests) } : {}) },
		}),
		async () => {},
	);
	return { result, requests };
}

const said = (messages: Message[], prefix: string) =>
	messages.flatMap((m) => (m.role === "user" && m.synthetic ? m.content.filter((c) => c.type === "text" && c.text.startsWith(prefix)).map((c) => (c.type === "text" ? c.text : "")) : []));
/** 第几条消息之后插进来的提示：数它前面有几次带工具的回复。 */
const toolTurnsBefore = (messages: Message[], note: string) =>
	messages.slice(0, messages.findIndex((m) => m.role === "user" && m.content.some((c) => c.type === "text" && c.text === note))).filter((m) => m.role === "assistant").length;

test("while sub-agents are out, who is still awaited is said again every AWAIT_EVERY tool requests", async () => {
	const turns = AWAIT_EVERY * 2 + 1;
	const { result } = await run([...reads(turns), reply([text("还在等运维架构那一路。")], "stop")], () => [ARCH]);
	const notes = said(result.messages, "（自动提示）派出去的子代理");
	// 第一次带工具的请求后名单从无到有，算「刚看到」；之后每 AWAIT_EVERY 次说一遍。
	assert.equal(notes.length, 2);
	assert.equal(notes[0], awaitingNote([ARCH]));
	assert.match(notes[0], /explore（梳理运维架构）/);
	assert.equal(toolTurnsBefore(result.messages, notes[0]), AWAIT_EVERY + 1);
});

test("a change in who is out restarts the count: the model has just seen the new list", async () => {
	// 第 3 次请求时第二路派出，之后名单不变。
	const turns = AWAIT_EVERY + 3;
	const { result } = await run([...reads(turns), reply([text("好。")], "stop")], (requests) => (requests >= 3 ? [ARCH, LOGIN] : [ARCH]));
	const notes = said(result.messages, "（自动提示）派出去的子代理");
	assert.equal(notes.length, 1);
	assert.equal(notes[0], awaitingNote([ARCH, LOGIN]));
	assert.equal(toolTurnsBefore(result.messages, notes[0]), 3 + AWAIT_EVERY);
});

test("nothing out, or no awaiting at all: no reminder", async () => {
	for (const roster of [() => [], undefined]) {
		const { result } = await run([...reads(AWAIT_EVERY * 2 + 1), reply([text("完成。")], "stop")], roster);
		assert.equal(said(result.messages, "（自动提示）派出去的子代理").length, 0);
	}
});

test("an open plan item is not asked about while sub-agents are out", async () => {
	const script = [reply([todoCall, readCall(0)], "toolUse"), reply([text("派出去了，等两路回来再合并。")], "stop")];
	const waiting = await run(script, () => [ARCH]);
	assert.equal(waiting.requests, 2, "the closing question would be a third request");
	assert.equal(waiting.result.reason, "done");
	assert.equal(said(waiting.result.messages, "（自动提示）任务清单").length, 0);

	// 都回来了，照旧问一次。
	const back = await run([...script, reply([text("清单就这样。")], "stop")], () => []);
	assert.equal(back.requests, 3);
	assert.equal(said(back.result.messages, "（自动提示）任务清单").length, 1);
});

test("an empty reply while sub-agents are out is asked for who it waits on, not for an answer", async () => {
	const { result } = await run([reply([readCall(0)], "toolUse"), reply([text("")], "stop"), reply([text("在等运维架构那一路。")], "stop")], () => [ARCH]);
	assert.deepEqual(said(result.messages, "（自动继续）"), [awaitingEmptyNudge([ARCH])]);
});
