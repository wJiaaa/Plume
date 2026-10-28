/**
 * 会话运行时几条少走的路：换模型后撤回、一轮抛了异常、处置时正在重载、写盘失败。
 *
 * 每条都是平时看不出来、一旦走到就会留下错状态的地方：旧模型的推理句柄被发给新模型（跨服务商时整条
 * 拒收）、插话判断卡在「还在跑」、处置过的会话又挂上一个监听、没写进去的消息留在发给模型的历史里。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import { AgentSession } from "../src/runtime/agent-session/session.ts";
import { SessionLog } from "../src/runtime/record/session-log.ts";
import { SessionStore, type SessionMeta } from "../src/session/store.ts";
import type { SessionStorage } from "../src/session/storage.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const model = (provider: string, id: string): ModelConfig => ({
	id: `${provider}/${id}`, providerId: provider, modelId: id, name: id, contextWindow: 100_000,
	maxOutputTokens: 4096, supportsThinking: true, supportsImages: false, supportsTools: true,
});
const A = model("pa", "model-a");
const B = model("pb", "model-b");
const PROVIDERS: ProviderConfig[] = [
	{ id: "pa", name: "A", baseUrl: "http://localhost", api: "anthropic-messages", apiKey: "x", enabled: true, models: [A] },
	{ id: "pb", name: "B", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [B] },
];
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: PROVIDERS, defaultModelId: A.id, mcpServers: [], permissionMode: "full", autoSummarizeTitle: false };

const textOf = (message: Message) => (Array.isArray(message.content) ? message.content.map((part) => ("text" in part ? part.text : "")).join("") : message.content);
const users = (messages: readonly Message[]) => messages.filter((message) => message.role === "user" && !message.synthetic).map(textOf);

let root: string;
const saved = { PLUME_HOME: process.env.PLUME_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

before(async () => {
	root = await mkdtemp(join(tmpdir(), "ly-runtime-edges-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	Object.assign(process.env, { PLUME_HOME: home, HOME: home, USERPROFILE: home });
});

after(async () => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

/** 每个模型的回复都带着它自己那一家的签名：`sig-<modelId>`。 */
const signed = (context: LlmContext, request: { provider: ProviderConfig; model: ModelConfig }): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "thinking", thinking: "想一想", signature: `sig-${request.model.modelId}` }, { type: "text", text: `${request.model.modelId} 答 ${context.messages.length}` }],
	api: request.provider.api, provider: request.provider.id, model: request.model.modelId,
	usage: emptyUsage(), stopReason: "stop", timestamp: Date.now(),
});
/** 每条回复带着的签名，按回复的顺序；剥掉了的是空串。 */
const signatures = (messages: readonly Message[]) =>
	messages.flatMap((message) => message.role === "assistant" ? [message.content.flatMap((part) => (part.type === "thinking" && part.signature ? [part.signature] : [])).join(",")] : []);

test("换了模型再编辑重发：发给新模型的历史里没有旧模型的签名，重开后新模型自己的签名还在", async () => {
	const dir = join(root, "switch-edit");
	await mkdir(dir, { recursive: true });
	const store = new SessionStore(join(dir, "sessions"));
	const sent: LlmContext[] = [];
	const session = new AgentSession({
		cwd: dir, settings: SETTINGS, store, emit: () => {},
		streamFn: async (context, request) => { sent.push(structuredClone(context)); return signed(context, request); },
	});
	await session.initialize();
	try {
		await session.prompt([{ type: "text", text: "Q1" }]);
		await session.prompt([{ type: "text", text: "Q2" }]);
		await session.setModel(B.id);
		await session.editAndResend(2, [{ type: "text", text: "Q2 改过" }]);

		const toB = sent.at(-1)!;
		assert.ok(!JSON.stringify(toB.messages).includes("sig-model-a"), `发给 B 的历史里不该有 A 的签名：${JSON.stringify(signatures(toB.messages))}`);
		assert.deepEqual(signatures(session.messages), ["", "sig-model-b"]);

		const loaded = (await store.load(session.meta.id))!;
		assert.equal(loaded.meta.modelSwitchedAt, 2, "截到换模型之前，切换点跟着挪到截断处");
		const reopened = new AgentSession({ cwd: dir, settings: SETTINGS, store, meta: loaded.meta, emit: () => {} });
		await reopened.initialize();
		reopened.restore(loaded.messages, loaded.compaction, loaded.compactions);
		assert.deepEqual(signatures(reopened.messages), ["", "sig-model-b"], "重开后 B 自己的签名不被当成换模型之前的剥掉");
		await reopened.dispose();
	} finally {
		await session.dispose();
	}
});

test("一轮抛了异常：补一条 agent_end 落盘，排在后面的照样发、顺序不乱", async () => {
	const dir = join(root, "throws");
	await mkdir(dir, { recursive: true });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let calls = 0;
	let started!: () => void;
	const asked = new Promise<void>((resolve) => (started = resolve));
	const events: AgentEvent[] = [];
	const store = new SessionStore(join(dir, "sessions"));
	const written: AgentEvent[] = [];
	const append = store.append.bind(store);
	store.append = async (meta, payload, options) => {
		if (payload.type === "event") written.push(payload.event);
		return append(meta, payload, options);
	};
	const session = new AgentSession({
		cwd: dir, settings: SETTINGS, store, emit: (event) => void events.push(event),
		streamFn: async (context, request) => {
			calls += 1;
			started();
			if (calls === 1) {
				await gate;
				throw new Error("宿主那边坏了");
			}
			return signed(context, request);
		},
	});
	await session.initialize();
	try {
		const first = session.prompt([{ type: "text", text: "one" }]);
		await asked;
		await session.prompt([{ type: "text", text: "two" }], { deliver: "followUp" });
		release();
		await assert.rejects(first, /宿主那边坏了/);

		const end = events.find((event) => event.type === "agent_end");
		assert.equal(end?.type === "agent_end" && end.reason, "error", "抛出来的那一轮也有结尾");
		assert.ok(written.some((event) => event.type === "agent_end" && event.reason === "error"), "那条结尾落了盘");
		assert.deepEqual(users(session.messages), ["one", "two"], "排着的那句在这一轮之后就发了，没有滞留");
		assert.equal(session.messages.at(-1)?.role, "assistant", "排着的那句有人回答");

		await session.prompt([{ type: "text", text: "three" }]);
		assert.deepEqual(users(session.messages), ["one", "two", "three"], "下一句开的是新回合，不是被当成插话塞进一个不在了的回合");
	} finally {
		release();
		await session.dispose();
	}
});

test("重载能力的时候会话被处置：重载完不再挂回文件监听", async () => {
	const dir = join(root, "reload-dispose");
	await mkdir(join(dir, ".plume", "skills", "one"), { recursive: true });
	await writeFile(join(dir, ".plume", "skills", "one", "SKILL.md"), "---\nname: one\ndescription: 用来让目录被监听\n---\n正文\n");
	const meta = { id: "s-reload", projectId: "p", cwd: dir, modelId: A.id, title: "", createdAt: 0, updatedAt: 0 } as unknown as SessionMeta;
	const stub = { append: async (current: SessionMeta) => current, create: async () => meta } as unknown as SessionStorage;
	const session = new AgentSession({ cwd: dir, settings: SETTINGS, store: stub, meta, emit: () => {} });
	await session.initialize();
	const watcher = () => (session as unknown as { watcher: { close(): void } | null }).watcher;
	assert.ok(watcher(), "起步时在监听");

	const reload = session.reloadCapabilities();
	await session.dispose();
	await reload;
	const left = watcher();
	left?.close();
	assert.equal(left, null, "处置过的会话不该再有监听");
});

test("非回复的消息写盘失败：内存里也不留，下一次请求不会把它发出去", async () => {
	const dir = join(root, "commit-fails");
	await mkdir(dir, { recursive: true });
	const store = new SessionStore(join(dir, "sessions"));
	const meta = await store.create(dir, A.id);
	const log = new SessionLog(store, async () => {}, meta);
	const append = store.append.bind(store);
	store.append = async () => { throw new Error("磁盘满了"); };
	const message: Message = { role: "user", content: [{ type: "text", text: "带图的那句" }], timestamp: Date.now() };
	await assert.rejects(log.commit(message), /磁盘满了/);
	assert.equal(log.messages.length, 0, "没写进去的不在历史里");

	store.append = append;
	await log.commit(message);
	assert.equal(log.messages.length, 1, "同一条消息之后还能再写");
});
