/**
 * 问了等回答：对方在两步之间读到，用 `reply` 回了就当场拿到，不等它那一轮收场；读到却没回就收了
 * 那一轮的，拿那一轮最后的话兜底；几家同时来问各拿各的回答；对方正等着我也照问；等到一半被打断的，
 * 信留在账上，`wait` 接着等；回答到时问的一方已经不等了，当作通知送过去；卡在等人回答上、信被丢了、
 * 超时、被叫停、对方关了、互相等，各自说清楚；人一开口、来了信就不再等，并说清是哪一种。通知不等；
 * 闲着的收件方为它开一轮。等只看前台，不等对方放到后台的子代理。
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Tool } from "@plume/core";
import { PeerRuns } from "../electron/peer/peer-runs.ts";
import { createPeerTools } from "../electron/peer/peer-tools.ts";
import { REPLY_LIMIT, type AskOutcome, type WaitOutcome } from "../electron/peer/session-peers.ts";
import { asking, fakeSession, flush, routerWith, stopAsking } from "./helpers/peer-fake.ts";

afterEach(stopAsking);

/** 等回来的第一段回答。 */
const replyOf = (outcome: WaitOutcome | AskOutcome | undefined) => (outcome?.kind === "done" ? outcome.answers[0]?.reply : undefined);

/** 一个还没兑现的等待，测试随时看它落没落定。 */
function pending<T>(run: Promise<T>) {
	const state = { settled: false, value: undefined as T | undefined };
	void run.then((value) => { state.settled = true; state.value = value; });
	return state;
}

test("问：对方忙着人交代的事，信插进它这一轮；它一回，问的一方当场拿到，不等这一轮收场", async () => {
	const a = fakeSession("aaaaaaaa-1", "/w/p");
	const b = fakeSession("bbbbbbbb-1", "/w/p");
	const { router } = routerWith(a, b);
	b.start();
	const waiting = pending((await asking(router, b, "aaaaaaaa-1", { to: "bbbb", message: "版本号多少" })).outcome);
	assert.equal(b.inbox[0]?.kind, "request");
	b.read();
	await flush();
	assert.ok(!waiting.settled, "读到了，还没回");
	assert.deepEqual(await router.reply("bbbbbbbb-1", { to: "aaaa", message: "v1.2.3" }), { kind: "replied", to: "aaaa [aaaaaa]", waiting: true });
	await flush();
	assert.equal(waiting.value?.kind, "done");
	assert.equal(replyOf(waiting.value), "v1.2.3");
	assert.equal(waiting.value?.kind === "done" && waiting.value.answers[0]?.reason, "replied");
	// 拿到了就从账上划掉：再等等的是它手上人交代的那件，不会把这段回答再领一遍。
	const next = pending(router.wait("aaaaaaaa-1", { to: "bbbb" }));
	await flush();
	assert.ok(!next.settled);
	b.finish("人交代的那件改完了。");
	await flush();
	assert.equal(replyOf(next.value), "人交代的那件改完了。");
});

test("问：对方读到了却没回就收了这一轮，拿那一轮最后说的话兜底；之后再回不会把这封再答一遍", async () => {
	const a = fakeSession("aaaaaaaa-21", "/w/p");
	const b = fakeSession("bbbbbbbb-21", "/w/p");
	const { router } = routerWith(a, b);
	b.start();
	const waiting = pending((await asking(router, b, "aaaaaaaa-21", { to: "bbbb", message: "版本号多少" })).outcome);
	b.read();
	b.finish("人交代的做完了，版本是 v1.2.3。");
	await flush();
	assert.equal(replyOf(waiting.value), "人交代的做完了，版本是 v1.2.3。");
	assert.equal(waiting.value?.kind === "done" && waiting.value.answers[0]?.reason, "done");
	assert.deepEqual(await router.reply("bbbbbbbb-21", { to: "aaaa", message: "补一句" }), { kind: "replied", to: "aaaa [aaaaaa]", waiting: false }, "没有待答的信，照通知送");
	assert.equal(a.inbox[0]?.kind, "notice");
});

test("回：问的一方已经不等了，回答当作通知送过去，也记在账上——再等当场拿到；做完再回一次照通知送", async () => {
	const a = fakeSession("aaaaaaaa-22", "/w/p");
	const b = fakeSession("bbbbbbbb-22", "/w/p");
	const { router } = routerWith(a, b);
	b.start();
	const asked = await asking(router, b, "aaaaaaaa-22", { to: "bbbb", message: "能帮我发版吗" });
	asked.stop();
	assert.equal((await asked.outcome).kind, "stopped");
	b.read();
	assert.deepEqual(await router.reply("bbbbbbbb-22", { to: "aaaa", message: "可以，手上这件做完就发" }), { kind: "replied", to: "aaaa [aaaaaa]", waiting: false });
	assert.deepEqual(a.inbox.map((one) => [one.kind, one.letter.text, one.letter.from]), [["notice", "可以，手上这件做完就发", "bbbb [bbbbbb]"]]);
	// 再等当场拿到 done：审阅会话认的就是这个，靠它放行改文件。
	const again = await router.wait("aaaaaaaa-22", { to: "bbbb" });
	assert.equal(replyOf(again), "可以，手上这件做完就发");
	assert.equal(again.kind === "done" && again.answers[0]?.reason, "replied");
	// 拿到了就从账上划掉：再等等的是它手上这一次。
	const next = pending(router.wait("aaaaaaaa-22", { to: "bbbb" }));
	await flush();
	b.finish("人交代的做完了。");
	await flush();
	assert.equal(replyOf(next.value), "人交代的做完了。");
	assert.deepEqual(await router.reply("bbbbbbbb-22", { to: "aaaa", message: "发好了" }), { kind: "replied", to: "aaaa [aaaaaa]", waiting: false });
	assert.equal(a.inbox[1]?.letter.text, "发好了");
});

test("问：两家同时找忙着的 B，同一轮里读到，各回各的", async () => {
	const a = fakeSession("aaaaaaaa-13", "/w/p");
	const b = fakeSession("bbbbbbbb-13", "/w/p");
	const c = fakeSession("cccccccc-13", "/w/p");
	const { router } = routerWith(a, b, c);
	b.start();
	const forA = pending((await asking(router, b, "aaaaaaaa-13", { to: "bbbb", message: "版本号多少" })).outcome);
	const forC = pending((await asking(router, b, "cccccccc-13", { to: "bbbb", message: "测试过没过" })).outcome);
	b.read(0);
	b.read(1);
	await router.reply("bbbbbbbb-13", { to: "cccc", message: "测试全过。" });
	await flush();
	assert.equal(replyOf(forC.value), "测试全过。");
	assert.ok(!forA.settled, "回 C 的话不算回 A");
	await router.reply("bbbbbbbb-13", { to: "aaaa", message: "v1.2.3" });
	await flush();
	assert.equal(replyOf(forA.value), "v1.2.3");
});

test("问到一半被打断：信留在账上，wait 一次接回几段回答，按发出的顺序、说得出对着哪封", async () => {
	const a = fakeSession("aaaaaaaa-14", "/w/p");
	const b = fakeSession("bbbbbbbb-14", "/w/p");
	const c = fakeSession("cccccccc-14", "/w/p");
	const { router } = routerWith(a, b, c);
	b.start();
	const first = await asking(router, b, "aaaaaaaa-14", { to: "bbbb", message: "先查版本号" });
	first.stop();
	assert.equal((await first.outcome).kind, "stopped");
	await asking(router, b, "cccccccc-14", { to: "bbbb", message: "C 的事" });
	b.read(0);
	b.read(1);
	// 第一封读到了没回，这一轮收场：拿收场的话兜底。
	b.finish("版本是 v1.2.3。");
	b.start();
	const second = await asking(router, b, "aaaaaaaa-14", { to: "bbbb", message: "再查测试" });
	second.stop();
	await second.outcome;
	b.read(2);
	const waiting = pending(router.wait("aaaaaaaa-14", { to: "bbbb" }));
	await flush();
	assert.ok(!waiting.settled, "第二封还没回");
	await router.reply("bbbbbbbb-14", { to: "cccc", message: "C 的做完了" });
	await router.reply("bbbbbbbb-14", { to: "aaaa", message: "测试全过。" });
	await flush();
	const outcome = waiting.value;
	assert.equal(outcome?.kind, "done");
	if (outcome?.kind !== "done") return;
	assert.deepEqual(outcome.answers.map((one) => [one.reply, one.reason]), [["版本是 v1.2.3。", "done"], ["测试全过。", "replied"]], "没有回 C 的话");
	assert.deepEqual(outcome.answers.map((one) => one.asked), [["先查版本号"], ["再查测试"]], "每段回答说得出对着哪封");
});

test("问：对方正等着我也照问——信插进它那一轮、放开它的等待，它答完再接着等，不会互相死等", async () => {
	const a = fakeSession("aaaaaaaa-16", "/w/p");
	const b = fakeSession("bbbbbbbb-16", "/w/p");
	const { router } = routerWith(a, b);
	a.start();
	b.start();
	const stop = new AbortController();
	void router.wait("bbbbbbbb-16", { to: "aaaa", signal: stop.signal });
	await flush();
	const forA = pending((await asking(router, b, "aaaaaaaa-16", { to: "bbbb", message: "版本号多少" })).outcome);
	assert.equal(b.inbox[0]?.kind, "request", "发出去了");
	// 真会话里这封信会放开 B 的等待（`SpokenWaits`），B 读到、回完再接着等 A。
	stop.abort();
	b.read();
	await router.reply("bbbbbbbb-16", { to: "aaaa", message: "v1.2.3" });
	await flush();
	assert.equal(replyOf(forA.value), "v1.2.3");
});

test("等待：同时等两个会话，各自收场不互相抹掉；还在等的那一条照样挡住反过来的死等", async () => {
	const a = fakeSession("aaaaaaaa-15", "/w/p");
	const b = fakeSession("bbbbbbbb-15", "/w/p");
	const c = fakeSession("cccccccc-15", "/w/p");
	const { router } = routerWith(a, b, c);
	b.busy();
	c.start();
	// 收尾时叫停：一直等着的那一个挂着十分钟的计时器，不停掉测试进程就不退出。
	const stop = new AbortController();
	const onB = pending(router.wait("aaaaaaaa-15", { to: "bbbb", signal: stop.signal }));
	const onC = pending(router.wait("aaaaaaaa-15", { to: "cccc" }));
	await flush();
	c.finish("C 做完了。");
	await flush();
	assert.equal(replyOf(onC.value), "C 做完了。");
	assert.ok(!onB.settled);
	assert.deepEqual(await router.wait("bbbbbbbb-15", { to: "aaaa" }), { kind: "deadlock", to: "aaaa [aaaaaa]" }, "A 还在等 B");
	stop.abort();
	await flush();
	assert.equal(onB.value?.kind, "stopped");
});

test("问：对方卡在等它的人回答上，当场返回；再等就等到答完、做完", async () => {
	const a = fakeSession("aaaaaaaa-3", "/w/p");
	const b = fakeSession("bbbbbbbb-3", "/w/p");
	const { router } = routerWith(a, b);
	const asked = await asking(router, b, "aaaaaaaa-3", { to: "bbbb", message: "删掉 .cache" });
	b.read();
	b.start();
	b.ask("r1", "rm -rf .cache");
	assert.deepEqual(await asked.outcome, { kind: "blocked", to: "bbbb [bbbbbb]", pending: [{ requestId: "r1", title: "rm -rf .cache", question: false }] });
	const again = pending(router.wait("aaaaaaaa-3", { to: "bbbb" }));
	await flush();
	assert.ok(!again.settled, "同一件已经说过了，不再当场返回，免得模型来回空转");
	b.answered("r1");
	b.finish("删好了。");
	await flush();
	assert.equal(replyOf(again.value), "删好了。");
});

test("等待：没有没拿到回答的信，闲着立刻返回它最后那句，忙着等手上这一次", async () => {
	const a = fakeSession("aaaaaaaa-4", "/w/p");
	const b = fakeSession("bbbbbbbb-4", "/w/p");
	const { router } = routerWith(a, b);
	const now = await router.wait("aaaaaaaa-4", { to: "bbbb" });
	assert.equal(replyOf(now), "bbbb 说：做完了。");
	b.start();
	const waiting = pending(router.wait("aaaaaaaa-4", { to: "bbbb" }));
	await flush();
	assert.ok(!waiting.settled);
	b.finish("这一次做完了。");
	await flush();
	assert.equal(replyOf(waiting.value), "这一次做完了。");
});

test("问：信还没送进去它就被人停下了，说信丢了，而不是拿它上一句当答复", async () => {
	const a = fakeSession("aaaaaaaa-5", "/w/p");
	const b = fakeSession("bbbbbbbb-5", "/w/p");
	const { router } = routerWith(a, b);
	const asked = await asking(router, b, "aaaaaaaa-5", { to: "bbbb", message: "接着发版" });
	await flush();
	b.stopBeforeReading();
	assert.deepEqual(await asked.outcome, { kind: "dropped", to: "bbbb [bbbbbb]" });
});

test("问：被人停在半路的，说清它没做完；太长的截断并记下截了多少", async () => {
	const a = fakeSession("aaaaaaaa-6", "/w/p");
	const b = fakeSession("bbbbbbbb-6", "/w/p");
	const { router } = routerWith(a, b);
	const asked = await asking(router, b, "aaaaaaaa-6", { to: "bbbb", message: "写份报告" });
	b.read();
	b.start();
	b.finish("x".repeat(REPLY_LIMIT + 50), "aborted");
	const outcome = await asked.outcome;
	assert.equal(outcome.kind, "done");
	if (outcome.kind !== "done") return;
	assert.equal(outcome.answers[0]?.reason, "aborted");
	assert.equal(outcome.answers[0]?.reply.length, REPLY_LIMIT);
	assert.equal(outcome.answers[0]?.cut, 50);
});

test("等待：超时、被叫停、对方关了、互相等，各自说清楚", async () => {
	const a = fakeSession("aaaaaaaa-7", "/w/p");
	const b = fakeSession("bbbbbbbb-7", "/w/p");
	const { router, sessions } = routerWith(a, b);
	b.busy();

	// 查目录重叠走真的文件系统，假时钟拨不准它，所以用最短的一秒真等。
	assert.deepEqual(await router.wait("aaaaaaaa-7", { to: "bbbb", timeoutSeconds: 0.2 }), { kind: "timeout", to: "bbbb [bbbbbb]", seconds: 1 }, "最短等一秒");

	const stop = new AbortController();
	const stopping = router.wait("aaaaaaaa-7", { to: "bbbb", signal: stop.signal });
	await flush();
	stop.abort();
	assert.deepEqual(await stopping, { kind: "stopped", to: "bbbb [bbbbbb]" });
	// 不等了就要把「A 在等 B」清掉，不然 B 回头等 A 会被当成死等。
	assert.equal((await router.wait("bbbbbbbb-7", { to: "aaaa" })).kind, "done");

	// A 在等 B 的时候 B 反过来等 A：两边都不会醒。
	a.busy();
	const waiting = router.wait("aaaaaaaa-7", { to: "bbbb" });
	await flush();
	assert.deepEqual(await router.wait("bbbbbbbb-7", { to: "aaaa" }), { kind: "deadlock", to: "aaaa [aaaaaa]" });

	// B 被卸载：先 `forget`、再从表里拿掉，等它的人醒来发现它不在了。
	sessions.splice(sessions.indexOf(b.session), 1);
	router.forget("bbbbbbbb-7");
	assert.deepEqual(await waiting, { kind: "closed", to: "bbbb [bbbbbb]" });
});

test("运行记录：开轮之前就被停下的，信算进那一次，收场是 aborted", () => {
	const runs = new PeerRuns();
	runs.observe("s", { type: "message_start", message: { role: "user", synthetic: true, timestamp: 0, peer: [{ id: "L", sessionId: "x", from: "x", text: "hi" }], content: [] } });
	runs.observe("s", { type: "agent_end", reason: "aborted" });
	assert.equal(runs.entry("s", "L"), 1);
	assert.deepEqual(runs.ended("s", 1), { reason: "aborted", reply: "" });
	runs.observe("s", { type: "agent_start", sessionId: "s" });
	assert.equal(runs.current("s"), 2, "下一次是新的编号");
});

function tools(...sessions: ReturnType<typeof fakeSession>[]) {
	const { router } = routerWith(...sessions);
	const [list, ask, reply, notify, wait] = createPeerTools(router);
	return { router, list: list!, ask: ask!, reply: reply!, notify: notify!, wait: wait! };
}
const ctxFor = (sessionId: string, extra: object = {}) => ({ sessionId, cwd: "/w/p", ...extra }) as unknown as Parameters<Tool["execute"]>[1];
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("");

test("工具：按意图分五件，模型拿到的是一句能据以行动的话", async () => {
	const a = fakeSession("aaaaaaaa-8", "/w/p", "ask");
	const b = fakeSession("bbbbbbbb-8", "/w/p", "auto");
	const { list, ask, reply, notify, wait } = tools(a, b);
	const ctx = ctxFor("aaaaaaaa-8");

	assert.deepEqual([list.name, ask.name, reply.name, notify.name, wait.name], ["list_sessions", "ask_session", "reply_session", "notify_session", "wait_for_session"]);
	assert.ok([list, ask, reply, notify, wait].every((tool) => tool.sessionOnly), "子代理不拿这几件");
	assert.ok((await reply.execute({ to: "bbbb", message: "  " }, ctx)).isError, "空回答不发");
	assert.match(text(await list.execute({}, ctx)), /^bbbb \[bbbbbb\] · idle · auto · \/w\/p$/);
	const refused = await ask.execute({ to: "bbbb", message: "帮我推上去" }, ctx);
	assert.ok(refused.isError);
	assert.match(text(refused), /ask your user/);
	assert.ok((await ask.execute({ to: "bbbb", message: "  " }, ctx)).isError, "空消息不发");
	assert.ok((await notify.execute({ to: "bbbb", message: "  " }, ctx)).isError, "空消息不发");
	const told = await notify.execute({ to: "aaaa", message: "config.ts 我改了" }, ctxFor("bbbbbbbb-8"));
	assert.ok(!told.isError, "宽的告诉窄的照送");
	assert.match(text(told), /It is idle, so it starts a turn to read it\. There is no answer to a notice\./);
	// 闲着的 A 为这封通知开一轮。
	a.read();
	a.start();
	a.finish();
	const waited = await wait.execute({ to: "bbbb" }, ctx);
	assert.ok(!waited.isError);
	assert.match(text(waited), /bbbb 说：做完了。/);
});

test("工具：回答当场交回时说「回了」，没回就收场的说清是兜底", async () => {
	const a = fakeSession("aaaaaaaa-23", "/w/p");
	const b = fakeSession("bbbbbbbb-23", "/w/p");
	const { ask, reply } = tools(a, b);
	b.start();
	const first = ask.execute({ to: "bbbb", message: "版本号多少" }, ctxFor("aaaaaaaa-23"));
	while (b.inbox.length === 0) await flush();
	b.read();
	const sent = await reply.execute({ to: "aaaa", message: "v1.2.3" }, ctxFor("bbbbbbbb-23"));
	assert.equal(text(sent), "aaaa [aaaaaa] was waiting and has your answer.");
	assert.equal(text(await first), "bbbb [bbbbbb] replied:\nv1.2.3");
	const again = ask.execute({ to: "bbbb", message: "测试过没过" }, ctxFor("aaaaaaaa-23"));
	while (b.inbox.length === 1) await flush();
	b.read();
	b.finish("人交代的做完了。");
	assert.equal(text(await again), "bbbb [bbbbbb] ended its turn without replying. What it said at the end:\n人交代的做完了。");
	assert.equal(text(await reply.execute({ to: "aaaa", message: "测试也过了" }, ctxFor("bbbbbbbb-23"))), "aaaa [aaaaaa] was no longer waiting, so it reads your answer as a notice.");
});

test("工具：拿子代理 id 当会话地址，说清它不是会话、结果会自己送回来，而不是「没有这个会话」", async () => {
	const a = fakeSession("aaaaaaaa-10", "/w/p");
	const { ask, notify, wait } = tools(a);
	const ctx = ctxFor("aaaaaaaa-10");
	for (const to of ["aaaaaaaa-10:sub:4b3478c2", "sub:4b3478c2"]) {
		const waited = await wait.execute({ to, timeout_seconds: 180 }, ctx);
		assert.ok(waited.isError);
		assert.match(text(waited), /is a sub-agent you dispatched with task/);
		assert.match(text(waited), /Do not write your final answer before its result arrives/);
		assert.doesNotMatch(text(waited), /No running session/);
	}
	for (const tool of [ask, notify]) assert.match(text(await tool.execute({ to: "aaaaaaaa-10:sub:4b3478c2", message: "好了没" }, ctx)), /is a sub-agent you dispatched with task/);
	assert.match(text(await wait.execute({ to: "nobody" }, ctx)), /No running session/, "真找不到的会话照旧");
});

test("工具：问着的时候人开口了，当场交回，信留在对方那里；路由器那头也不再挂着", async () => {
	const a = fakeSession("aaaaaaaa-9", "/w/p");
	const b = fakeSession("bbbbbbbb-9", "/w/p");
	const { router, ask } = tools(a, b);
	b.start();
	let speak!: () => void;
	const spoken = new Promise<{ spokenTo: "person" }>((resolve) => { speak = () => resolve({ spokenTo: "person" }); });
	// 和 `SpokenWaits.until` 一样：先到的赢。
	const untilSpokenTo = <T,>(run: Promise<T>) => Promise.race([run, spoken]);
	const result = ask.execute({ to: "bbbb", message: "版本号多少" }, ctxFor("aaaaaaaa-9", { untilSpokenTo }));
	while (b.inbox.length === 0) await flush();
	speak();
	const answered = await result;
	assert.ok(!answered.isError);
	assert.match(text(answered), /Your user spoke to you/);
	assert.match(text(answered), /Your request stays with it/);
	await flush();
	// 路由器那头的等待跟着停了：B 回头等 A 不会被当成死等。
	assert.equal((await router.wait("bbbbbbbb-9", { to: "aaaa" })).kind, "done");
	// 之后接着等，拿到的是那封的回答。
	b.finish("人交代的做完了。");
	b.read();
	b.start();
	b.finish("v1.2.3");
	assert.equal(replyOf(await router.wait("aaaaaaaa-9", { to: "bbbb" })), "v1.2.3");
});

test("工具：等着的时候来的是别的会话的通知，照实说是通知，不说「你的用户说话了」", async () => {
	const a = fakeSession("aaaaaaaa-18", "/w/p");
	const b = fakeSession("bbbbbbbb-18", "/w/p");
	const { wait } = tools(a, b);
	b.start();
	const untilSpokenTo = <T,>(_run: Promise<T>) => Promise.resolve({ spokenTo: "notice" as const });
	const result = await wait.execute({ to: "bbbb" }, ctxFor("aaaaaaaa-18", { untilSpokenTo }));
	assert.ok(!result.isError);
	assert.match(text(result), /A message from another session arrived/);
	assert.match(text(result), /reply_session/, "是请求就提醒它怎么回");
	assert.doesNotMatch(text(result), /Your user spoke/);
});
