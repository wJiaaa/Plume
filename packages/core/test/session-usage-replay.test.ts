/**
 * 用量页的回放：数什么、不数什么，Token 构成按请求当时的上下文分、分完加起来是账单上的数。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/session/store.ts";
import { INPUT_PARTS, OUTPUT_PARTS } from "../src/session/usage-parts.ts";
import { emptyReplayRow, foldUsageRecord, newUsageReplayState, type UsageReplayRow, type UsageReplayState } from "../src/session/usage-replay.ts";
import type { SessionMeta } from "../src/session/types.ts";
import { emptyUsage, type AssistantMessage, type Message, type ToolResultMessage } from "../src/types.ts";

const user = (text: string, synthetic = false): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1, ...(synthetic ? { synthetic: true } : {}) });

function reply(options: { durationMs?: number; sseDurationMs?: number; thinkingMs?: number; input?: number; cacheRead?: number; output?: number; text?: string; model?: string } = {}): AssistantMessage {
	const content: AssistantMessage["content"] = [{ type: "text", text: options.text ?? "ok" }];
	if (options.thinkingMs !== undefined) content.unshift({ type: "thinking", thinking: "hm", durationMs: options.thinkingMs });
	return {
		role: "assistant", content, api: "openai-responses", provider: "p", model: options.model ?? "m", stopReason: "stop", timestamp: 1, durationMs: options.durationMs, sseDurationMs: options.sseDurationMs,
		usage: { ...emptyUsage(), input: options.input ?? 0, cacheRead: options.cacheRead ?? 0, output: options.output ?? 0 },
	};
}

const tool = (durationMs: number, isError = false, text = ""): ToolResultMessage => ({ role: "toolResult", toolCallId: `c${durationMs}`, toolName: "bash", content: [{ type: "text", text }], isError, durationMs, timestamp: 1 });

async function withStore(run: (store: SessionStore, root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "ly-usage-replay-"));
	const store = new SessionStore(root);
	try {
		await run(store, root);
	} finally {
		store.close();
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
}

/** 回放一个会话 `after` 之后的记录，返回按模型合起来的行。 */
async function replay(store: SessionStore, meta: SessionMeta, state: UsageReplayState = newUsageReplayState(), after = 0): Promise<Map<string, UsageReplayRow>> {
	const rows = new Map<string, UsageReplayRow>();
	for await (const record of store.usageRecords(meta.id, after)) {
		foldUsageRecord(state, meta.id, record, (key) => {
			const id = `${key.provider}/${key.model}`;
			const found = rows.get(id) ?? emptyReplayRow(key);
			rows.set(id, found);
			return found;
		});
	}
	return rows;
}

const sum = (row: UsageReplayRow, parts: readonly (keyof UsageReplayRow)[]) => parts.reduce((total, part) => total + Number(row[part]), 0);

test("人发的才算轮次，子智能体的工具和回复算在内，思考截到生成时间", async () => {
	await withStore(async (store, root) => {
		const meta = await store.create(root, "m");
		await store.append(meta, { type: "message", message: user("go") });
		await store.append(meta, { type: "message", message: user("后台命令完成", true) });
		await store.append(meta, { type: "message", message: reply({ durationMs: 5000, sseDurationMs: 3000, thinkingMs: 1000 }) });
		await store.append(meta, { type: "message", message: tool(800) });
		await store.append(meta, { type: "message", message: tool(200, true) });
		// 一次性吐出整段：思考块的时长比生成还长，按生成那段算。
		await store.append(meta, { type: "message", message: reply({ durationMs: 2000, sseDurationMs: 5, thinkingMs: 900 }) });
		await store.append(meta, { type: "message", message: reply() });
		await store.append(meta, { type: "event", event: { type: "subagent_message", id: "s1", message: reply({ durationMs: 1000, sseDurationMs: 600, model: "small" }) } });
		await store.append(meta, { type: "event", event: { type: "subagent_message", id: "s1", message: tool(400) } });

		const rows = await replay(store, meta);
		const main = rows.get("p/m");
		assert.ok(main);
		assert.deepEqual(
			[main.turns, main.replies, main.timedReplies, main.modelMs, main.streamMs, main.thinkingMs, main.tools, main.toolErrors, main.toolMs],
			[1, 3, 2, 7000, 3005, 1005, 2, 1, 1000],
		);
		const sub = rows.get("p/small");
		assert.deepEqual([sub?.turns, sub?.replies, sub?.tools, sub?.toolMs], [0, 1, 1, 400], "子智能体的工具记在它自己的模型上");
	});
});

test("输入按请求当时带着的那几条消息分，各部分加起来等于计费的输入", async () => {
	await withStore(async (store, root) => {
		const meta = await store.create(root, "m");
		const systemPrompt = "S".repeat(400) + "I".repeat(400);
		await store.append(meta, { type: "event", event: { type: "context", systemPrompt, tools: [], skills: [], schemas: [], sections: [{ source: "identity", start: 0, end: 400 }, { source: "projectInstructions", start: 400, end: 800 }] } });
		await store.append(meta, { type: "message", message: user("u".repeat(400)) });
		await store.append(meta, { type: "message", message: tool(10, false, "t".repeat(4000)) });
		// 这次请求只带最后一条（前面的被压缩掉了）：用户消息不该占份额。
		await store.append(meta, { type: "event", event: { type: "request", provider: "p", model: "m", messageCount: 1 } });
		await store.append(meta, { type: "message", message: reply({ input: 1000, cacheRead: 2000, output: 30 }) });

		const row = (await replay(store, meta)).get("p/m");
		assert.ok(row);
		assert.equal(Math.round(sum(row, INPUT_PARTS)), 3000, "输入分完还是计费的 3000");
		assert.equal(row.user, 0);
		// 估计：系统 100、说明 100、工具结果 1000，按比例分 3000。
		assert.deepEqual([row.system, row.instructions, row.toolResults].map(Math.round), [250, 250, 2500]);
		assert.equal(Math.round(sum(row, OUTPUT_PARTS)), 30);
	});
});

test("分叉抄来的历史进上下文但不算这里做的事；倒回去以后截掉的不再算进上下文", async () => {
	await withStore(async (store, root) => {
		const meta = await store.create(root, "m");
		await store.append(meta, { type: "message", message: user("u".repeat(400)) }, { copy: true });
		await store.append(meta, { type: "message", message: tool(900, false, "t".repeat(400)) }, { copy: true });
		await store.append(meta, { type: "message", message: reply({ input: 200 }) });
		let row = (await replay(store, meta)).get("p/m");
		assert.deepEqual([row?.turns, row?.tools, row?.replies], [0, 0, 1]);
		assert.deepEqual([row?.user, row?.toolResults].map((value) => Math.round(value ?? 0)), [100, 100], "抄来的两条在这次请求的上下文里");

		const state = newUsageReplayState();
		await replay(store, meta, state);
		const seq = (await store.get(meta.id))?.seq ?? 0;
		await store.append(meta, { type: "truncate", afterSeq: 2 });
		await store.append(meta, { type: "message", message: reply({ input: 100 }) });
		row = (await replay(store, meta, state, seq)).get("p/m");
		assert.deepEqual([row?.user, row?.toolResults].map((value) => Math.round(value ?? 0)), [100, 0], "工具结果已经被倒回去截掉");
	});
});

test("只发出请求、没等到回复的那一轮也算，记在请求的模型上", async () => {
	await withStore(async (store, root) => {
		const meta = await store.create(root, "m");
		await store.append(meta, { type: "message", message: user("go") });
		await store.append(meta, { type: "event", event: { type: "request", provider: "p", model: "m", messageCount: 1 } });
		const row = (await replay(store, meta)).get("p/m");
		assert.deepEqual([row?.turns, row?.replies], [1, 0]);
	});
});

test("倒回压缩事件之前时，摘要失效，即使没有消息被截掉", async () => {
	await withStore(async (store, root) => {
		const meta = await store.create(root, "m");
		await store.append(meta, { type: "message", message: tool(10, false, "t".repeat(4000)) });
		await store.append(meta, { type: "message", message: user("u".repeat(400)) });
		const before = (await store.get(meta.id))!.seq;
		await store.append(meta, { type: "event", event: { type: "compacted", before: 2, after: 3, kept: 1, summary: "h".repeat(400) } });
		await store.append(meta, { type: "truncate", afterSeq: before });
		await store.append(meta, { type: "event", event: { type: "request", provider: "p", model: "m", messageCount: 2 } });
		await store.append(meta, { type: "message", message: reply({ input: 1100 }) });
		const row = (await replay(store, meta)).get("p/m");
		assert.deepEqual([row?.user, row?.injected, row?.toolResults], [100, 0, 1000]);
	});
});

test("压缩按日志的 kept 和摘要估来源，不用合成消息数取回已折叠的工具结果", async () => {
	await withStore(async (store, root) => {
		const meta = await store.create(root, "m");
		await store.append(meta, { type: "event", event: { type: "context", systemPrompt: "s".repeat(400), tools: [], skills: [] } });
		await store.append(meta, { type: "message", message: tool(10, false, "t".repeat(4000)) });
		await store.append(meta, { type: "message", message: user("u".repeat(400)) });
		await store.append(meta, { type: "event", event: { type: "compacted", before: 2, after: 3, kept: 1, summary: "h".repeat(400) } });
		// 真实请求还有摘要、确认和日期块；日志只证明摘要正文及保留的一条。
		await store.append(meta, { type: "event", event: { type: "request", provider: "p", model: "m", messageCount: 4 } });
		const state = newUsageReplayState();
		await replay(store, meta, state);
		const after = (await store.get(meta.id))!.seq;
		await store.append(meta, { type: "message", message: reply({ input: 900 }) });
		const row = (await replay(store, meta, JSON.parse(JSON.stringify(state)) as UsageReplayState, after)).get("p/m");
		assert.ok(row);
		assert.deepEqual([row.system, row.user, row.injected, row.toolResults].map(Math.round), [300, 300, 300, 0]);
		assert.equal(Math.round(sum(row, INPUT_PARTS)), 900);
	});
});

test("子代理开场任务进入来源，续跑的派发事件不再复制已经记录的开场消息", async () => {
	await withStore(async (store, root) => {
		const meta = await store.create(root, "m");
		const dispatch = { type: "subagent" as const, id: "s", agent: "general", description: "", prompt: "u".repeat(400), tools: [] };
		await store.append(meta, { type: "event", event: dispatch });
		await store.append(meta, { type: "event", event: { type: "subagent_event", id: "s", event: { type: "context", systemPrompt: "s".repeat(400), tools: [], skills: [] } } });
		await store.append(meta, { type: "event", event: { type: "subagent_event", id: "s", event: { type: "request", provider: "p", model: "m", messageCount: 2 } } });
		await store.append(meta, { type: "event", event: { type: "subagent_message", id: "s", message: reply({ input: 200, text: "" }) } });
		let row = (await replay(store, meta)).get("p/m");
		assert.deepEqual([row?.user, row?.system, row?.turns], [100, 100, 0]);
		await store.append(meta, { type: "event", event: { type: "subagent_message", id: "s", message: user(dispatch.prompt) } });
		await store.append(meta, { type: "event", event: { ...dispatch, resumed: true } });
		await store.append(meta, { type: "event", event: { type: "subagent_event", id: "s", event: { type: "request", provider: "p", model: "m", messageCount: 4 } } });
		await store.append(meta, { type: "event", event: { type: "subagent_message", id: "s", message: reply({ input: 300, text: "" }) } });
		row = (await replay(store, meta)).get("p/m");
		assert.deepEqual([row?.user, row?.system, row?.turns], [300, 200, 0]);
	});
});

test("子代理压缩也只分配给保留尾部和日志摘要，丢弃时没有摘要就不补造正文", async () => {
	await withStore(async (store, root) => {
		const meta = await store.create(root, "m");
		await store.append(meta, { type: "event", event: { type: "subagent", id: "s", agent: "general", description: "", prompt: "old".repeat(1000), tools: [] } });
		await store.append(meta, { type: "event", event: { type: "subagent_message", id: "s", message: tool(10, false, "t".repeat(4000)) } });
		await store.append(meta, { type: "event", event: { type: "subagent_message", id: "s", message: user("u".repeat(400)) } });
		await store.append(meta, { type: "event", event: { type: "subagent_event", id: "s", event: { type: "compacted", before: 3, after: 2, kept: 1, summary: "" } } });
		await store.append(meta, { type: "event", event: { type: "subagent_event", id: "s", event: { type: "request", provider: "p", model: "m", messageCount: 3 } } });
		await store.append(meta, { type: "event", event: { type: "subagent_message", id: "s", message: reply({ input: 100 }) } });
		const row = (await replay(store, meta)).get("p/m");
		assert.deepEqual([row?.user, row?.injected, row?.toolResults], [100, 0, 0]);
	});
});

test("切换模型后的用户轮次由新请求归属，尚未收到回复也不会记给旧模型", async () => {
	await withStore(async (store, root) => {
		const meta = await store.create(root, "a");
		await store.append(meta, { type: "message", message: user("first") });
		await store.append(meta, { type: "message", message: reply({ model: "a" }) });
		await store.append(meta, { type: "message", message: user("second") });
		await store.append(meta, { type: "event", event: { type: "request", provider: "p", model: "b", messageCount: 3 } });
		const rows = await replay(store, meta);
		assert.equal(rows.get("p/a")?.turns, 1);
		assert.equal(rows.get("p/b")?.turns, 1);
	});
});
