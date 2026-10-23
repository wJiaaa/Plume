/**
 * 一轮正常返回不等于做完了。
 *
 * 服务商出错、原地打转、跑满轮数，`prompt()` 都是正常返回的；任务队列从前只看有没有抛，这几种都
 * 记成「已完成」。`prompt()` 交回它开的那一轮怎么收的场，队列据此落状态。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyFailure } from "../src/ai/failure.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import type { QueuedTask, TurnEnd } from "../src/agent/events.ts";
import { AgentSession } from "../src/runtime/agent-session/session.ts";
import { isResumable, settledAs, TaskQueue } from "../src/runtime/queue/task-queue.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type ModelConfig, type ProviderConfig } from "../src/types.ts";

test("收场落到任务上：做完是完成，出错、打转、跑满是失败，停下是随主会话中断", () => {
	assert.deepEqual(settledAs({ reason: "done" }), { status: "done" });
	assert.deepEqual(settledAs(undefined), { status: "done" }, "没交回收场的按做完算");
	assert.deepEqual(settledAs({ reason: "error", error: "HTTP 401" }), { status: "failed", error: "HTTP 401" });
	assert.deepEqual(settledAs({ reason: "error" }), { status: "failed" });
	assert.deepEqual(settledAs({ reason: "stalled" }), { status: "failed", unfinished: "stalled" });
	assert.deepEqual(settledAs({ reason: "max_turns" }), { status: "failed", unfinished: "max_turns" });
	assert.deepEqual(settledAs({ reason: "aborted" }), { status: "cancelled", cancelledBy: "stop" });
});

function queue(ends: (TurnEnd | void)[]) {
	let ids = 0;
	return new TaskQueue({
		run: async () => ends.shift(),
		busy: () => false,
		changed: async () => {},
		newId: () => `t${++ids}`,
		now: () => 0,
	});
}

const only = (q: TaskQueue): QueuedTask => q.list()[0]!;

test("一轮原地打转停下：任务记成失败、说清是哪一种，可以继续；继续做完后不留上一次的原因", async () => {
	const q = queue([{ reason: "stalled" }, { reason: "done" }]);
	await q.enqueue("改完 a.ts", "side-chat");
	await q.drain();
	assert.equal(only(q).status, "failed");
	assert.equal(only(q).unfinished, "stalled");
	assert.ok(isResumable(only(q)), "失败那一行带「继续」");

	assert.equal(await q.resume(only(q).id), true);
	await q.drain();
	assert.equal(only(q).status, "done");
	assert.equal(only(q).unfinished, undefined);
});

test("一轮因服务商出错收场：任务是失败，带着那句错误", async () => {
	const q = queue([{ reason: "error", error: "HTTP 401" }]);
	await q.enqueue("查一下", "side-chat");
	await q.drain();
	assert.equal(only(q).status, "failed");
	assert.equal(only(q).error, "HTTP 401");
});

const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "gpt-6-astra",
	name: "Fake",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
	supportsThinking: true,
	supportsImages: false,
	supportsTools: true,
};

const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [], permissionMode: "full" };

function reply(text: string, failed = false): AssistantMessage {
	const base: AssistantMessage = { role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "fake", model: "gpt-6-astra", usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() };
	return failed ? { ...base, content: [], stopReason: "error", errorMessage: "HTTP 401", failure: classifyFailure({ from: "status", status: 401 }) } : base;
}

test("prompt 交回的是它自己开的那一轮怎么收的场，不是排在后面那一轮的", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-outcome-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	process.env.PLUME_HOME = home;
	let requests = 0;
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const session = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: new SessionStore(join(root, "sessions")),
		emit: () => {},
		streamFn: async () => {
			requests += 1;
			// 第一轮等测试排好一条 followUp 再失败；排在后面的那一轮正常做完。
			if (requests === 1) {
				await held;
				return reply("", true);
			}
			return reply("好了。");
		},
	});
	try {
		await session.initialize();
		const first = session.prompt([{ type: "text", text: "一" }]);
		while (!session.running) await new Promise((resolve) => setTimeout(resolve, 5));
		const queued = session.prompt([{ type: "text", text: "二" }], { deliver: "followUp" });
		assert.equal(await queued, undefined, "排进别人那一轮的，没有自己的收场");
		release();
		assert.deepEqual(await first, { reason: "error", error: "HTTP 401" });
		assert.equal(requests, 2, "排着的那一轮也跑了");
	} finally {
		session.abort();
		delete process.env.PLUME_HOME;
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});
