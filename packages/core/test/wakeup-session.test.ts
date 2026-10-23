/**
 * 定时唤醒接在 `AgentSession` 上：模型调 `schedule_wakeup`，到点闲着开一轮、忙着排到这一轮之后（不插进去）；
 * 按停止全部取消并说一声，处置时静静取消；四件工具只给会话本身。时钟是假的。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import { textResult } from "../src/agent/tool-run.ts";
import { AgentSession } from "../src/runtime/agent-session/session.ts";
import { SESSION_START_KEY } from "../src/runtime/agent-session/session-turn.ts";
import type { WakeupClock } from "../src/runtime/agent-session/session-wakeups.ts";
import { createWakeupTools } from "../src/runtime/agent-session/wakeup-tools.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type Message, type ModelConfig, type ProviderConfig, type Tool } from "../src/types.ts";

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
const MINUTE = 60_000;

function assistant(parts: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { role: "assistant", content: parts, api: "openai-responses", provider: "fake", model: "gpt-6-astra", usage: emptyUsage(), stopReason, timestamp: Date.now() };
}
const says = (text: string) => assistant([{ type: "text", text }]);
const call = (name: string, args: Record<string, unknown>, id = "c1") => assistant([{ type: "toolCall", id, name, arguments: args, argumentsText: JSON.stringify(args) }], "toolUse");
const woken = (messages: Message[]) => messages.filter((message) => message.role === "user" && message.delivery?.some((report) => report.kind === "wakeup"));
const answered = (context: LlmContext) => context.messages.some((message) => message.role === "toolResult");
const lastIsWakeup = (context: LlmContext) => {
	const last = context.messages.at(-1);
	return last?.role === "user" && Boolean(last.delivery?.some((report) => report.kind === "wakeup"));
};

async function until(check: () => boolean, what: string, ms = 5000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error(`等不到：${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** 只管定时唤醒的假时钟：测试里别的计时（送达的攒批、`until`）照旧走真的。 */
function fakeClock() {
	let now = Date.now();
	const timers = new Map<number, { at: number; run: () => void }>();
	let seq = 0;
	return {
		now: () => now,
		setTimeout(run: () => void, ms: number) {
			seq += 1;
			timers.set(seq, { at: now + ms, run });
			return seq;
		},
		clearTimeout(handle: unknown) {
			timers.delete(handle as number);
		},
		advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				timers.delete(next[0]);
				now = Math.max(now, next[1].at);
				next[1].run();
			}
			now = end;
		},
	} satisfies WakeupClock & { advance(ms: number): void };
}

async function harness(reply: (context: LlmContext) => Promise<AssistantMessage> | AssistantMessage, more: Tool[] = [], settings: Settings = SETTINGS) {
	const root = await mkdtemp(join(tmpdir(), "ly-wakeups-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	process.env.PLUME_HOME = home;
	const requests: LlmContext[] = [];
	const events: AgentEvent[] = [];
	const clock = fakeClock();
	let session: AgentSession | undefined;
	session = new AgentSession({
		cwd: root,
		settings,
		store: new SessionStore(join(root, "sessions")),
		extraTools: [...createWakeupTools((id) => (session && id === session.meta.id ? session.wakeups : undefined)), ...more],
		emit: (event) => void events.push(event),
		wakeupClock: clock,
		streamFn: async (context) => {
			requests.push(context);
			return reply(context);
		},
	});
	await session.initialize();
	const live = session;
	return {
		session: live,
		clock,
		requests,
		events,
		runs: () => events.filter((event) => event.type === "agent_start").length,
		cleanup: async () => {
			live.abort();
			delete process.env.PLUME_HOME;
			await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
		},
	};
}

/** 第一轮调 `schedule_wakeup` 等十分钟，到点那一轮说「CI 过了」。 */
const schedulesThenAnswers = (context: LlmContext) => {
	if (lastIsWakeup(context)) return says("CI 过了。");
	if (!answered(context)) return call("schedule_wakeup", { delay_seconds: 600, prompt: "看 CI 结果", reason: "等 CI" });
	return says("十分钟后再看。");
};

test("闲着时到点：开一轮，消息是运行时递的、带着任务 id，对话里画成一行送达", async () => {
	const h = await harness(schedulesThenAnswers);
	try {
		await h.session.prompt([{ type: "text", text: "推上去，等 CI" }]);
		await until(() => !h.session.running, "第一轮收尾");
		assert.equal(h.runs(), 1);
		const [pending] = h.session.wakeups.list();
		assert.ok(pending && pending.kind === "wakeup" && pending.reason === "等 CI");
		assert.ok(h.events.some((event) => event.type === "wakeups" && event.wakeups.length === 1), "表变了告诉宿主");
		h.clock.advance(10 * MINUTE);
		await until(() => h.runs() === 2 && !h.session.running, "到点开一轮");
		const [message] = woken(h.session.messages);
		assert.ok(message?.role === "user" && message.synthetic && !message.steered, "运行时递的、开了新的一轮");
		assert.match(message.content.map((part) => ("text" in part ? part.text : "")).join(""), /id="wake-1"[\s\S]*看 CI 结果/);
		assert.equal(h.session.messages.at(-1)?.role, "assistant");
		assert.deepEqual(h.session.wakeups.list(), []);
	} finally {
		await h.cleanup();
	}
});

test("忙着时到点：排到这一轮之后，不插进正在跑的回合", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const h = await harness(async (context) => {
		if (lastIsWakeup(context)) return says("看过了。");
		if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "schedule_wakeup")) {
			return call("schedule_wakeup", { delay_seconds: 60, prompt: "再看一眼", reason: "等部署" });
		}
		if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "wait")) return call("wait", {}, "c2");
		return says("干完了。");
	}, [{
		name: "wait",
		description: "等",
		parameters: { type: "object", properties: {} },
		async execute() {
			await gate;
			return textResult("好了");
		},
	}]);
	try {
		const turn = h.session.prompt([{ type: "text", text: "干活" }]);
		await until(() => h.requests.length === 2, "卡在 wait 上");
		h.clock.advance(MINUTE);
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		await turn;
		await until(() => h.runs() === 2 && !h.session.running, "这一轮之后再开一轮");
		const third = h.requests[2]!;
		assert.ok(!woken(third.messages).length, "正在跑的那一轮里读不到它");
		assert.ok(lastIsWakeup(h.requests[3]!), "下一轮由它打开");
	} finally {
		await h.cleanup();
	}
});

test("插话：停下这一轮，但定时唤醒留着，也不说「已取消」", async () => {
	const h = await harness(async (context) => {
		if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "schedule_wakeup")) {
			return call("schedule_wakeup", { delay_seconds: 600, prompt: "看 CI 结果", reason: "等 CI" });
		}
		if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "wait")) return call("wait", {}, "c2");
		return says("好。");
	}, [{
		name: "wait",
		description: "等",
		parameters: { type: "object", properties: {} },
		execute: (_args, ctx) => new Promise((resolve) => ctx.signal?.addEventListener("abort", () => resolve(textResult("停了")), { once: true })),
	}]);
	try {
		const turn = h.session.prompt([{ type: "text", text: "推上去，等 CI" }]);
		await until(() => h.requests.length === 2, "卡在 wait 上");
		await h.session.prompt([{ type: "text", text: "顺便看下 README" }], { deliver: "interrupt" });
		await turn;
		await until(() => !h.session.running, "插话那一轮收尾");
		assert.equal(h.session.wakeups.list().length, 1, "对话还在往下走，模型还等着它");
		assert.ok(!h.events.some((event) => event.type === "notice" && event.code === "wakeups-cancelled"));
		h.clock.advance(10 * MINUTE);
		await until(() => woken(h.session.messages).length === 1, "到点照常叫醒");
	} finally {
		await h.cleanup();
	}
});

test("按停止：全部取消，说一声；到点也不再开一轮", async () => {
	const h = await harness(schedulesThenAnswers);
	try {
		await h.session.prompt([{ type: "text", text: "推上去，等 CI" }]);
		await until(() => !h.session.running, "第一轮收尾");
		h.session.wakeups.cron("*/5 * * * *", "看部署", true);
		h.session.abort();
		assert.deepEqual(h.session.wakeups.list(), []);
		await until(() => h.events.some((event) => event.type === "notice"), "说一声");
		const notice = h.events.find((event) => event.type === "notice" && event.code === "wakeups-cancelled");
		assert.deepEqual(notice?.type === "notice" ? notice.params : null, { n: 2 });
		h.clock.advance(60 * MINUTE);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(h.runs(), 1);
	} finally {
		await h.cleanup();
	}
});

test("会话被处置：全部取消，不发通知", async () => {
	const h = await harness(schedulesThenAnswers);
	try {
		await h.session.prompt([{ type: "text", text: "推上去，等 CI" }]);
		await until(() => !h.session.running, "第一轮收尾");
		await h.session.dispose();
		assert.deepEqual(h.session.wakeups.list(), []);
		assert.ok(!h.events.some((event) => event.type === "notice" && event.code === "wakeups-cancelled"));
		h.clock.advance(60 * MINUTE);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(h.runs(), 1);
	} finally {
		await h.cleanup();
	}
});

test("四件工具只给会话本身：sessionOnly，子代理的 id 调进来也拒绝", async () => {
	const tools = createWakeupTools(() => undefined);
	assert.deepEqual(tools.map((tool) => tool.name), ["schedule_wakeup", "cron_create", "cron_list", "cron_delete"]);
	assert.ok(tools.every((tool) => tool.sessionOnly), "子代理拿不到");
	for (const tool of tools) {
		const result = await tool.execute({ delay_seconds: 60, prompt: "x", reason: "y", cron: "*/5 * * * *", id: "wake-1" }, { cwd: "/", sessionId: "abc:sub:1" });
		assert.equal(result.isError, true);
		assert.match(result.content.map((part) => ("text" in part ? part.text : "")).join(""), /sub-agent/);
	}
});

test("cron_list 和 cron_delete：一次性唤醒也列出来、也能删；参数不对说清楚", async () => {
	const h = await harness(() => says("好。"));
	try {
		const [wakeup, create, list, remove] = createWakeupTools((id) => (id === h.session.meta.id ? h.session.wakeups : undefined));
		const ctx = { cwd: "/", sessionId: h.session.meta.id };
		const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("");
		assert.match(text(await wakeup!.execute({ delay_seconds: 300, prompt: "看 CI", reason: "等 CI" }, ctx)), /Scheduled wake-1 for/);
		assert.match(text(await create!.execute({ cron: "*/10 * * * *", prompt: "看部署" }, ctx)), /Created cron-2\. Next firing: .*expires/);
		const listed = text(await list!.execute({}, ctx));
		assert.match(listed, /wake-1: one-time wakeup, next .* — 等 CI/);
		assert.match(listed, /cron-2: cron "\*\/10 \* \* \* \*", next .*expires/);
		assert.match(text(await remove!.execute({ id: "wake-1" }, ctx)), /Cancelled wake-1/);
		assert.equal((await remove!.execute({ id: "wake-1" }, ctx)).isError, true);
		assert.match(text(await create!.execute({ cron: "61 * * * *", prompt: "x" }, ctx)), /minute/);
		assert.match(text(await wakeup!.execute({ delay_seconds: 300, prompt: " ", reason: "r" }, ctx)), /prompt is required/);
		assert.deepEqual(h.session.wakeups.list().map((one) => one.id), ["cron-2"]);
	} finally {
		await h.cleanup();
	}
});

/** 一直等到这一轮被停下的工具：让到点的唤醒只能排在这一轮之后。 */
const waitUntilStopped: Tool = {
	name: "wait",
	description: "等",
	parameters: { type: "object", properties: {} },
	execute: (_args, ctx) => new Promise((resolve) => ctx.signal?.addEventListener("abort", () => resolve(textResult("停了")), { once: true })),
};
const lastSaid = (context: LlmContext) => {
	const last = context.messages.findLast((message) => message.role === "user" && !message.synthetic);
	return last?.role === "user" ? last.content.map((part) => ("text" in part ? part.text : "")).join("") : "";
};

test("排着的唤醒被插话清掉：之后补送一次，循环任务也不会一直当成「上一次还没看完」", async () => {
	const h = await harness(async (context) => {
		if (lastIsWakeup(context)) return says("看过了。");
		if (lastSaid(context).includes("README") && context.messages.at(-1)?.role === "user") return says("好。");
		if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "schedule_wakeup")) {
			return call("schedule_wakeup", { delay_seconds: 60, prompt: "看 CI 结果", reason: "等 CI" });
		}
		if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "wait")) return call("wait", {}, "c2");
		return says("好。");
	}, [waitUntilStopped]);
	try {
		const turn = h.session.prompt([{ type: "text", text: "推上去，等 CI" }]);
		await until(() => h.requests.length === 2, "卡在 wait 上");
		h.session.wakeups.cron("* * * * *", "看部署", true);
		h.clock.advance(2 * MINUTE);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(h.session.running, "两条都排在这一轮之后");
		await h.session.prompt([{ type: "text", text: "顺便看下 README" }], { deliver: "interrupt" });
		await turn;
		await until(() => !h.session.running, "插话那一轮收尾");
		assert.equal(woken(h.session.messages).length, 0, "排着的那两条随插话清掉了");
		h.clock.advance(MINUTE);
		await until(() => woken(h.session.messages).length === 2 && !h.session.running, "清掉的那次补送");
		const ids = woken(h.session.messages).flatMap((message) => (message.role === "user" ? message.delivery?.map((report) => report.id) ?? [] : []));
		assert.deepEqual(ids.sort(), ["cron-2", "wake-1"]);
		h.clock.advance(MINUTE);
		await until(() => woken(h.session.messages).length === 3, "循环任务之后照常触发");
	} finally {
		await h.cleanup();
	}
});

test("撤回到某条消息：被撤掉那一段里建的唤醒取消，之前建的留着", async () => {
	const h = await harness((context) => {
		if (context.messages.at(-1)?.role === "toolResult") return says("好。");
		return call("schedule_wakeup", { delay_seconds: 600, prompt: lastSaid(context), reason: lastSaid(context) });
	});
	try {
		await h.session.prompt([{ type: "text", text: "等 CI" }]);
		const second = h.session.messages.length;
		await h.session.prompt([{ type: "text", text: "等部署" }]);
		await until(() => !h.session.running, "第二轮收尾");
		assert.deepEqual(h.session.wakeups.list().map((one) => one.reason), ["等 CI", "等部署"]);
		await h.session.revert(second);
		assert.deepEqual(h.session.wakeups.list().map((one) => one.reason), ["等 CI"], "撤掉的那一轮里说的「十分钟后再看」不再算数");
		h.clock.advance(10 * MINUTE);
		await until(() => woken(h.session.messages).length === 1, "留下的那个照常到点");
		assert.match(JSON.stringify(woken(h.session.messages)[0]?.content), /等 CI/);
	} finally {
		await h.cleanup();
	}
});

test("退出应用（配了 SessionEnd 钩子）：唤醒一并取消，但不写「已停止」的通知", async () => {
	const hooks = { events: { SessionEnd: [{ hooks: [{ type: "process" as const, command: process.execPath, args: ["-e", ""] }] }] } };
	const h = await harness(schedulesThenAnswers, [], { ...SETTINGS, hooks });
	try {
		await h.session.prompt([{ type: "text", text: "推上去，等 CI" }]);
		await until(() => !h.session.running, "第一轮收尾");
		assert.ok(h.session.can.state.get(SESSION_START_KEY), "开过头，退出时才跑 SessionEnd");
		await h.session.end("quit");
		assert.deepEqual(h.session.wakeups.list(), []);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(!h.events.some((event) => event.type === "notice" && event.code === "wakeups-cancelled"), "人没有按停止");
	} finally {
		await h.cleanup();
	}
});

test("唤醒工具的说明不重复：四件的 schema 加起来有上限", () => {
	const tools = createWakeupTools(() => undefined);
	const size = tools.reduce((sum, tool) => sum + JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length, 0);
	assert.ok(size <= 3200, `四件工具的 schema 共 ${size} 个字符，每个请求都带着`);
	const [wakeup, create] = tools;
	const sentences = (text: string) => text.split(/(?<=[.:;])\s+/).filter((one) => one.length > 40);
	const shared = sentences(wakeup!.description).filter((one) => sentences(create!.description).includes(one));
	assert.deepEqual(shared, [], "两件工具里重复的话只说一遍");
});
