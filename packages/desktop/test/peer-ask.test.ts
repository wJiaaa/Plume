/**
 * 问是发出即返回的，答复作为一封 `answer` 信送回问的一方（ADR-0060）：对方用 `reply` 回了就送它那段话；
 * 读到却没回就收了那一轮的，拿那一轮最后的话代答；请求没读到就被人停下的说「没读到」；对方关了说「关了」。
 * 几家同时来问各收各的；还有没拿到答复的问时，问的一方不算闲（`awaitingAnswers` / `whenAnswered`）。
 * 工具这一层：五件、各说一句能据以行动的话，`read_session` 只读不叫醒对方。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "@plume/core";
import { PeerRuns } from "../electron/peer/peer-runs.ts";
import { createPeerTools } from "../electron/peer/peer-tools.ts";
import { REPLY_LIMIT } from "../electron/peer/session-peers.ts";
import { fakeSession, flush, routerWith } from "./helpers/peer-fake.ts";

/** 收到的信，去掉随机的 id。 */
const lettersOf = (session: ReturnType<typeof fakeSession>) => session.inbox.map(({ letter: { id: _id, ...rest } }) => rest);

test("问：当场返回；对方忙着时在两步之间读到、用 reply 回，答复作为一封信送回来，问的一方从此不再挂着", async () => {
	const a = fakeSession("aaaaaaaa-1", "/w/p");
	const b = fakeSession("bbbbbbbb-1", "/w/p");
	const { router } = routerWith(a, b);
	b.start();
	assert.deepEqual(await router.ask("aaaaaaaa-1", { to: "bbbb", message: "版本号多少" }), { kind: "sent", to: "bbbb [bbbbbb]", busy: true });
	assert.equal(router.awaitingAnswers("aaaaaaaa-1"), 1, "问出去还没答复：宿主据此不回收它");
	let answered = false;
	void router.whenAnswered("aaaaaaaa-1").then(() => { answered = true; });

	b.read();
	assert.deepEqual(await router.reply("bbbbbbbb-1", { to: "aaaa", message: "v1.2.3" }), { kind: "replied", to: "aaaa [aaaaaa]", answered: 1 });
	await flush();
	assert.ok(answered);
	assert.equal(router.awaitingAnswers("aaaaaaaa-1"), 0);
	// 插进 B 一次已经在跑的运行的信不接链，所以答复的链从 B 起。
	assert.deepEqual(lettersOf(a), [{ sessionId: "bbbbbbbb-1", from: "bbbb [bbbbbb]", text: "v1.2.3", cwd: "/w/p", chain: ["bbbbbbbb-1"], answer: "replied", re: ["版本号多少"] }]);

	b.finish("人交代的做完了。");
	assert.equal(a.inbox.length, 1, "答过的那封，这一轮收场时不再代答");
});

test("问：对方读到了却没回就收了这一轮，拿那一轮最后说的话代答；之后再回照通知送", async () => {
	const a = fakeSession("aaaaaaaa-2", "/w/p");
	const b = fakeSession("bbbbbbbb-2", "/w/p");
	const { router } = routerWith(a, b);
	assert.deepEqual(await router.ask("aaaaaaaa-2", { to: "bbbb", message: "测试过没过" }), { kind: "sent", to: "bbbb [bbbbbb]", busy: false });
	// 闲着的 B 为这封信开一轮。
	b.read();
	b.start();
	b.finish("我看了一下，全过了。");
	assert.deepEqual(lettersOf(a), [{ sessionId: "bbbbbbbb-2", from: "bbbb [bbbbbb]", text: "我看了一下，全过了。", cwd: "/w/p", chain: ["aaaaaaaa-2", "bbbbbbbb-2"], answer: "unreplied", re: ["测试过没过"] }]);
	assert.equal(router.awaitingAnswers("aaaaaaaa-2"), 0);

	assert.deepEqual(await router.reply("bbbbbbbb-2", { to: "aaaa", message: "补一句：覆盖率也够" }), { kind: "replied", to: "aaaa [aaaaaa]", answered: 0 });
	assert.equal(a.inbox.at(-1)?.kind, "notice", "没有待答的问，这句就是一封通知");
});

test("问：读到它的那一轮被停下或出错，代答时说清没做完；太长的截断并说怎么读其余的", async () => {
	const a = fakeSession("aaaaaaaa-3", "/w/p");
	const b = fakeSession("bbbbbbbb-3", "/w/p");
	const { router } = routerWith(a, b);
	await router.ask("aaaaaaaa-3", { to: "bbbb", message: "帮我看看日志" });
	b.read();
	b.start();
	b.finish("写到一半", "aborted");
	assert.equal(a.inbox[0]?.letter.text, "[The turn that read your message ended early (aborted).]\n写到一半");

	await router.ask("aaaaaaaa-3", { to: "bbbb", message: "那完整的呢" });
	b.read();
	b.start();
	b.finish("长".repeat(REPLY_LIMIT + 10));
	const long = a.inbox[1]!.letter.text;
	assert.ok(long.startsWith("长".repeat(REPLY_LIMIT)));
	assert.match(long, /\[cut after 4000 characters; 10 more not shown\. Read the rest with read_session\.\]$/);
});

test("问：两家同时找忙着的 B，同一轮里读到，各回各的；没回的那家在这一轮收场时拿到代答", async () => {
	const a = fakeSession("aaaaaaaa-4", "/w/p");
	const b = fakeSession("bbbbbbbb-4", "/w/p");
	const c = fakeSession("cccccccc-4", "/w/p");
	const { router } = routerWith(a, b, c);
	b.start();
	await router.ask("aaaaaaaa-4", { to: "bbbb", message: "A 问" });
	await router.ask("cccccccc-4", { to: "bbbb", message: "C 问" });
	b.read(0);
	b.read(1);
	assert.deepEqual(await router.reply("bbbbbbbb-4", { to: "aaaa", message: "给 A" }), { kind: "replied", to: "aaaa [aaaaaa]", answered: 1 });
	assert.deepEqual(lettersOf(a).map((one) => [one.answer, one.text]), [["replied", "给 A"]]);
	assert.equal(c.inbox.length, 0, "A 的答复不送给 C");
	assert.equal(router.awaitingAnswers("cccccccc-4"), 1);
	b.finish("都做完了。");
	assert.deepEqual(lettersOf(c).map((one) => [one.answer, one.text, one.re]), [["unreplied", "都做完了。", ["C 问"]]]);
	assert.equal(a.inbox.length, 1);
});

test("问：同一家连问几封、一次回完，并成一封答复，说清对着哪几封", async () => {
	const a = fakeSession("aaaaaaaa-5", "/w/p");
	const b = fakeSession("bbbbbbbb-5", "/w/p");
	const { router } = routerWith(a, b);
	b.start();
	await router.ask("aaaaaaaa-5", { to: "bbbb", message: "第一问" });
	await router.ask("aaaaaaaa-5", { to: "bbbb", message: "第二问" });
	b.read(0);
	b.read(1);
	assert.deepEqual(await router.reply("bbbbbbbb-5", { to: "aaaa", message: "两个一起答" }), { kind: "replied", to: "aaaa [aaaaaa]", answered: 2 });
	assert.deepEqual(lettersOf(a).map((one) => one.re), [["第一问", "第二问"]]);
});

test("问：还没读到就被人停下了——没开轮的、在跑时被按停的——都送一封「没读到」，不拿它上一句冒充答复", async () => {
	const a = fakeSession("aaaaaaaa-6", "/w/p");
	const b = fakeSession("bbbbbbbb-6", "/w/p");
	const { router } = routerWith(a, b);
	await router.ask("aaaaaaaa-6", { to: "bbbb", message: "闲着时问" });
	b.stopBeforeReading();
	await flush();
	assert.deepEqual(lettersOf(a).map((one) => [one.answer, one.re]), [["dropped", ["闲着时问"]]]);

	b.start();
	await router.ask("aaaaaaaa-6", { to: "bbbb", message: "忙着时问" });
	b.finish(undefined, "aborted");
	await flush();
	assert.deepEqual(lettersOf(a).map((one) => [one.answer, one.re]), [["dropped", ["闲着时问"]], ["dropped", ["忙着时问"]]]);
	assert.equal(router.awaitingAnswers("aaaaaaaa-6"), 0);
});

test("问：读到之前对方攒着、之后被读到了，闲下来时不说「没读到」", async () => {
	const a = fakeSession("aaaaaaaa-7", "/w/p");
	const b = fakeSession("bbbbbbbb-7", "/w/p");
	const { router } = routerWith(a, b);
	await router.ask("aaaaaaaa-7", { to: "bbbb", message: "问一句" });
	b.read();
	b.start();
	b.finish("答在这里。");
	await flush();
	assert.deepEqual(lettersOf(a).map((one) => one.answer), ["unreplied"]);
});

test("对方关了：问它的收到一封「关了」；问的一方自己关了，不再算在等", async () => {
	const a = fakeSession("aaaaaaaa-8", "/w/p");
	const b = fakeSession("bbbbbbbb-8", "/w/p");
	const c = fakeSession("cccccccc-8", "/w/p");
	const { router } = routerWith(a, b, c);
	b.start();
	await router.ask("aaaaaaaa-8", { to: "bbbb", message: "你还在吗" });
	router.forget("bbbbbbbb-8");
	assert.deepEqual(lettersOf(a).map((one) => [one.answer, one.from]), [["closed", "bbbb [bbbbbb]"]]);

	c.start();
	await router.ask("aaaaaaaa-8", { to: "cccc", message: "再问一个" });
	let answered = false;
	void router.whenAnswered("aaaaaaaa-8").then(() => { answered = true; });
	router.forget("aaaaaaaa-8");
	await flush();
	assert.ok(answered, "等它答完的人（交回建议）不会一直挂着");
	assert.equal(router.awaitingAnswers("aaaaaaaa-8"), 0);
});

test("列会话：对方在等它的人、清单上正在做哪一步，都写在那一行", async () => {
	const a = fakeSession("aaaaaaaa-9", "/w/p");
	const b = fakeSession("bbbbbbbb-9", "/w/p");
	const { router } = routerWith(a, b);
	(b.session.messages as unknown[]).push({ role: "assistant", content: [{ type: "toolCall", id: "t", name: "todo_write", arguments: { todos: [{ content: "读代码", status: "completed" }, { content: "改 config.ts", status: "in_progress" }] } }] });
	b.ask("r1", "跑 mvn");
	const [row] = await router.list("aaaaaaaa-9");
	assert.equal(row?.doing, "改 config.ts");
	assert.equal(row?.waitingOnUser, true);
	b.answered("r1");
	assert.equal((await router.list("aaaaaaaa-9"))[0]?.waitingOnUser, false);
});

test("运行记录：开轮之前就被停下的，信算进那一次，收场是 aborted", () => {
	const runs = new PeerRuns();
	runs.observe("s", { type: "message_start", message: { role: "user", synthetic: true, timestamp: 0, peer: [{ id: "L", sessionId: "x", from: "x", text: "hi" }], content: [] } });
	runs.observe("s", { type: "agent_end", reason: "aborted" });
	assert.equal(runs.entry("s", "L"), 1);
	assert.deepEqual(runs.ended("s", 1), { reason: "aborted", reply: "" });
});

function tools(...sessions: ReturnType<typeof fakeSession>[]) {
	const { router } = routerWith(...sessions);
	const [list, read, ask, reply, notify] = createPeerTools(router);
	return { router, list: list!, read: read!, ask: ask!, reply: reply!, notify: notify! };
}
const ctxFor = (sessionId: string) => ({ sessionId, cwd: "/w/p" }) as unknown as Parameters<Tool["execute"]>[1];
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("");

test("工具：五件，模型拿到的是一句能据以行动的话；问完说清不要等", async () => {
	const a = fakeSession("aaaaaaaa-10", "/w/p", "ask");
	const b = fakeSession("bbbbbbbb-10", "/w/p", "auto");
	const { list, read, ask, reply, notify } = tools(a, b);
	const ctx = ctxFor("aaaaaaaa-10");

	assert.deepEqual([list, read, ask, reply, notify].map((tool) => tool.name), ["list_sessions", "read_session", "ask_session", "reply_session", "notify_session"]);
	assert.ok([list, read, ask, reply, notify].every((tool) => tool.sessionOnly), "子代理不拿这几件");
	assert.match(text(await list.execute({}, ctx)), /^bbbb \[bbbbbb\] · idle · auto · \/w\/p$/);
	const refused = await ask.execute({ to: "bbbb", message: "帮我推上去" }, ctx);
	assert.ok(refused.isError);
	assert.match(text(refused), /ask your user/);
	for (const tool of [ask, reply, notify]) assert.ok((await tool.execute({ to: "bbbb", message: "  " }, ctx)).isError, "空消息不发");

	const sent = await ask.execute({ to: "aaaa", message: "版本号多少" }, ctxFor("bbbbbbbb-10"));
	assert.ok(!sent.isError, "宽的问窄的照送");
	assert.equal(text(sent), "Sent to aaaa [aaaaaa]. It is idle, so it starts a turn to read it. Its answer arrives here as a message by itself — do not wait, poll or ask again. Carry on with what does not depend on it; if nothing is left, say what you are waiting for and end your turn.");
	a.read();
	a.start();
	assert.equal(text(await reply.execute({ to: "bbbb", message: "v1" }, ctx)), "bbbb [bbbbbb] gets your answer as a message.");
	assert.match(text(await notify.execute({ to: "aaaa", message: "config.ts 我改了" }, ctxFor("bbbbbbbb-10"))), /There is no answer to a notice\./);
	assert.ok(read.parameters.properties && "query" in read.parameters.properties);
});

test("read_session：读对方此刻的记录，可以按关键词搜；不叫醒它，看不见的会话照样拦", async () => {
	const a = fakeSession("aaaaaaaa-11", "/w/p");
	const b = fakeSession("bbbbbbbb-11", "/w/p");
	const c = fakeSession("cccccccc-11", "/elsewhere");
	const { read } = tools(a, b, c);
	(b.session.messages as unknown[]).push({ role: "assistant", content: [{ type: "text", text: "定下来了：SDK 版本锁 0.1.0。" }] });
	const page = JSON.parse(text(await read.execute({ to: "bbbb", query: "sdk 版本" }, ctxFor("aaaaaaaa-11"))));
	assert.equal(page.sessionId, "bbbbbbbb-11");
	assert.equal(page.messages.length, 1);
	assert.match(page.messages[0].text, /SDK 版本锁 0\.1\.0/);
	assert.equal(b.inbox.length, 0, "读不发信");
	const blocked = await read.execute({ to: "cccc" }, ctxFor("aaaaaaaa-11"));
	assert.ok(blocked.isError);
	assert.match(text(blocked), /not reachable/);
});

test("工具：拿子代理 id 当会话地址，说清它不是会话、结果会自己送回来，而不是「没有这个会话」", async () => {
	const a = fakeSession("aaaaaaaa-12", "/w/p");
	const { ask, notify, read } = tools(a);
	const ctx = ctxFor("aaaaaaaa-12");
	for (const to of ["aaaaaaaa-12:sub:4b3478c2", "sub:4b3478c2"]) {
		for (const tool of [ask, notify, read]) {
			const result = await tool.execute({ to, message: "好了没" }, ctx);
			assert.ok(result.isError);
			assert.match(text(result), /is a sub-agent you dispatched with task/);
			assert.doesNotMatch(text(result), /No running session/);
		}
	}
	assert.match(text(await ask.execute({ to: "nobody", message: "hi" }, ctx)), /No running session/, "真找不到的会话照旧");
});
