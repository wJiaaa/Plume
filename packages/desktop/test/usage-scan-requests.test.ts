/**
 * The request view's half of the scan: hourly buckets keyed by provider and model.
 *
 * Written through the store the way the app writes, like `usage-scan.test.ts`. The one exception is
 * the legacy test, which strips the newer fields off spend rows by hand — that is the only way to
 * get rows shaped like the ones written before spend carried timing.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { SessionStore, type AssistantMessage, type SessionMeta } from "@plume/core";
import { scanUsage } from "../electron/usage-scan.ts";

let home = "";
let store: SessionStore;
let clock = 0;

const AT = new Date(2026, 8, 1, 10, 15).getTime();

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "ly-usage-req-"));
	store = new SessionStore(join(home, "sessions"));
	clock = AT;
	mock.method(Date, "now", () => clock);
});

afterEach(async () => {
	mock.restoreAll();
	store.close();
	await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

function reply(at: number, over: Partial<AssistantMessage> & { output?: number } = {}): AssistantMessage {
	const { output = 400, ...rest } = over;
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "relay",
		model: "gemini-3.7",
		stopReason: "stop",
		usage: { input: 100, output, cacheRead: 900, cacheWrite: 0, total: 1000 + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 } },
		timestamp: at,
		...rest,
	};
}

async function conversation(): Promise<SessionMeta> {
	return store.create("/tmp/proj-a", "relay/gemini-3.7");
}

async function say(meta: SessionMeta, message: AssistantMessage): Promise<void> {
	clock = message.timestamp;
	await store.append(meta, { type: "message", message });
}

describe("scanUsage request buckets", () => {
	it("files a reply under its local hour with its timing", async () => {
		const meta = await conversation();
		await say(meta, reply(AT, { durationMs: 3000, sseDurationMs: 2000 }));
		const { requests } = await scanUsage(store, home);

		assert.equal(requests.length, 1);
		assert.deepEqual(
			{ ...requests[0] },
			{ hour: "2026-09-01 10", provider: "relay", model: "gemini-3.7", requests: 1, input: 100, output: 400, cacheRead: 900, cacheWrite: 0, cost: 0.1, unpriced: 0, timed: 1, timedOutput: 400, streamMs: 2000, firstTokens: 1, firstTokenMs: 1000 },
		);
	});

	it("counts sub-agent and background calls as requests like any reply", async () => {
		const meta = await conversation();
		clock = AT;
		await store.append(meta, { type: "event", event: { type: "subagent_message", id: "a1", message: reply(AT + 1) } });
		await say(meta, reply(AT + 2));
		await store.recordUsage({ source: "memory-extract", providerId: "relay", modelId: "gemini-3.7", usage: reply(AT).usage });
		const { requests } = await scanUsage(store, home);

		assert.equal(requests.reduce((sum, each) => sum + each.requests, 0), 3);
	});

	it("files a cache miss under the request's hour as well as its day", async () => {
		const meta = await conversation();
		// 先读到过一次缓存：没报过缓存的服务商算「不缓存」，不算未命中。
		await say(meta, reply(AT, { usage: { input: 200, output: 10, cacheRead: 5000, cacheWrite: 0, total: 5210, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }));
		await say(meta, reply(AT + 1000, { usage: { input: 6000, output: 10, cacheRead: 0, cacheWrite: 0, total: 6010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }));
		const { buckets, requests } = await scanUsage(store, home);

		assert.ok((buckets[0].cacheMiss?.tokens ?? 0) > 0, "the second request should have read the first one's prefix");
		assert.equal(requests.reduce((sum, each) => sum + (each.cacheMiss?.tokens ?? 0), 0), buckets[0].cacheMiss?.tokens);
	});

	it("counts a reply that arrived in one piece, but not toward speed", async () => {
		const meta = await conversation();
		await say(meta, reply(AT, { durationMs: 900, sseDurationMs: 3 }));
		const { requests } = await scanUsage(store, home);

		assert.equal(requests[0].requests, 1);
		assert.equal(requests[0].timed, 0, "400 tokens in 3ms is not a generation speed");
		assert.equal(requests[0].firstTokens, 1, "the wait for the first token is still real");
	});

	it("measures speed on the attempt that succeeded, not on the retries folded into the bill", async () => {
		const meta = await conversation();
		const last = reply(AT).usage;
		await say(meta, reply(AT, { output: 1000, lastAttemptUsage: { ...last, output: 200 }, durationMs: 2000, sseDurationMs: 1000 }));
		const { requests } = await scanUsage(store, home);

		assert.equal(requests[0].output, 1000);
		assert.equal(requests[0].timedOutput, 200);
	});

	it("fills in timing for rows written before spend carried it, from the replies still on disk", async () => {
		const meta = await conversation();
		await say(meta, reply(AT, { durationMs: 3000, sseDurationMs: 2000 }));
		(store as unknown as { db: { exec(sql: string): void } }).db.exec("UPDATE spend SET call = json_remove(call, '$.durationMs', '$.sseDurationMs')");
		const { requests } = await scanUsage(store, home);

		assert.equal(requests[0].streamMs, 2000);
		assert.equal(requests[0].firstTokenMs, 1000);
	});

	it("adds new rows to the cached buckets instead of starting them again", async () => {
		const meta = await conversation();
		await say(meta, reply(AT));
		await scanUsage(store, home);
		await say(meta, reply(AT + 60_000));
		const { requests } = await scanUsage(store, home);

		assert.equal(requests.length, 1);
		assert.equal(requests[0].requests, 2);
	});
});


it("跨午夜完成的主会话和子代理回复与请求汇总落在同一天", async () => {
	const meta = await conversation();
	const started = new Date(2026, 8, 1, 23, 59).getTime();
	clock = new Date(2026, 8, 2, 0, 1).getTime();
	const message = reply(started, { durationMs: 120_000, sseDurationMs: 60_000 });
	await store.append(meta, { type: "message", message });
	await store.append(meta, { type: "event", event: { type: "subagent_message", id: "s", message } });
	const scan = await scanUsage(store, home);
	assert.deepEqual(scan.requests.map(row => [row.hour, row.requests]), [["2026-09-01 23", 2]]);
	assert.deepEqual(scan.activity.map(row => [row.day, row.replies, row.modelMs]), [["2026-09-01", 2, 240_000]]);
	assert.deepEqual((await scanUsage(store, home)).activity, scan.activity);
});

it("旧计时按主会话和子代理序列匹配，同毫秒启动也不会串用", async () => {
	const meta = await conversation();
	await say(meta, reply(AT, { model: "main", durationMs: 9000, sseDurationMs: 6000 }));
	await store.append(meta, { type: "event", event: { type: "subagent_message", id: "a", message: reply(AT, { model: "a", durationMs: 3000, sseDurationMs: 2000 }) } });
	await store.append(meta, { type: "event", event: { type: "subagent_message", id: "b", message: reply(AT, { model: "b", durationMs: 7000, sseDurationMs: 4000 }) } });
	(store as unknown as { db: { exec(sql: string): void } }).db.exec("UPDATE spend SET call = json_remove(call, '$.durationMs', '$.sseDurationMs')");
	const scan = await scanUsage(store, home);
	assert.deepEqual(scan.requests.map(row => [row.model, row.streamMs, row.firstTokenMs]), [["main", 6000, 3000], ["a", 2000, 1000], ["b", 4000, 3000]]);
	assert.deepEqual((await scanUsage(store, home)).requests, scan.requests);
});

it("同一序列同一毫秒仍不唯一的旧计时不猜配，照常计请求和费用", async () => {
	const meta = await conversation();
	await say(meta, reply(AT, { durationMs: 3000, sseDurationMs: 2000 }));
	await say(meta, reply(AT, { durationMs: 5000, sseDurationMs: 4000 }));
	(store as unknown as { db: { exec(sql: string): void } }).db.exec("UPDATE spend SET call = json_remove(call, '$.durationMs', '$.sseDurationMs')");
	const { requests } = await scanUsage(store, home);
	assert.deepEqual([requests[0].requests, requests[0].cost, requests[0].timed, requests[0].firstTokens], [2, 0.2, 0, 0]);
});

it("旧计时读取失败不会把缺失的计时永久写进成功缓存", async () => {
	const meta = await conversation();
	await say(meta, reply(AT, { durationMs: 3000, sseDurationMs: 2000 }));
	(store as unknown as { db: { exec(sql: string): void } }).db.exec("UPDATE spend SET call = json_remove(call, '$.durationMs', '$.sseDurationMs')");
	const timings = mock.method(store, "replyTimings", async () => { throw new Error("database is locked"); });
	await assert.rejects(scanUsage(store, home), /database is locked/);
	timings.mock.restore();
	const { requests } = await scanUsage(store, home);
	assert.equal(requests[0].streamMs, 2000);
});
