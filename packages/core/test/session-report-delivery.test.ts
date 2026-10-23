/**
 * 从建议卡片上开出来、要求交回的会话，第一轮的回复回到提建议的那个对话：和子代理的结果同一条送达。
 *
 * 守着三件事：给模型的那一份说清这是哪个会话、还在、该怎么接；给界面的那一份是 `kind: "session"`，
 * 不会被当成子代理画出一张脸；人按了停，攒着的那一份不再送——和子代理的结果一样。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryMessage } from "../src/runtime/agent-session/delivery-message.ts";
import { SessionDeliveries } from "../src/runtime/agent-session/session-deliveries.ts";
import type { MonitorEvents } from "../src/tools/background-jobs.ts";
import type { Message } from "../src/types.ts";

const textOf = (message: Message) => message.content.map((part) => ("text" in part ? part.text : "")).join("");
const REPORT = { sessionId: "s-child", title: "补上 \"使用说明\"", status: "done" as const, reply: "文档补在 docs/guide/usage.md。" };

test("送达消息：交回的会话有自己的标签和种类，给界面的那一份不带回复正文", () => {
	const message = deliveryMessage([], [], [], [REPORT, { ...REPORT, sessionId: "s-other", status: "failed", reply: "" }]);
	const text = textOf(message);
	assert.match(text, /<session_result id="s-child" title="补上 '使用说明'" status="done">\n文档补在 docs\/guide\/usage.md。/, "标题里的引号不能把标签撑破");
	assert.match(text, /status="failed">\n（它没有留下回复。）/);
	assert.match(text, /那个会话还在/);
	assert.doesNotMatch(text, /子代理有结果了/, "不是子代理");
	assert.deepEqual(message.role === "user" ? message.delivery : null, [
		{ id: "s-child", kind: "session", agent: "", description: "补上 \"使用说明\"", status: "done" },
		{ id: "s-other", kind: "session", agent: "", description: "补上 \"使用说明\"", status: "failed" },
	]);
});

function deliveries(quiet: ReadonlySet<string> = new Set()) {
	const submitted: Message[] = [];
	let stopped = false;
	const activity = { mark: () => 0, compaction: null, stoppedSince: () => stopped };
	const box = new SessionDeliveries({
		activity: activity as never,
		// 这里静音的都是被 `stop` 停下的，两问答案一样。
		jobs: () => ({ isQuiet: (id: string) => quiet.has(id), wasStopped: (id: string) => quiet.has(id), observed: () => {} }) as never,
		detail: () => null,
		outstanding: () => [],
		submit: async (message) => { submitted.push(message); },
		settled: () => {},
	});
	return { box, submitted, stop: () => { stopped = true; } };
}

test("攒一下就送成一条；送之前不算空闲", async () => {
	const { box, submitted } = deliveries();
	box.sessionFinished(REPORT);
	assert.equal(box.empty, false, "攒着的那一条四百毫秒后会开一轮");
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(submitted.length, 1);
	assert.deepEqual(submitted[0].role === "user" ? submitted[0].delivery?.map((one) => one.kind) : null, ["session"]);
	assert.equal(box.empty, true);
});

test("人按了停：攒着的不再送", async () => {
	const { box, submitted } = deliveries();
	box.sessionFinished(REPORT);
	box.clear({ monitors: true });
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(submitted.length, 0);
	assert.equal(box.empty, true);
});

const batch = (id: string, text: string, stopped?: MonitorEvents["stopped"]): MonitorEvents =>
	({ id, command: "tail -f app.log", text, lines: 1, dropped: 0, ...(stopped ? { stopped, limit: 2 } : {}) });

test("monitor 自己停了：攒批窗口里它前一批也送，从面板停掉的那个不送", async () => {
	// 两个都已经停下：m1 撑满 max_events 自己停了，m2 是人从服务面板停的。
	const { box, submitted } = deliveries(new Set(["m1", "m2"]));
	box.monitored(batch("m1", "error: first"));
	box.monitored(batch("m2", "from the panel"));
	box.monitored(batch("m1", "error: last", "max_events"));
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(submitted.length, 1);
	const text = textOf(submitted[0]);
	assert.match(text, /error: first/, "已经标成读过的行，这里丢了就再也找不回来");
	assert.match(text, /error: last/);
	assert.doesNotMatch(text, /from the panel/);
});

test("插话停下这一轮：攒着的 monitor 输出照送，别的照旧清掉", async () => {
	const { box, submitted } = deliveries();
	box.sessionFinished(REPORT);
	box.monitored(batch("m1", "error: boom"));
	box.clear({ monitors: false });
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(submitted.length, 1);
	assert.deepEqual(submitted[0].role === "user" ? submitted[0].delivery?.map((one) => one.kind) : null, ["job"]);
	assert.match(textOf(submitted[0]), /error: boom/);
});
