import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEFAULT_SETTINGS, SessionStore, emptyUsage, type Message, type AssistantMessage, type ModelConfig, type ProviderConfig, type Settings } from "@plume/core";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

// The real handlers, with Electron and the live-session hub replaced: starting a session is only counted.
const fixtureUrl = `data:text/javascript,${encodeURIComponent(`
export const handlers = new Map();
export const started = [];
export const ipcMain = { handle: (name, handler) => handlers.set(name, handler) };
export const sessions = new Map();
export const ensureLiveSession = async (id) => { started.push(id); return null; };
const unused = () => { throw new Error("not part of this test"); };
export const editSessionMessage = unused, revertSessionMessage = unused, broadcast = unused, deleteSessions = unused, disposeSession = unused,
	createSession = unused, abortSession = unused, promptSession = unused, setReportBack = unused, sideSessionsOf = unused, snapshot = unused,
	streamingMessage = unused, touchSession = unused, worktreeFollowsArchive = unused;
`)}`;
const source = new URL("../electron/ipc/sessions.ts", import.meta.url).href;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (context.parentURL === source && (specifier === "electron" || specifier === "../session/session-hub.ts")) return { url: fixtureUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const fixture: { handlers: Map<string, Handler>; started: string[]; sessions: Map<string, unknown> } = await import(fixtureUrl);
const { registerSessionsIpc } = await import("../electron/ipc/sessions.ts");
const { storedContext, storedRoster, storedTurn } = await import("../electron/session/stored-readings.ts");
hooks.deregister();

const root = await mkdtemp(join(tmpdir(), "plume-stored-readings-"));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PLUME_HOME: process.env.PLUME_HOME };
Object.assign(process.env, { HOME: root, USERPROFILE: root, PLUME_HOME: join(root, "home") });
const model: ModelConfig = { id: "fixture/model", providerId: "fixture", modelId: "model", name: "Fixture", contextWindow: 200_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const provider: ProviderConfig = { id: "fixture", name: "Fixture", baseUrl: "http://127.0.0.1:1", api: "openai-responses", apiKey: "fixture", enabled: true, models: [model] };
const settings: Settings = { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id, mcpServers: [] };
const reply = (timestamp: number): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text: "done" }], api: provider.api, provider: provider.id, model: model.modelId, usage: emptyUsage(), stopReason: "stop", timestamp });
const store = new SessionStore(join(root, "sessions"));
registerSessionsIpc({ store: () => store, settings: () => settings, saveSettings: async () => {} });
const handler = (name: string) => fixture.handlers.get(name) as Handler;
after(async () => {
	store.close();
	for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	await rm(root, { recursive: true, force: true });
});

/** A conversation that has sent one request, in its own project directory, with one sub-agent on its roster. */
async function conversation(name: string) {
	const cwd = join(root, name);
	await mkdir(cwd, { recursive: true });
	const meta = await store.create(cwd, model.id);
	// 写法和 `SessionLog` 落盘的一样：上一次请求发出去的 prompt 与工具表，加上历史。
	await store.append(meta, { type: "event", event: { type: "context", systemPrompt: "PROMPT", tools: [], skills: [], schemas: [], sections: [], mcpTools: [] } });
	const log = { commit: (message: Message) => store.append(meta, { type: "message", message }) };
	await log.commit({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 10 });
	await log.commit(reply(11));
	await store.append(meta, { type: "event", event: { type: "subagent", id: "s:sub:1", agent: "general", description: "梳理", prompt: "梳理登录流程", tools: [] } });
	return { id: meta.id, cwd, meta, log };
}

/** How many times the log was actually read for this session — what a cache hit must not do. */
function countReads(sessionId: string) {
	const counts = { read: 0, subAgents: 0, load: 0 };
	const { read, subAgentRecords, load } = store;
	store.read = function (id, ...rest) { if (id === sessionId) counts.read++; return read.call(this, id, ...rest); };
	store.subAgentRecords = function (id) { if (id === sessionId) counts.subAgents++; return subAgentRecords.call(this, id); };
	store.load = function (id, ...rest) { if (id === sessionId) counts.load++; return load.call(this, id, ...rest); };
	return { counts, restore: () => Object.assign(store, { read, subAgentRecords, load }) };
}

test("a cold conversation's meter and sub-agent roster are answered from its log without starting it", async () => {
	const { id } = await conversation("cold");
	fixture.started.length = 0;
	const before = fixture.sessions.size;
	const breakdown = (await handler("sessions:contextBreakdown")({}, id)) as { limit: number } | null;
	assert.equal(breakdown?.limit, model.contextWindow);
	const roster = (await handler("subagents:list")({}, id)) as { id: string; description: string }[];
	assert.deepEqual(roster.map((one) => [one.id, one.description]), [["s:sub:1", "梳理"]]);
	const detail = (await handler("subagents:detail")({}, id, "s:sub:1")) as { id: string } | null;
	assert.equal(detail?.id, "s:sub:1", "the detail is read from the log on demand");
	assert.deepEqual(fixture.started, [], "nothing was started");
	assert.equal(fixture.sessions.size, before, "no live session appeared");
});

test("a conversation whose log cannot answer the meter still falls back to starting it", async () => {
	const meta = await store.create(join(root, "silent"), model.id);
	fixture.started.length = 0;
	assert.equal(await handler("sessions:contextBreakdown")({}, meta.id), null);
	assert.deepEqual(fixture.started, [meta.id], "no request recorded yet: only a started session can assemble a preview");
});

test("readings are kept until the log moves", async () => {
	const { id, log } = await conversation("seq");
	const first = await storedContext(store, id, settings);
	const roster = await storedRoster(store, id, settings);
	const { counts, restore } = countReads(id);
	try {
		assert.equal(await storedContext(store, id, settings), first);
		assert.equal(await storedRoster(store, id, settings), roster);
		assert.deepEqual(counts, { read: 0, subAgents: 0, load: 0 }, "a second visit reads nothing");
		await log.commit({ role: "user", content: [{ type: "text", text: "more" }], timestamp: 12 });
		assert.notEqual(await storedContext(store, id, settings), first, "the log moved: read again");
		await storedRoster(store, id, settings);
		assert.ok(counts.read > 0 && counts.subAgents > 0);
	} finally {
		restore();
	}
});

test("readings are dropped when the settings or the project's settings file change, and the log has not", async () => {
	const { id, cwd } = await conversation("settings");
	const first = await storedContext(store, id, settings);
	assert.ok(first);
	const replaced = { ...settings };
	assert.notEqual(await storedContext(store, id, replaced), first, "new settings object: read again");
	const kept = await storedContext(store, id, replaced);
	assert.equal(await storedContext(store, id, replaced), kept);
	// 项目设置文件出现了：日志一行没动，读数也要重读。
	await mkdir(join(cwd, ".plume"), { recursive: true });
	await writeFile(join(cwd, ".plume", "config.json"), JSON.stringify({ providers: [] }));
	const { counts, restore } = countReads(id);
	try {
		await storedContext(store, id, replaced);
		assert.ok(counts.read > 0, "the project file appeared: read again");
	} finally {
		restore();
	}
});

test("a failed read is not kept: the next visit tries again", async () => {
	const { id } = await conversation("failure");
	const { read } = store;
	store.read = function (sessionId, ...rest) {
		if (sessionId === id) throw new Error("disk hiccup");
		return read.call(this, sessionId, ...rest);
	};
	try {
		await assert.rejects(storedContext(store, id, settings), /disk hiccup/);
	} finally {
		store.read = read;
	}
	assert.ok(await storedContext(store, id, settings), "answered once the disk does");
});

test("a failed turn read is not kept either", async () => {
	const { id } = await conversation("turn-failure");
	const { load } = store;
	store.load = async (sessionId, ...rest) => (sessionId === id ? null : load.call(store, sessionId, ...rest));
	const seq = (await store.get(id))!.seq;
	try {
		assert.equal(await storedTurn(store, id, seq, 11), null, "没读到记录");
	} finally {
		store.load = load;
	}
	const turn = await storedTurn(store, id, seq, 11);
	assert.ok(turn && turn.length > 0, "the turn is read again rather than failing until the log moves");
});

test("a turn is read once per log position, and again once the log moves", async () => {
	const { id, log } = await conversation("turns");
	const seq = (await store.get(id))!.seq;
	const first = await storedTurn(store, id, seq, 11);
	const { counts, restore } = countReads(id);
	try {
		assert.equal(await storedTurn(store, id, seq, 11), first);
		assert.equal(counts.load, 0);
		await log.commit({ role: "user", content: [{ type: "text", text: "more" }], timestamp: 12 });
		await storedTurn(store, id, (await store.get(id))!.seq, 11);
		assert.equal(counts.load, 1);
	} finally {
		restore();
	}
});
