/**
 * 另一个会话写来的信，从 `AgentSession` 这一头验：请求闲着时开一轮、忙着时排到这一轮之后，同一个
 * 会话的几封合成一条而不同会话的各开一轮；通知忙着插进这一轮、闲着开一轮，这一轮来不及读的收场后
 * 另开一轮，人按停的不丢；`whenIdle` 不把「马上要开的下一轮」当成闲了；等待被打断时说清是人还是
 * 通知；宿主注入的跨会话工具不下发给子代理。
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
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type Message, type ModelConfig, type PeerLetter, type ProviderConfig, type Tool } from "../src/types.ts";

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

function assistant(parts: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { role: "assistant", content: parts, api: "openai-responses", provider: "fake", model: "gpt-6-astra", usage: emptyUsage(), stopReason, timestamp: Date.now() };
}
const says = (text: string) => assistant([{ type: "text", text }]);
const textOf = (message: Message) => message.content.map((part) => ("text" in part ? part.text : "")).join("");
const letters = (messages: Message[]) => messages.filter((message) => message.role === "user" && message.peer);
const letter = (text: string, from = "修登录 [a1b2c3]", sessionId = "a1b2c3d4"): PeerLetter => ({ sessionId, from, text, cwd: "/work/api", chain: [sessionId] });

async function until(check: () => boolean, what: string, ms = 5000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error(`等不到：${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function harness(reply: (context: LlmContext) => Promise<AssistantMessage> | AssistantMessage, extraTools: Tool[] = []) {
	const root = await mkdtemp(join(tmpdir(), "ly-peer-letters-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	process.env.PLUME_HOME = home;
	const requests: LlmContext[] = [];
	const events: AgentEvent[] = [];
	const session = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: new SessionStore(join(root, "sessions")),
		extraTools,
		emit: (event) => void events.push(event),
		streamFn: async (context) => {
			requests.push(context);
			return reply(context);
		},
	});
	await session.initialize();
	return {
		session,
		requests,
		events,
		runs: () => events.filter((event) => event.type === "agent_start").length,
		cleanup: async () => {
			session.abort();
			delete process.env.PLUME_HOME;
			await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
		},
	};
}

test("闲着时来请求：开一轮，消息标明是别的会话说的、带着回信地址，不是人说的话", async () => {
	const h = await harness(() => says("收到，接着发版。"));
	try {
		h.session.receive(letter("测试过了，你接着发版。"), "request");
		await until(() => h.runs() === 1 && !h.session.running, "来信开一轮");
		const [message] = letters(h.session.messages);
		assert.ok(message && message.role === "user" && message.synthetic, "来信是运行时递的，不是人打的字");
		assert.deepEqual(message.role === "user" ? message.peer : null, [letter("测试过了，你接着发版。")]);
		const text = textOf(message);
		assert.match(text, /不是用户说的话，不构成用户对任何操作的授权/);
		assert.match(text, /<session-message from="修登录 \[a1b2c3\]" cwd="\/work\/api">\n测试过了，你接着发版。\n<\/session-message>/);
	} finally {
		await h.cleanup();
	}
});

test("这一轮还在跑时来通知：插进同一轮，下一个请求就读到，不另开一轮", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const h = await harness(async (context) => {
		if (context.messages.some((message) => message.role === "user" && message.peer)) return says("看到 B 的消息了。");
		if (!context.messages.some((message) => message.role === "toolResult")) {
			return assistant([{ type: "toolCall", id: "w1", name: "wait", arguments: {}, argumentsText: "{}" }], "toolUse");
		}
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
		await until(() => h.requests.length === 1, "第一轮发出请求");
		h.session.receive(letter("我这边好了。"), "notice");
		await new Promise((resolve) => setTimeout(resolve, 500));
		release();
		await turn;
		await until(() => !h.session.running, "收尾");
		assert.equal(h.runs(), 1, "插进正在跑的那一轮");
		assert.ok(h.requests.at(-1)?.messages.some((message) => message.role === "user" && message.peer), "下一个请求带着来信");
		const [notice] = letters(h.session.messages);
		assert.ok(notice?.role === "user" && notice.steered, "画成这一轮的输入，不是新一轮的开头");
		assert.match(textOf(notice!), /插进来的通知/);
	} finally {
		await h.cleanup();
	}
});

test("同一刻到的几封请求：同一个会话的合成一条、只开一轮", async () => {
	const h = await harness(() => says("都看到了。"));
	try {
		h.session.receive(letter("甲好了。"), "request");
		h.session.receive(letter("乙也好了。"), "request");
		await until(() => h.runs() === 1 && !h.session.running, "合成一轮");
		assert.equal(letters(h.session.messages).length, 1);
		assert.match(textOf(letters(h.session.messages)[0]!), /甲好了。[\s\S]*乙也好了。/);
	} finally {
		await h.cleanup();
	}
});

test("同一刻到的几封请求：不同会话的不合并、各开一轮，每一轮只读到自己那家的信", async () => {
	const h = await harness((context) => says(`回 ${textOf(context.messages.at(-1)!).includes("甲") ? "甲" : "乙"}`));
	try {
		h.session.receive(letter("甲好了。", "甲 [aaaaaa]", "aaaaaaaa"), "request");
		h.session.receive(letter("乙也好了。", "乙 [bbbbbb]", "bbbbbbbb"), "request");
		await until(() => h.runs() === 2 && h.session.idle, "两家各开一轮");
		const mail = letters(h.session.messages);
		assert.deepEqual(mail.map((message) => (message.role === "user" ? message.peer?.map((one) => one.sessionId) : null)), [["aaaaaaaa"], ["bbbbbbbb"]], "每条一家");
		const newest = (context: LlmContext) => { const last = letters(context.messages).at(-1); return last?.role === "user" ? last.peer?.map((one) => one.sessionId) : undefined; };
		assert.deepEqual(h.requests.map(newest), [["aaaaaaaa"], ["bbbbbbbb"]], "每一次请求读到的最新那封信只属于一家");
		assert.match(textOf(mail[0]!), /做完后把结果写在这一轮的最后一条回复里/, "请求说明回答写在哪");
	} finally {
		await h.cleanup();
	}
});

test("闲着时来通知：开一轮读，几家的并成一条，进了记录；攒着的那一会儿不算闲", async () => {
	const h = await harness(() => says("收到，我避开 config.ts。"));
	try {
		h.session.receive(letter("我要改 config.ts。", "丙 [cccccc]", "cccccccc"), "notice");
		h.session.receive(letter("我也要改它。", "丁 [dddddd]", "dddddddd"), "notice");
		assert.equal(h.session.idle, false, "四百毫秒后就要开一轮：这时被回收，信就没了");
		await until(() => h.runs() === 1 && h.session.idle, "为通知开的那一轮收尾");
		assert.equal(h.requests.length, 1);
		const [notice] = letters(h.requests[0]!.messages);
		assert.deepEqual(notice?.role === "user" ? notice.peer?.map((one) => one.sessionId) : null, ["cccccccc", "dddddddd"]);
		assert.ok(notice?.role === "user" && !notice.steered, "它开了这一轮，画成一轮的开头");
		assert.match(textOf(notice!), /插进来的通知/);
		assert.deepEqual(letters(h.session.messages), [notice], "进了记录，只进一次");
	} finally {
		await h.cleanup();
	}
});

test("模型写最后那段回复时来的通知：这一轮来不及读，收场后另开一轮读到，不攒到人下次开口", async () => {
	let sent = false;
	const h = await harness((context) => {
		if (context.messages.some((message) => message.role === "user" && message.peer)) return says("看到了。");
		return says("干完了。");
	});
	// 循环发出 agent_end 时已经不再取插话，会话却还没放手：落在这里的通知以前就一直攒着。
	h.events.push = function (this: AgentEvent[], ...items: AgentEvent[]) {
		if (!sent && items.some((event) => event.type === "agent_end")) {
			sent = true;
			h.session.receive(letter("interop 编不过了。"), "notice");
		}
		return Array.prototype.push.apply(this, items);
	};
	try {
		await h.session.prompt([{ type: "text", text: "干活" }]);
		await until(() => h.runs() === 2 && h.session.idle, "收场后为通知另开一轮");
		assert.ok(h.requests[1]!.messages.some((message) => message.role === "user" && message.peer), "第二轮读到通知");
		assert.equal(letters(h.session.messages).length, 1);
	} finally {
		await h.cleanup();
	}
});

test("闲着时来通知、还没送进去人就按了停：不开轮，也不丢，下一轮开头读到", async () => {
	const h = await harness(() => says("好。"));
	try {
		h.session.receive(letter("我要改 config.ts。"), "notice");
		h.session.abort();
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.equal(h.runs(), 0, "停下的会话不被通知叫醒");
		assert.equal(h.session.idle, true);
		await h.session.prompt([{ type: "text", text: "接着干" }]);
		await until(() => !h.session.running, "人开的那一轮收尾");
		assert.ok(h.requests[0]!.messages.some((message) => message.role === "user" && message.peer), "下一轮读到");
	} finally {
		await h.cleanup();
	}
});

for (const stop of [false, true]) {
	test(`闲时通知攒批期间转忙：${stop ? "打断等待后按停，通知留到下一轮" : "打断已有等待，同一轮读到"}`, async () => {
		let released = false;
		let finishTool!: () => void;
		const toolGate = new Promise<void>((resolve) => { finishTool = resolve; });
		const h = await harness((context) => context.messages.some((message) => message.role === "user" && message.peer)
			? says("读到通知了。")
			: assistant([{ type: "toolCall", id: "p1", name: "peer_wait", arguments: {}, argumentsText: "{}" }], "toolUse"), [{
			name: "peer_wait",
			description: "等另一个会话",
			parameters: { type: "object", properties: {} },
			async execute(_args, ctx) {
				const outcome = await ctx.untilSpokenTo!(new Promise<string>(() => {}));
				released = typeof outcome === "object" && outcome.spokenTo === "notice";
				// 已放开等待、循环还没取通知：人在这个空档可以按停。
				await toolGate;
				return textResult("通知来了");
			},
		}]);
		let turn: ReturnType<AgentSession["prompt"]> | undefined;
		try {
			h.session.receive(letter("config.ts 不能发布。"), "notice");
			turn = h.session.prompt([{ type: "text", text: "等一下 B" }]);
			await until(() => released, "攒批的通知放开正在等的工具");
			assert.equal(letters(h.session.messages).length, 0, "工具尚未返回，循环还没取通知");
			if (stop) h.session.abort();
			finishTool();
			await turn;
			if (stop) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				assert.equal(h.runs(), 1, "停下后不能为未读通知自动开轮");
				assert.equal(letters(h.session.messages).length, 0);
				turn = h.session.prompt([{ type: "text", text: "接着干" }]);
				await turn;
			}
			assert.equal(h.runs(), stop ? 2 : 1);
			assert.equal(letters(h.session.messages).length, 1, "通知不丢，也不重复");
			assert.match(textOf(letters(h.requests.at(-1)!.messages)[0]!), /config.ts 不能发布/);
		} finally {
			h.session.abort();
			finishTool();
			await turn?.catch(() => {});
			await h.cleanup();
		}
	});
}

for (const stop of [false, true]) {
	test(`压缩中收到通知：${stop ? "送达等待压缩时按停，下一轮仍读到" : "压缩完成后自动交付，不会先变成可回收的空闲"}`, async () => {
		let finishSummary!: (message: AssistantMessage) => void;
		const summary = new Promise<AssistantMessage>((resolve) => { finishSummary = resolve; });
		let summarizing = true;
		const h = await harness(() => summarizing ? summary : says("读到压缩期间的通知。"));
		let compacting: ReturnType<AgentSession["compact"]> | undefined;
		try {
			for (let index = 0; index < 20; index++) {
				await h.session.log.commit(index % 2 ? says("Implementation notes. ".repeat(100)) : {
					role: "user", content: [{ type: "text", text: "Preserve this task. ".repeat(100) }], timestamp: index,
				});
			}
			compacting = h.session.compact();
			await until(() => h.requests.length === 1, "真实压缩已经请求摘要");
			h.session.receive(letter("构建被挡住了。"), "notice");
			let idleAt = -1;
			void h.session.whenIdle().then(() => { idleAt = h.runs(); });
			// 让真实的 400ms 送达开始等压缩，而不是只测 timer 尚未触发的 clear。
			await new Promise((resolve) => setTimeout(resolve, 500));
			assert.equal(h.runs(), 0);
			assert.equal(h.session.idle, false);
			assert.equal(idleAt, -1);
			if (stop) h.session.abort();
			summarizing = false;
			finishSummary(says("Task, decisions and outstanding work retained."));
			assert.equal((await compacting).ok, !stop);
			if (stop) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				assert.equal(h.runs(), 0, "停止压缩也撤销这次自动唤醒");
				assert.equal(letters(h.session.messages).length, 0);
				await h.session.prompt([{ type: "text", text: "继续" }]);
			} else {
				await until(() => idleAt >= 0, "通知那一轮结束后才放开空闲等待者");
				assert.equal(idleAt, 1, "不能在压缩结束和通知开轮之间被回收");
			}
			assert.equal(h.runs(), 1);
			assert.equal(letters(h.session.messages).length, 1);
			assert.match(textOf(letters(h.requests.at(-1)!.messages)[0]!), /构建被挡住了/);
		} finally {
			h.session.abort();
			finishSummary(says("stop"));
			await compacting?.catch(() => {});
			await h.cleanup();
		}
	});
}

test("whenIdle：攒着待送的信也算没闲，等那一轮跑完才兑现", async () => {
	const h = await harness(() => says("好。"));
	try {
		let idleAt = -1;
		h.session.receive(letter("你接着做。"), "request");
		assert.equal(h.session.idle, false, "四百毫秒后就要开一轮");
		void h.session.whenIdle().then(() => { idleAt = h.runs(); });
		await until(() => idleAt >= 0, "兑现");
		assert.equal(idleAt, 1, "在来信开的那一轮之后才算闲");
		assert.equal(h.session.idle, true);
	} finally {
		await h.cleanup();
	}
});

test("whenIdle：会话被处置时放开等的人——工具还没回来也一样，桌面端据此答「对方已关闭」", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const h = await harness((context) => context.messages.some((message) => message.role === "toolResult")
		? says("好。")
		: assistant([{ type: "toolCall", id: "s1", name: "stuck", arguments: {}, argumentsText: "{}" }], "toolUse"), [{
		name: "stuck",
		description: "不理会中止",
		parameters: { type: "object", properties: {} },
		async execute() {
			await gate;
			return textResult("好了");
		},
	}]);
	try {
		const turn = h.session.prompt([{ type: "text", text: "干活" }]);
		await until(() => h.requests.length === 1, "进到工具里");
		let woke = false;
		void h.session.whenIdle().then(() => { woke = true; });
		await h.session.dispose();
		await until(() => woke, "处置之后兑现", 1000);
		release();
		await turn.catch(() => {});
	} finally {
		release();
		await h.cleanup();
	}
});

test("忙着时排队的信：不插进这一轮，这一轮收场后另开一次；中间不算闲，信的 message_start 在下一次 agent_start 之前", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const h = await harness(async (context) => {
		if (context.messages.at(-1)?.role === "user" && (context.messages.at(-1) as { peer?: unknown }).peer) return says("看到 A 的消息了。");
		if (!context.messages.some((message) => message.role === "toolResult")) {
			return assistant([{ type: "toolCall", id: "w1", name: "wait", arguments: {}, argumentsText: "{}" }], "toolUse");
		}
		return says("人交代的做完了。");
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
		await until(() => h.requests.length === 1, "第一轮发出请求");
		h.session.receive({ ...letter("我这边好了。"), id: "L1" }, "request");
		let idleAt = -1;
		void h.session.whenIdle().then(() => { idleAt = h.runs(); });
		await new Promise((resolve) => setTimeout(resolve, 500));
		release();
		await turn;
		await until(() => idleAt >= 0, "最后闲下来");
		assert.equal(h.runs(), 2, "信另开了一次运行");
		assert.equal(idleAt, 2, "两次运行之间不算闲");
		const first = h.requests.slice(0, 2);
		assert.ok(first.every((context) => !context.messages.some((message) => message.role === "user" && message.peer)), "第一次运行的请求里没有这封信");
		const kinds = h.events.map((event) => (event.type === "message_start" && event.message.role === "user" && event.message.peer ? "letter" : event.type)).filter((kind) => kind === "letter" || kind === "agent_start" || kind === "agent_end");
		assert.deepEqual(kinds, ["agent_start", "agent_end", "letter", "agent_start", "agent_end"]);
		// 排着的那段时间窗口看得见它：进队时一张有它的表，轮到时一张空表。
		const queues = h.events.flatMap((event) => (event.type === "peer_queue" ? [event.letters.map((one) => one.id)] : []));
		assert.deepEqual(queues, [["L1"], []]);
		const emptied = h.events.findIndex((event) => event.type === "peer_queue" && event.letters.length === 0);
		const read = h.events.findIndex((event) => event.type === "message_start" && event.message.role === "user" && Boolean(event.message.peer));
		assert.ok(emptied >= 0 && emptied < read, "先从条上撤下，再落进转录");
	} finally {
		release();
		await h.cleanup();
	}
});

test("一轮里隔着几分钟排进来的几封信：收场后合成一条、只另开一次，不是一封一次", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const h = await harness(async (context) => {
		if (context.messages.at(-1)?.role === "user" && (context.messages.at(-1) as { peer?: unknown }).peer) return says("两封都看到了。");
		if (!context.messages.some((message) => message.role === "toolResult")) {
			return assistant([{ type: "toolCall", id: "w1", name: "wait", arguments: {}, argumentsText: "{}" }], "toolUse");
		}
		return says("人交代的做完了。");
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
		await until(() => h.requests.length === 1, "第一轮发出请求");
		h.session.receive({ ...letter("我要改 log_types.go。"), id: "L1" }, "request");
		// 隔开攒批的那 400ms：两封各自成一条排进去，和实际里隔着几分钟到的一样。
		await new Promise((resolve) => setTimeout(resolve, 600));
		h.session.receive({ ...letter("typecheck 过了。"), id: "L2" }, "request");
		await new Promise((resolve) => setTimeout(resolve, 600));
		release();
		await turn;
		await until(() => h.runs() === 2 && !h.session.running, "收场后另开一次");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(h.runs(), 2, "两封信只另开了一次");
		const mail = letters(h.session.messages);
		assert.equal(mail.length, 1, "对话里是一条消息");
		assert.deepEqual(mail[0]?.role === "user" ? mail[0].peer?.map((one) => one.id) : null, ["L1", "L2"], "按到达的顺序，两封都在");
	} finally {
		release();
		await h.cleanup();
	}
});

test("宿主的工具在等别的会话时，人一开口就放手：工具拿到「人开口」，下一个请求就读到人的话", async () => {
	let released = false;
	const h = await harness((context) => {
		const last = context.messages.at(-1);
		if (last?.role === "user" && last.content.some((part) => part.type === "text" && part.text === "先别等了")) return says("好，先回应你。");
		if (!context.messages.some((message) => message.role === "toolResult")) {
			return assistant([{ type: "toolCall", id: "p1", name: "peer_wait", arguments: {}, argumentsText: "{}" }], "toolUse");
		}
		return says("等完了。");
	}, [{
		name: "peer_wait",
		description: "等另一个会话",
		parameters: { type: "object", properties: {} },
		async execute(_args, ctx) {
			const outcome = await ctx.untilSpokenTo!(new Promise<string>(() => {}));
			released = typeof outcome === "object" && outcome.spokenTo === "person";
			return textResult(released ? "人开口了" : "等到了");
		},
	}]);
	try {
		const turn = h.session.prompt([{ type: "text", text: "等一下 B" }]);
		await until(() => h.requests.length === 1, "进到等待里");
		await new Promise((resolve) => setTimeout(resolve, 50));
		await h.session.prompt([{ type: "text", text: "先别等了" }]);
		await turn;
		await until(() => !h.session.running, "收尾");
		assert.ok(released, "等待交回「人开口」，而不是一直卡着");
		assert.equal(h.runs(), 1, "人的话插进同一轮，不用等这一轮做完");
		assert.ok(h.requests.at(-1)?.messages.some((message) => message.role === "user" && message.content.some((part) => part.type === "text" && part.text === "先别等了")));
	} finally {
		await h.cleanup();
	}
});

test("在等别的会话时来了通知：和人开口一样放手，下一个请求就读到通知", async () => {
	let released = false;
	const h = await harness((context) => {
		if (context.messages.some((message) => message.role === "user" && message.peer)) return says("看到通知了。");
		if (!context.messages.some((message) => message.role === "toolResult")) {
			return assistant([{ type: "toolCall", id: "p1", name: "peer_wait", arguments: {}, argumentsText: "{}" }], "toolUse");
		}
		return says("等完了。");
	}, [{
		name: "peer_wait",
		description: "等另一个会话",
		parameters: { type: "object", properties: {} },
		async execute(_args, ctx) {
			const outcome = await ctx.untilSpokenTo!(new Promise<string>(() => {}));
			released = typeof outcome === "object" && outcome.spokenTo === "notice";
			return textResult(released ? "放手了" : "等到了");
		},
	}]);
	try {
		const turn = h.session.prompt([{ type: "text", text: "等一下 B" }]);
		await until(() => h.requests.length === 1, "进到等待里");
		await new Promise((resolve) => setTimeout(resolve, 50));
		h.session.receive(letter("我要改 config.ts。"), "notice");
		await turn;
		await until(() => !h.session.running, "收尾");
		assert.ok(released, "交回的是「通知」，不是「人开口」；不用等那件事等完才读到");
		assert.equal(h.runs(), 1);
		assert.ok(h.requests.at(-1)?.messages.some((message) => message.role === "user" && message.peer));
	} finally {
		await h.cleanup();
	}
});

test("闲着时 whenIdle 立刻兑现", async () => {
	const h = await harness(() => says("好。"));
	try {
		await h.session.whenIdle();
		assert.equal(h.runs(), 0);
	} finally {
		await h.cleanup();
	}
});

test("sessionOnly 的工具不下发给子代理", async () => {
	const peerTool: Tool = {
		name: "ask_session",
		description: "发给另一个会话",
		parameters: { type: "object", properties: {} },
		sessionOnly: true,
		async execute() { return textResult("ok"); },
	};
	const h = await harness((context) => {
		if (!context.tools.some((tool) => tool.name === "task")) return says("子代理交差。");
		if (!context.messages.some((message) => message.role === "toolResult")) {
			return assistant([{ type: "toolCall", id: "t1", name: "task", arguments: { description: "看看", prompt: "看", subagent_type: "general" }, argumentsText: "{}" }], "toolUse");
		}
		return says("好了。");
	}, [peerTool]);
	try {
		await h.session.prompt([{ type: "text", text: "派一个出去" }]);
		await h.session.whenIdle();
		const main = h.requests.filter((context) => context.tools.some((tool) => tool.name === "task"));
		const sub = h.requests.filter((context) => !context.tools.some((tool) => tool.name === "task") && context.tools.length > 0);
		assert.ok(main.length > 0 && sub.length > 0, "主会话和子代理都发过请求");
		assert.ok(main.every((context) => context.tools.some((tool) => tool.name === "ask_session")), "会话自己有");
		assert.ok(sub.every((context) => !context.tools.some((tool) => tool.name === "ask_session")), "子代理没有");
	} finally {
		await h.cleanup();
	}
});
