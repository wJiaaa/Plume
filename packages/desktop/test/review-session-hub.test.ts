/**
 * `review_session` 在会话中枢里接上的那一段：原会话那次调用一结束，就有一个挂在它下面、要交回的审阅会话，
 * 开在原会话此刻的目录里——哪怕设置要求新会话自己开工作树；第一条消息里的原话读自存储里的完整历史，
 * 压缩掉的也在；第一轮结束，回复送回原会话。
 *
 * 单测（`review-session.test.ts`）证明了规则；这里守的是中枢没有把它绕回建议卡片那条路：`createSession`
 * 会经 `ownWorkspace`、按设置开新工作树，`prompt-input` 的白名单会丢掉 `review`。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, SessionStore, type AgentEvent, type Settings } from "@plume/core";

// Electron is not there under node; every name it exports is a no-op that answers anything.
const electronUrl = `data:text/javascript,${encodeURIComponent(`
const any = new Proxy(function () {}, { get: (_, key) => (key === "then" ? undefined : any), apply: () => any, construct: () => any });
export const app = any, BrowserWindow = any, clipboard = any, contextBridge = any, desktopCapturer = any, dialog = any,
	globalShortcut = any, ipcMain = any, ipcRenderer = any, Menu = any, nativeImage = any, nativeTheme = any, net = any,
	Notification = any, powerSaveBlocker = any, protocol = any, screen = any, session = any, shell = any,
	systemPreferences = any, Tray = any, webContents = any, webUtils = any;
export default any;
`)}`;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "electron") return { url: electronUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const hub = await import("../electron/session/session-hub.ts");
const { reviewRequest } = await import("../electron/session/review-session.ts");
hooks.deregister();

const home = await mkdtemp(join(tmpdir(), "plume-review-hub-"));
process.env.PLUME_HOME = home;
test.after(() => rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }));

const store = new SessionStore(join(home, "sessions"));
// 新会话默认开自己的工作树：审阅会话不能听这个设置。
const settings = { ...DEFAULT_SETTINGS, worktrees: { ...DEFAULT_SETTINGS.worktrees, autoCreateOnNewSession: true } } as Settings;
hub.configureHub({ store: () => store, settings: () => settings, window: () => null });

async function until<T>(read: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> {
	for (let i = 0; i < 400; i++) {
		const value = await read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`等不到：${what}`);
}

test("调用结束：同一目录、挂在原会话下、要交回的审阅会话；第一轮结束报告送回原会话", async () => {
	// 原会话开在一棵工作树里：那个目录不是项目目录。
	const worktree = join(home, "worktrees", "oauth");
	await mkdir(worktree, { recursive: true });
	const meta = await store.create(worktree, "qa/model", "登录改走 OAuth", { project: "proj-1" });
	const reports: unknown[] = [];
	const parent = {
		meta,
		cwd: worktree,
		running: false,
		idle: true,
		messages: [] as unknown[],
		can: { state: new Map() },
		subAgents: { list: () => [] },
		wakeups: { list: () => [] },
		initialize: async () => {},
		dispose: async () => {},
		receiveSessionReport: (report: unknown) => reports.push(report),
	};
	hub.sessions.set(meta.id, parent as never);
	// 存储里是完整的历史：最初的需求、一次压缩、之后的一句。眼下的 `messages` 是空的，像被压缩换掉了一样。
	const said = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }) as never;
	let stored = (await store.append(meta, { type: "message", message: said("最初的需求：登录改走 OAuth") } as never)) ?? meta;
	stored = (await store.append(stored, { type: "event", event: { type: "compacted", before: 1000, after: 100, summary: "（摘要）", kept: 0 } } as never)) ?? stored;
	await store.append(stored, { type: "message", message: said("回调地址读配置") } as never);

	const details = reviewRequest({
		background: "用户说登录只能用密码，公司要求接入 OAuth，让我给登录加一条 OAuth 回调路由。",
		decisions: "用户说「不要动 session.ts」。",
		implementation: "在 src/auth.ts 加了回调路由，复用现有的写会话逻辑；回调地址从配置读，和计划一致。",
		files: [{ path: "src/auth.ts", change: "加 OAuth 回调路由" }],
		unverified: "回调失败的分支没有测试。",
	}, meta.title);
	assert.ok(!("error" in details));
	const end: AgentEvent = { type: "tool_end", toolCallId: "call-review", toolName: "review_session", isError: false, result: { content: [{ type: "text", text: "ok" }], details } };
	hub.broadcast(meta.id, end);

	const review = await until(async () => (await store.listSessions()).find((one) => one.spawnedFrom?.sessionId === meta.id), "审阅会话建出来");
	assert.equal(review.cwd, worktree, "和原会话完全相同的目录");
	assert.equal(review.workspaceSetup, undefined, "没有按设置另开工作树");
	assert.equal(review.worktree, undefined, "工作树记在原会话身上：删审阅会话不会把它收走");
	assert.equal(review.project, "proj-1");
	assert.equal(review.title, "审阅 · 登录改走 OAuth");
	assert.equal(review.titleSetByUser, true);
	assert.equal(review.spawnedFrom?.toolCallId, "call-review");
	assert.equal(review.spawnedFrom?.review, true);
	const first = (await store.load(review.id))?.messages[0];
	const text = first?.role === "user" ? first.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "";
	assert.ok(text.includes('<user_message n="1">\n最初的需求：登录改走 OAuth\n</user_message>'), "压缩过的原会话，最初的需求仍是第 1 条");
	assert.ok(text.includes('<user_message n="2">\n回调地址读配置\n</user_message>'));

	// 这里没有可用的模型，第一轮以出错收场——没跑完的也交回，标成没跑完。
	await until(() => reports[0], "报告送回原会话");
	assert.deepEqual({ ...(reports[0] as object), reply: undefined }, { sessionId: review.id, title: review.title, status: "failed", reply: undefined });
	const settled = await until(async () => {
		const now = await store.get(review.id);
		return now?.spawnedFrom?.settled ? now : undefined;
	}, "第一轮收尾记下");
	assert.equal(settled.spawnedFrom?.review, true, "收尾时撕掉的是 reportBack，不是「它是审阅会话」");
	assert.equal(settled.spawnedFrom?.reportBack, undefined);

	await hub.deleteSessions([review.id]);
	hub.sessions.delete(meta.id);
});
