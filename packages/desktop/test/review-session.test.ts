/**
 * `/review` 交给审阅会话：`review_session` 只校验、写下要开什么、结束这一轮；主进程看到调用结束才开会话，
 * 目录和原会话一字不差，计划从原会话的记录里取原文，模型只写总结。规则在 `electron/session/review-session.ts`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, REVIEW_SESSION_OPENING, type AgentEvent, type Message, type SessionMeta, type Settings, type ToolContext } from "@plume/core";
import { peerRef } from "../electron/peer/peer-address.ts";
import { createReviewSessionTool, isPullRequestTarget, reviewModelId, reviewRequest, startReviewSessions } from "../electron/session/review-session.ts";
import type { ReviewSessionDetails } from "../shared/session-suggestion.ts";
import { describeActivity } from "../src/lib/tool-kinds.ts";
import { summarizeToolCall } from "../src/lib/tool-summary.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((one) => one.text ?? "").join("");
const ctx = (sessionId = "s-main") => ({ sessionId, cwd: "/work", state: new Map() }) as unknown as ToolContext;

/** 原会话：开在一棵工作树里，项目是另一个目录。审阅会话要的是前者。 */
const PARENT = { id: "s-main", title: "登录改走 OAuth", cwd: "/work/.plume/worktrees/oauth", project: "proj-1", modelId: "fast/model", worktree: { project: "/work", branch: "plume/oauth" } } as unknown as SessionMeta;
/** 一份合格的交接单（工具参数的写法）。 */
const ARGS = {
	background: "用户说登录只能用密码，公司要求接入 OAuth，让我给登录加一条 OAuth 回调路由。",
	decisions: "用户说「不要动 session.ts」；「回调地址读配置，不要写死」。",
	implementation: "在 src/auth.ts 加了回调路由，复用现有的写会话逻辑；回调地址从配置读，和计划一致。",
	files: [{ path: "src/auth.ts", change: "加 OAuth 回调路由和失败分支" }],
	unverified: "回调失败的那个分支没有测试，也没在真浏览器里跑过。",
};
const PLAN_V1 = "# 改登录\n\n## 概要\n加一条 OAuth 回调。";
const PLAN_V2 = "# 改登录 v2\n\n## 概要\n加一条 OAuth 回调，不碰 session.ts。";

const call = (id: string, plan: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "submit_plan", arguments: { plan } }], timestamp: 1 }) as unknown as Message;
const result = (id: string, details: unknown) => ({ role: "toolResult", toolCallId: id, toolName: "submit_plan", content: [], isError: false, details, timestamp: 1 }) as Message;
/** 交过两版：第一版打回，第二版带着批注批准，之后又交了一版被打回。 */
const HISTORY: Message[] = [
	call("p1", PLAN_V1),
	result("p1", { kind: "plan-feedback", feedback: "别碰 session.ts" }),
	call("p2", PLAN_V2),
	result("p2", { kind: "plan", plan: { plan: PLAN_V2, notes: "回调地址读配置", approvedAt: 1 } }),
	call("p3", "# 顺手重构"),
	result("p3", { kind: "plan-feedback", feedback: "不要" }),
];

const ended = (details: unknown, toolCallId = "call-review", isError = false): AgentEvent => ({
	type: "tool_end", toolCallId, toolName: "review_session", isError,
	result: { content: [{ type: "text", text: "handed off" }], details },
});

function host(options: { messages?: Message[]; history?: Message[] | null; fail?: string; settings?: Settings } = {}) {
	const started: Parameters<Parameters<typeof startReviewSessions>[0]["start"]>[0][] = [];
	const failures: { parentId: string; message: string }[] = [];
	const allowed: string[] = [];
	const watcher = startReviewSessions({
		source: (id) => (id === PARENT.id ? { meta: PARENT, messages: options.messages ?? HISTORY, cwd: PARENT.cwd } : id === REVIEWER.id ? { meta: REVIEWER, messages: [], cwd: PARENT.cwd } : undefined),
		// 存储里的完整历史；没单独给就和眼下的一样。
		history: async () => ("history" in options ? (options.history ?? null) : (options.messages ?? HISTORY)),
		settings: () => options.settings ?? DEFAULT_SETTINGS,
		start: async (input) => {
			if (options.fail) throw new Error(options.fail);
			started.push(input);
		},
		failed: (parentId, message) => failures.push({ parentId, message }),
		allowFixes: (id) => allowed.push(id),
	});
	return { watcher, started, failures, allowed };
}

const REVIEWER = { ...PARENT, id: "s-review", spawnedFrom: { sessionId: PARENT.id, toolCallId: "call-review", review: true, settled: true } } as SessionMeta;

const asked = (toolName: string, details: unknown, isError = false): AgentEvent => ({
	type: "tool_end", toolCallId: `call-${toolName}`, toolName, isError,
	result: { content: [{ type: "text", text: "answer" }], details },
});

test("第 F 步：审阅会话问原会话、等到了回答，才放行改文件；问别人、没等完都不算", () => {
	const { watcher, allowed } = host();
	const parent = `${PARENT.title} [${peerRef(PARENT.id)}]`;
	watcher.observe(REVIEWER.id, asked("ask_session", { kind: "blocked", to: parent, pending: [] }));
	watcher.observe(REVIEWER.id, asked("ask_session", { kind: "timeout", to: parent, seconds: 600 }));
	watcher.observe(REVIEWER.id, asked("ask_session", { kind: "done", to: "别的会话 [ffffff]", answers: [], dropped: 0, waitedMs: 0 }));
	watcher.observe(REVIEWER.id, asked("ask_session", { kind: "done", to: parent }, true));
	watcher.observe(PARENT.id, asked("ask_session", { kind: "done", to: parent }));
	assert.deepEqual(allowed, [], "原会话还在问它的人、超时、问的是别的会话、调用出错、不是审阅会话：都还没定修什么");
	watcher.observe(REVIEWER.id, asked("wait_for_session", { kind: "done", to: parent, answers: [], dropped: 0, waitedMs: 1 }));
	assert.deepEqual(allowed, [REVIEWER.id], "接着等、等到了回答，也算");
});

test("review_session 只给主会话：sessionOnly，子代理的 id 和审阅会话自己都被退回", async () => {
	const metas: Record<string, SessionMeta> = {
		"s-main": PARENT,
		"s-review": { ...PARENT, id: "s-review", spawnedFrom: { sessionId: "s-main", toolCallId: "call-review", review: true, settled: true } } as SessionMeta,
	};
	const tool = createReviewSessionTool({ meta: (id) => metas[id] });
	assert.equal(tool.sessionOnly, true, "子代理和侧边聊天的工具表里没有它");
	const sub = await tool.execute(ARGS, ctx("s-main:sub:1a2b"));
	assert.equal(sub.isError, true);
	const again = await tool.execute(ARGS, ctx("s-review"));
	assert.equal(again.isError, true, "审阅会话不能再转交");
	assert.match(text(again), /is the review session/);
	const gone = await tool.execute(ARGS, ctx("s-unknown"));
	assert.equal(gone.isError, true, "不在应用里开着的会话没处开审阅");
});

test("review_session 交出去就结束这一轮，details 里是开会话要的全部", async () => {
	const tool = createReviewSessionTool({ meta: (id) => (id === PARENT.id ? PARENT : undefined) });
	const done = await tool.execute({ ...ARGS, background: `  ${ARGS.background}\n`, effort: "high" }, ctx());
	assert.equal(done.isError, undefined);
	assert.equal(done.terminate, true, "接着往下说的模型会自己动手审");
	assert.deepEqual(done.details, { kind: "review_session", title: "审阅 · 登录改走 OAuth", subject: "登录改走 OAuth", effort: "high", handoff: ARGS } satisfies ReviewSessionDetails);
	assert.match(text(done), /delivered here/);
	const pr = await tool.execute({ target: "#123" }, ctx());
	assert.deepEqual(pr.details, { kind: "review_session", title: "审阅 · #123", subject: "#123", target: "#123" } satisfies ReviewSessionDetails, "PR 没有实现可交接，标题取目标");
	// 活动行和转录里那一行说同一句话。
	assert.equal(tool.summarize?.({ target: "#123" }), summarizeToolCall("review_session", { target: "#123" }));
	assert.ok(describeActivity("Review session #123"));
});

test("目标和力度不合格就退回去，并且点名是哪一项", () => {
	const cases: [Record<string, unknown>, RegExp][] = [
		[{ ...ARGS, effort: "max" }, /^effort must be one of low, medium, high/],
		[{ ...ARGS, target: 42 }, /^target must be text/],
	];
	for (const [args, message] of cases) {
		const checked = reviewRequest(args, PARENT.title);
		assert.ok("error" in checked, JSON.stringify(args).slice(0, 80));
		assert.match(checked.error, message);
	}
	assert.ok(isPullRequestTarget("123") && isPullRequestTarget("#7") && isPullRequestTarget("https://github.com/o/r/pull/9"));
	assert.ok(!isPullRequestTarget("src/123.ts") && !isPullRequestTarget("https://github.com/o/r/issues/9"));
	const long = reviewRequest(ARGS, "很".repeat(80));
	assert.ok(!("error" in long) && [...long.title].length === 60, "标题按字数截到 60");
});

test("调用结束才开会话、只开一次：目录就是原会话此刻那棵工作树，交回打开", async () => {
	const { watcher, started } = host();
	const details = reviewRequest({ ...ARGS, effort: "medium" }, PARENT.title) as ReviewSessionDetails;
	watcher.observe(PARENT.id, ended(details, "call-review", true));
	watcher.observe(PARENT.id, { type: "tool_end", toolCallId: "x", toolName: "spawn_session", isError: false, result: { content: [], details } });
	await settle();
	assert.equal(started.length, 0, "退回的调用、别的工具都不开");
	watcher.observe(PARENT.id, ended(details));
	watcher.observe(PARENT.id, ended(details));
	await settle();
	assert.equal(started.length, 1);
	const [one] = started;
	assert.equal(one.cwd, PARENT.cwd, "工作树里的原会话：审阅会话开在同一棵工作树里，不是项目目录");
	assert.notEqual(one.cwd, (PARENT.worktree as { project: string }).project);
	assert.equal(one.toolCallId, "call-review", "侧栏和对话里那一行靠它认出审阅会话");
	assert.equal(one.parent.id, PARENT.id);
	assert.equal(one.title, "审阅 · 登录改走 OAuth");
	assert.equal(one.modelId, "fast/model", "没给 review 选模型就沿用原会话的");
});

test("再敲一次 /review 是一次新的审阅：另开一个审阅会话", async () => {
	const { watcher, started } = host();
	const details = reviewRequest(ARGS, PARENT.title) as ReviewSessionDetails;
	watcher.observe(PARENT.id, ended(details, "call-review"));
	watcher.observe(PARENT.id, ended(details, "call-again"));
	await settle();
	assert.deepEqual(started.map((one) => one.toolCallId), ["call-review", "call-again"]);
	assert.ok(started.every((one) => one.prompt.startsWith(`${REVIEW_SESSION_OPENING}\n\n`)));
});

test("第一条消息里是最终批准那一版计划的原文和批注；打回的不附", async () => {
	const { watcher, started } = host();
	watcher.observe(PARENT.id, ended(reviewRequest({ ...ARGS, effort: "low" }, PARENT.title)));
	await settle();
	const prompt = started[0].prompt;
	assert.ok(prompt.startsWith(`${REVIEW_SESSION_OPENING}\n\n`), prompt.slice(0, 120));
	assert.ok(prompt.includes("Arguments: --effort low"));
	assert.ok(prompt.includes(`<approved_plan>\n${PLAN_V2}\n\n## 执行时注意\n回调地址读配置\n</approved_plan>`), "批准的是第二版，批注一起附上");
	assert.ok(!prompt.includes(PLAN_V1) && !prompt.includes("顺手重构"), "打回的不附");
	assert.match(prompt, /「登录改走 OAuth」/);
});

test("没有批准过计划就写明没有；审 PR 只交目标，交接各节写未提供", async () => {
	const { watcher, started } = host({ messages: [call("p1", PLAN_V1), result("p1", { kind: "plan-feedback", feedback: "不行" })] });
	watcher.observe(PARENT.id, ended(reviewRequest(ARGS, PARENT.title), "c1"));
	watcher.observe(PARENT.id, ended(reviewRequest({ target: "https://github.com/o/r/pull/9" }, PARENT.title), "c2"));
	await settle();
	assert.ok(!started[0].prompt.includes("<approved_plan>") && started[0].prompt.includes("原会话没有批准过计划。"));
	assert.ok(started[0].prompt.includes("Arguments: none (the uncommitted local changes)"));
	assert.ok(!started[1].prompt.includes(ARGS.background) && started[1].prompt.includes("## 背景\n\n未提供。"));
	assert.ok(started[1].prompt.includes("Arguments: https://github.com/o/r/pull/9"));
});

test("原会话压缩过：原话和计划从存储里的完整历史取，最初的需求仍是第 1 条", async () => {
	const first = { role: "user", content: [{ type: "text", text: "最初的需求：登录改走 OAuth" }], timestamp: 1 } as unknown as Message;
	const later = { role: "user", content: [{ type: "text", text: "顺便把回调地址读配置" }], timestamp: 3 } as unknown as Message;
	// 眼下的历史：早期几轮被一条合成的摘要换掉了，快照里的计划没有批注。
	const summary = { role: "user", synthetic: true, content: [{ type: "text", text: "（压缩摘要）" }], timestamp: 2, compactionContext: { plan: { plan: PLAN_V2, approvedAt: 1 } } } as unknown as Message;
	const { watcher, started } = host({ messages: [summary, later], history: [first, ...HISTORY, later] });
	watcher.observe(PARENT.id, ended(reviewRequest(ARGS, PARENT.title)));
	await settle();
	await settle();
	const prompt = started[0].prompt;
	assert.ok(prompt.includes('<user_message n="1">\n最初的需求：登录改走 OAuth\n</user_message>'), "压缩掉的第一条还在");
	assert.ok(prompt.includes('<user_message n="2">\n顺便把回调地址读配置\n</user_message>'));
	assert.ok(!prompt.includes("（压缩摘要）"), "摘要不是人说的话");
	assert.ok(prompt.includes("## 执行时注意\n回调地址读配置"), "计划带着批注，读的是原来那次批准，不是快照");
});

test("存储里读不到才退回眼下的历史", async () => {
	const { watcher, started } = host({ history: null });
	watcher.observe(PARENT.id, ended(reviewRequest(ARGS, PARENT.title)));
	await settle();
	await settle();
	assert.ok(started[0].prompt.includes("<approved_plan>"), "退回眼下的历史，照样取得到计划");
});

test("设置 › 智能体给 review 选了别的模型、而且这台机器上有，就用它", () => {
	const model = { id: "other/model", providerId: "other", modelId: "model", name: "Other" };
	const settings = { ...DEFAULT_SETTINGS, providers: [{ id: "other", name: "Other", enabled: true, models: [model] }], subAgentProfiles: { review: { modelId: "other/model" } } } as unknown as Settings;
	assert.equal(reviewModelId(settings, "fast/model"), "other/model");
	assert.equal(reviewModelId({ ...settings, subAgentProfiles: { review: { modelId: "gone/model" } } } as unknown as Settings, "fast/model"), "fast/model", "找不到就沿用原会话的，不为一个偏好开不出会话");
	assert.equal(reviewModelId(DEFAULT_SETTINGS, "fast/model"), "fast/model");
});

test("没开出来：原会话那一轮已经按「交出去了」停下，要告诉人", async () => {
	const { watcher, failures } = host({ fail: "disk full" });
	watcher.observe(PARENT.id, ended(reviewRequest(ARGS, PARENT.title)));
	await settle();
	await settle();
	assert.equal(failures.length, 1);
	assert.equal(failures[0].parentId, PARENT.id);
	assert.match(failures[0].message, /disk full/);
});
