/**
 * 撤回、编辑重发时的计数：`truncateFrom` 不再在写锁里把整份日志回放第二遍，改用第一遍的结果按
 * 截断点算（`countsAfterCut`）。这里拿两种算法对拍——每一个截断点上，省掉的那一遍回放会算出来的
 * 数，和现在直接算出来的一模一样。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { countsAfterCut, replayRecords } from "../src/session/replay-records.ts";
import { SessionStore, type SessionRecord, type SessionRecordInput } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type Message, type Usage } from "../src/types.ts";

const usage = (total: number): Usage => ({ ...emptyUsage(), input: total, total });
const reply = (text: string, total: number): AssistantMessage =>
	({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "p", model: "m", usage: usage(total), stopReason: "stop", timestamp: 1 });
const user = (text: string, synthetic = false): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1, ...(synthetic ? { synthetic: true } : {}) });

/** 一段混着回复、旁路用量、子代理回复、合成消息、工具结果和一次旧截断的日志。 */
function inputs(): SessionRecordInput[] {
	return [
		{ type: "message", message: user("q1") },
		{ type: "usage", source: "title-summary", providerId: "p", modelId: "m", usage: usage(7) },
		{ type: "message", message: reply("a1", 100) },
		{ type: "message", message: user("q2") },
		{ type: "event", event: { type: "subagent_message", id: "s1", message: reply("sub", 500) } },
		{ type: "message", message: { ...reply("", 30), content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {}, argumentsText: "{}" }], stopReason: "toolUse" } },
		{ type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 } },
		{ type: "message", message: reply("a2", 230) },
		{ type: "message", message: user("<report>", true) },
		{ type: "usage", source: "compaction", providerId: "p", modelId: "m", usage: usage(11) },
		{ type: "message", message: reply("a3", 40) },
		{ type: "event", event: { type: "subagent_message", id: "s2", message: reply("sub2", 60) } },
		{ type: "message", message: user("q3") },
		{ type: "message", message: reply("a4", 9) },
	];
}

const pick = ({ usage, turns, replyUsage, steps, subagentUsage }: ReturnType<typeof replayRecords>) => ({ usage, turns, replyUsage, steps, subagentUsage });

test("每一个截断点：按第一遍回放算出的计数，和截断后再回放一遍的一模一样", () => {
	const records: SessionRecord[] = inputs().map((input, at) => ({ seq: at + 1, ts: 1, ...input }) as SessionRecord);
	// 已经撤回过一次的日志：旧截断之后又接着写。
	records.splice(9, 0, { seq: 100, ts: 1, type: "truncate", afterSeq: 8 });
	records.forEach((record, at) => (record.seq = at + 1));
	const replayed = replayRecords(records);
	const last = records.length;
	for (let afterSeq = 0; afterSeq <= last; afterSeq++) {
		const twice = replayRecords([...records, { seq: last + 1, ts: 1, type: "truncate", afterSeq }]);
		assert.deepEqual(countsAfterCut(replayed, afterSeq), pick(twice), `截在 seq ${afterSeq}`);
	}
});

test("truncateFrom 交回的计数和重新打开时回放出来的一样", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-cut-counts-"));
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }));
	const store = new SessionStore(root);
	const messages = inputs().filter((input) => input.type === "message").length;
	for (let index = 0; index < messages; index++) {
		let meta = await store.create("/tmp/project", "m");
		for (const input of inputs()) meta = (await store.append(meta, input)) ?? meta;
		const cut = await store.truncateFrom(meta.id, index);
		assert.ok(cut, `截在第 ${index} 条`);
		const loaded = await store.load(meta.id);
		assert.ok(loaded);
		const counts = (one: typeof cut.meta) => ({ messageCount: one.messageCount, usage: one.usage, turns: one.turns, replyUsage: one.replyUsage, steps: one.steps, subagentUsage: one.subagentUsage });
		assert.deepEqual(counts(cut.meta), counts(loaded.meta), `截在第 ${index} 条`);
		assert.equal(cut.messages.length, loaded.messages.length);
	}
});
