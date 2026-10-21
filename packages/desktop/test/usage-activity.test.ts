/**
 * 用量页两张环图那份数：增量缓存续读不重数、删掉的会话跟着消失，区间和筛选里的会话跨天去重。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it, mock } from "node:test";
import { emptyUsage, SessionStore, type AssistantMessage, type ToolResultMessage } from "@plume/core";
import { scanActivity } from "../electron/usage-activity.ts";
import { activityTotals, timeSegments, type ActivityTotals } from "../src/features/settings/usage-activity.ts";
import { formatDuration } from "../src/features/settings/usage-format.ts";

let home = "";
let store: SessionStore;
let clock = 0;

const DAY_1 = new Date(2026, 8, 1, 10, 0).getTime();
const DAY_2 = new Date(2026, 8, 2, 10, 0).getTime();

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "ly-usage-activity-"));
	store = new SessionStore(join(home, "sessions"));
	clock = DAY_1;
	mock.method(Date, "now", () => clock);
});

afterEach(async () => {
	mock.restoreAll();
	store.close();
	await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

const reply = (model: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-responses", provider: "p", model, stopReason: "stop", usage: { ...emptyUsage(), input: 100 }, timestamp: clock });
const all = { from: null, to: null, provider: null, query: "" };
const describe = (row: { provider: string; model: string }) => `${row.model} ${row.provider}`;
const tool = (durationMs: number): ToolResultMessage => ({ role: "toolResult", toolCallId: `c${durationMs}`, toolName: "bash", content: [], isError: false, durationMs, timestamp: clock });

it("续读只加新记录，删掉的会话连同它的行一起不见", async () => {
	const kept = await store.create(home, "m");
	const gone = await store.create(home, "m");
	await store.append(kept, { type: "message", message: tool(100) });
	await store.append(gone, { type: "message", message: tool(900) });
	assert.equal((await scanActivity(store, home)).reduce((sum, row) => sum + row.toolMs, 0), 1000);

	await store.append(kept, { type: "message", message: tool(30) });
	clock = DAY_2;
	await store.append(kept, { type: "message", message: tool(5) });
	await store.delete(gone.id);
	const rows = await scanActivity(store, home);
	assert.deepEqual(rows.map((row) => [row.day, row.session, row.tools, row.toolMs]).sort(), [
		["2026-09-01", kept.id, 2, 130],
		["2026-09-02", kept.id, 1, 5],
	]);
	assert.deepEqual(await scanActivity(store, home), rows, "没有新记录时读回同一份");
});

it("区间和筛选里的会话跨天去重，归档的单独数，工具记在它前面那次回复的模型上", async () => {
	const kept = await store.create(home, "m");
	await store.append(kept, { type: "message", message: reply("big") });
	await store.append(kept, { type: "message", message: tool(100) });
	clock = DAY_2;
	await store.append(kept, { type: "message", message: reply("small") });
	await store.append(kept, { type: "message", message: tool(50) });
	await store.setArchived(kept.id, true);
	const rows = await scanActivity(store, home);
	const totals = activityTotals(rows, all, describe);
	assert.deepEqual([totals.sessions, totals.archived, totals.tools, totals.toolMs, totals.replies], [1, 1, 2, 150, 2]);
	assert.equal(activityTotals(rows, { ...all, from: "2026-09-02", to: "2026-09-02" }, describe).toolMs, 50);
	assert.equal(activityTotals(rows, { ...all, query: "big" }, describe).toolMs, 100, "搜模型名只剩它那次回复之后的工具");
});

it("思考从生成里扣出来，等首字是总时长减生成", () => {
	const totals = { sessions: 1, archived: 0, turns: 1, replies: 2, timedReplies: 2, modelMs: 10_000, streamMs: 6000, thinkingMs: 2500, tools: 1, toolErrors: 0, toolMs: 3000 } as ActivityTotals;
	assert.deepEqual(Object.fromEntries(timeSegments(totals).map((each) => [each.key, each.value])), { wait: 4000, thinking: 2500, reply: 3500, tool: 3000 });
});

it("耗时的单位跟着量级走", () => {
	assert.deepEqual([450, 9_949, 9_960, 59_600, 931_000, 7_500_000].map(formatDuration), ["450ms", "9.9s", "10s", "1m00s", "15m31s", "2h05m"]);
});


it("扫描只累计游标快照以内的记录，并发追加留给下次且只算一次", async () => {
	const meta = await store.create(home, "m");
	await store.append(meta, { type: "message", message: tool(100) });
	const cursors = store.usageCursors.bind(store);
	let appended = false;
	mock.method(store, "usageCursors", async () => {
		const snapshot = await cursors();
		if (!appended) {
			appended = true;
			await store.append(meta, { type: "message", message: tool(30) });
		}
		return snapshot;
	});
	const total = async () => (await scanActivity(store, home)).reduce((sum, row) => sum + row.toolMs, 0);
	assert.equal(await total(), 100);
	assert.equal(await total(), 130);
	assert.equal(await total(), 130);
});
