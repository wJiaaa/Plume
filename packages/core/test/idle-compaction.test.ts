/**
 * 会话层的两处分叉：一轮收尾、缓存还热时先压掉越线的历史；`/compact` 也从上一次请求分叉。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent/events.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/agent-session/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type ModelConfig, type ProviderConfig } from "../src/types.ts";

// 触发线 30k（40k 减去摘要要的 8k 和余量 2k，比 80% 更早）。
const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 40_000, maxOutputTokens: 4000, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [], permissionMode: "full" };
const SUMMARY = "## Goal & Original User Intent\n回答四个问题。";
const PROMPTS = 4;

const reply = (text: string, input = 0): AssistantMessage => ({
	role: "assistant", content: [{ type: "text", text }], api: PROVIDER.api, provider: PROVIDER.id, model: MODEL.modelId,
	usage: { ...emptyUsage(), input, total: input }, stopReason: "stop", timestamp: Date.now(),
});

/** 主请求照常回答，最后一轮报一个越线的用量；末尾是摘要指令的就交摘要。记下每个摘要请求。 */
function provider() {
	const summaries: LlmContext[] = [];
	const turns: LlmContext[] = [];
	const streamFn = async (context: LlmContext): Promise<AssistantMessage> => {
		const last = context.messages.at(-1);
		if (last?.role === "user" && JSON.stringify(last.content).includes("## Goal & Original User Intent")) {
			summaries.push(context);
			return reply(SUMMARY);
		}
		turns.push({ ...context, messages: [...context.messages] });
		// 回答要有正文：历史若只剩用户原话，原话照抄进压缩头，压缩缩不下去（见 `USER_WORDS_FLOOR`）。
		return reply(`第 ${turns.length} 个回答：${"分析结果".repeat(500)}`, turns.length === PROMPTS ? 31_000 : 1000);
	};
	return { streamFn, summaries, turns };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function withSession(options: { compactWhenIdle?: boolean }, work: (session: AgentSession, events: AgentEvent[], wire: ReturnType<typeof provider>) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "ly-idle-compact-"));
	const events: AgentEvent[] = [];
	const wire = provider();
	const session = new AgentSession({ cwd: root, settings: SETTINGS, store: new SessionStore(join(root, "sessions")), emit: (event) => { events.push(event); }, streamFn: wire.streamFn, ...options });
	await session.initialize();
	try {
		for (let i = 0; i < PROMPTS; i++) await session.prompt([{ type: "text", text: `问题 ${i}：${"请详细说明".repeat(400)}` }]);
		await work(session, events, wire);
	} finally {
		await session.dispose();
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
}

test("a turn that ends over the line is compacted right away, forked from its last request", async () => {
	await withSession({ compactWhenIdle: true }, async (session, events, wire) => {
		await until(() => events.some((event) => event.type === "compacted"));
		const compacted = events.find((event) => event.type === "compacted");
		assert.equal(compacted?.type === "compacted" && compacted.via, "fork");
		assert.ok(events.findLastIndex((event) => event.type === "agent_end") < events.indexOf(compacted!), "after the turn, not inside it");

		assert.equal(wire.summaries.length, 1);
		const [summary] = wire.summaries;
		const last = wire.turns.at(-1)!;
		assert.equal(summary.systemPrompt, last.systemPrompt, "same system prompt");
		assert.deepEqual(summary.tools, last.tools, "same tools");
		assert.deepEqual(summary.messages.slice(0, last.messages.length), last.messages, "the last request's messages lead");

		await until(() => session.log.compaction !== null);
		assert.equal(session.log.compaction?.summary, SUMMARY, "and the boundary is written down");
	});
});

test("without the host asking for it, nothing is compacted between turns", async () => {
	await withSession({}, async (_session, events, wire) => {
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(events.some((event) => event.type === "compacted"), false);
		assert.equal(wire.summaries.length, 0);
	});
});

test("/compact forks from the last request while the cache is warm", async () => {
	await withSession({}, async (session, events, wire) => {
		const outcome = await session.compact();
		assert.ok(outcome.ok, JSON.stringify(outcome));
		const compacted = events.find((event) => event.type === "compacted");
		assert.equal(compacted?.type === "compacted" && compacted.via, "fork");
		assert.equal(wire.summaries.length, 1);
		assert.ok(wire.summaries[0].tools.length > 0, "the main request's tools ride along");
		assert.equal(wire.summaries[0].systemPrompt, wire.turns.at(-1)!.systemPrompt);
	});
});

test("a prune adopted while idle is not undone by the reply measured before it", async () => {
	/*
	 * 收尾时只剪枝就收下，人再开口时中间没有新请求。计量若还信剪枝前那条回复的用量，就照旧越线，
	 * 而已经没东西可剪——于是走一次不需要的独立摘要（`20ec7460` seq 2555→2562）。
	 */
	const root = await mkdtemp(join(tmpdir(), "ly-idle-prune-"));
	const { writeFile } = await import("node:fs/promises");
	await writeFile(join(root, "big.txt"), Array.from({ length: 1200 }, (_, i) => `第 ${i} 行：${"内容".repeat(12)}`).join("\n"));
	const events: AgentEvent[] = [];
	const summaries: LlmContext[] = [];
	let step = 0;
	const call = (id: string): AssistantMessage => ({
		role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "big.txt" }, argumentsText: '{"path":"big.txt"}' }],
		api: PROVIDER.api, provider: PROVIDER.id, model: MODEL.modelId, usage: { ...emptyUsage(), input: 1000, total: 1000 }, stopReason: "toolUse", timestamp: Date.now(),
	});
	const streamFn = async (context: LlmContext): Promise<AssistantMessage> => {
		const last = context.messages.at(-1);
		if (last?.role === "user" && JSON.stringify(last.content).includes("## Goal & Original User Intent")) {
			summaries.push(context);
			return reply(SUMMARY);
		}
		step += 1;
		if (step === 1) return call("r1");
		if (step === 2) return call("r2");
		// 第二次读完越线：同一个文件读了两遍，剪掉前一份就回到线下。
		return reply(`第 ${step} 个回答`, step === 3 ? 31_000 : 1000);
	};
	const session = new AgentSession({ cwd: root, settings: SETTINGS, store: new SessionStore(join(root, "sessions")), emit: (event) => { events.push(event); }, streamFn, compactWhenIdle: true });
	await session.initialize();
	try {
		await session.prompt([{ type: "text", text: "读两遍 big.txt" }]);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.ok(events.some((event) => event.type === "compacted" && event.kept === undefined), "收尾时剪掉了，趁缓存还热");
		await session.prompt([{ type: "text", text: "接着说" }]);
		assert.equal(summaries.length, 0, "剪过之后没有新请求量过，旧用量不算数，不该再做一次摘要");
	} finally {
		await session.dispose();
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});

test("a prune adopted while idle still counts after a restart", async () => {
	// 收尾剪完就关掉窗口：重开之后第一句话前同样没有新请求，旧用量照样不能算数。
	const root = await mkdtemp(join(tmpdir(), "ly-idle-prune-restart-"));
	const { writeFile } = await import("node:fs/promises");
	await writeFile(join(root, "big.txt"), Array.from({ length: 1200 }, (_, i) => `第 ${i} 行：${"内容".repeat(12)}`).join("\n"));
	const events: AgentEvent[] = [];
	const summaries: LlmContext[] = [];
	let step = 0;
	const call = (id: string): AssistantMessage => ({
		role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "big.txt" }, argumentsText: '{"path":"big.txt"}' }],
		api: PROVIDER.api, provider: PROVIDER.id, model: MODEL.modelId, usage: { ...emptyUsage(), input: 1000, total: 1000 }, stopReason: "toolUse", timestamp: Date.now(),
	});
	const streamFn = async (context: LlmContext): Promise<AssistantMessage> => {
		const last = context.messages.at(-1);
		if (last?.role === "user" && JSON.stringify(last.content).includes("## Goal & Original User Intent")) {
			summaries.push(context);
			return reply(SUMMARY);
		}
		step += 1;
		if (step === 1) return call("r1");
		if (step === 2) return call("r2");
		return reply(`第 ${step} 个回答`, step === 3 ? 31_000 : 1000);
	};
	const store = new SessionStore(join(root, "sessions"));
	const first = new AgentSession({ cwd: root, settings: SETTINGS, store, emit: (event) => { events.push(event); }, streamFn, compactWhenIdle: true });
	await first.initialize();
	let reopened: AgentSession | undefined;
	try {
		await first.prompt([{ type: "text", text: "读两遍 big.txt" }]);
		await until(() => events.some((event) => event.type === "compacted" && event.kept === undefined));
		await new Promise((resolve) => setTimeout(resolve, 100));
		await first.dispose();

		const loaded = await store.load(first.meta.id);
		assert.ok(loaded);
		reopened = new AgentSession({ cwd: root, settings: SETTINGS, store, meta: loaded.meta, emit: () => {}, streamFn });
		reopened.restore(loaded.messages, loaded.compaction);
		await reopened.initialize();
		await reopened.prompt([{ type: "text", text: "接着说" }]);
		assert.equal(summaries.length, 0, "重启后同样不信剪枝前那条回复的用量");
	} finally {
		await reopened?.dispose();
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});

test("按停时后台子代理还没回来：会话随之闲下来，也不再发收尾后的摘要请求；等着的只挂一个", async () => {
	/*
	 * 停止按钮收回放了手的子代理（`dispatches.forget()`），会话当场闲下来。登记在收尾那一刻的压缩
	 * 不看这一眼，就在人按了停之后发一次付费的摘要请求。
	 */
	const root = await mkdtemp(join(tmpdir(), "ly-idle-stop-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	const saved = { PLUME_HOME: process.env.PLUME_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	Object.assign(process.env, { PLUME_HOME: home, HOME: home, USERPROFILE: home });
	const summaries: LlmContext[] = [];
	let main = 0;
	const streamFn = async (context: LlmContext, request?: { signal?: AbortSignal }): Promise<AssistantMessage> => {
		const last = context.messages.at(-1);
		if (last?.role === "user" && JSON.stringify(last.content).includes("## Goal & Original User Intent")) {
			summaries.push(context);
			return reply(SUMMARY);
		}
		if (!context.tools.some((tool) => tool.name === "task")) {
			if (context.tools.length === 0) return reply("{}");
			// 后台子代理：一直不回来，直到被停下。
			await new Promise<void>((resolve) => request?.signal?.addEventListener("abort", () => resolve(), { once: true }));
			return { ...reply(""), stopReason: "aborted" };
		}
		main += 1;
		if (main === 1) {
			return {
				...reply(""), stopReason: "toolUse",
				content: [{ type: "toolCall", id: "t1", name: "task", arguments: { description: "审查 a.ts", prompt: "看看 a.ts", subagent_type: "general" }, argumentsText: "{}" }],
			};
		}
		// 最后一轮越线：放在平时，收尾后就该趁热压掉。
		return reply(`第 ${main} 个回答`, main === PROMPTS + 1 ? 31_000 : 1000);
	};
	const settings: Settings = { ...SETTINGS, maxConcurrentSubAgents: 4, subAgentDelegation: "eager" };
	const session = new AgentSession({ cwd: root, settings, store: new SessionStore(join(root, "sessions")), emit: () => {}, streamFn, compactWhenIdle: true });
	await session.initialize();
	try {
		for (let i = 0; i < PROMPTS; i++) await session.prompt([{ type: "text", text: `问题 ${i}：${"请详细说明".repeat(400)}` }]);
		assert.equal(session.subAgents.list().length, 1, "子代理派出去了");
		assert.equal(session.idle, false, "它没回来，会话不算闲");
		// 每一轮收尾都登记一次压缩：从前每次多挂一个等待者，子代理一跑半小时就攒几十个。
		const waiters = Reflect.get(session, "idleWaiters") as unknown[];
		assert.ok(waiters.length <= 1, `等着闲下来的只有一个，实际 ${waiters.length}`);

		session.abort();
		await until(() => session.idle);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(summaries.length, 0, "按了停，不再花钱压缩");
	} finally {
		await session.dispose();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});
