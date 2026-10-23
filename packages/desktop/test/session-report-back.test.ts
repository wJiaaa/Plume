/**
 * 要求交回的建议会话：第一轮结束、会话闲下来才交，只交一次，人停下的不交，出错的标成没跑完。规则在
 * `electron/session/session-report-back.ts`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, SessionMeta } from "@plume/core";
import { reportBackAfterFirstTurn, type SessionReport } from "../electron/session/session-report-back.ts";

const end = (reason: Extract<AgentEvent, { type: "agent_end" }>["reason"]): AgentEvent => ({ type: "agent_end", reason });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function host(spawnedFrom?: SessionMeta["spawnedFrom"], running = true, idle: () => Promise<void> = async () => {}) {
	const metas = new Map<string, Partial<SessionMeta>>([["s-child", { id: "s-child", title: "补上使用说明", spawnedFrom }]]);
	const log: string[] = [];
	const delivered: { parentId: string; report: SessionReport }[] = [];
	let reply = "补好了。";
	const watcher = reportBackAfterFirstTurn({
		meta: (id) => metas.get(id) as SessionMeta | undefined,
		running: () => running,
		reply: () => reply,
		whenIdle: idle,
		write: async (id, from) => {
			log.push(`write:${id}:${from.settled ? "settled" : from.reportBack ? "on" : "off"}`);
			const meta = metas.get(id);
			if (meta) metas.set(id, { ...meta, spawnedFrom: from });
		},
		deliver: async (parentId, report) => {
			log.push(`deliver:${parentId}`);
			delivered.push({ parentId, report });
		},
	});
	return { watcher, log, delivered, metas, say: (text: string) => (reply = text) };
}

const FROM = { sessionId: "s-parent", toolCallId: "toolu_1", reportBack: true as const };

test("第一轮以 done 收尾：先撕条子，再把最后那段回复送回提建议的那个；之后的轮不再交", async () => {
	const { watcher, log, delivered } = host(FROM);
	watcher.observe("s-child", { type: "agent_start" } as AgentEvent);
	watcher.observe("s-child", end("done"));
	await settle();
	assert.deepEqual(log, ["write:s-child:settled", "deliver:s-parent"]);
	assert.deepEqual(delivered[0].report, { sessionId: "s-child", title: "补上使用说明", status: "done", reply: "补好了。" });
	watcher.observe("s-child", end("done"));
	await settle();
	assert.equal(delivered.length, 1, "人在里面接着聊，不再往回送");
});

test("被人停下：条子照样撕，但不交", async () => {
	const { watcher, log } = host(FROM);
	watcher.observe("s-child", end("aborted"));
	await settle();
	assert.deepEqual(log, ["write:s-child:settled"]);
});

test("出错、跑到上限：交回去，标成没跑完", async () => {
	for (const reason of ["error", "max_turns", "stalled"] as const) {
		const { watcher, delivered } = host(FROM);
		watcher.observe("s-child", end(reason));
		await settle();
		assert.equal(delivered[0]?.report.status, "failed", reason);
	}
});

test("没要求交回的：第一轮结束只记一笔 settled，不交；不是从建议开出来的、不在内存里的什么都不做", async () => {
	const plain = host({ sessionId: "s-parent", toolCallId: "toolu_1" });
	plain.watcher.observe("s-child", end("done"));
	await settle();
	assert.deepEqual(plain.log, ["write:s-child:settled"]);
	assert.deepEqual(plain.metas.get("s-child")?.spawnedFrom, { sessionId: "s-parent", toolCallId: "toolu_1", settled: true });

	const none = host(undefined);
	none.watcher.observe("s-child", end("done"));
	none.watcher.observe("s-unknown", end("done"));
	await settle();
	assert.deepEqual(none.log, []);
});

test("已经 settled 的（重启后接着聊）：不再记、不再交", async () => {
	const { watcher, log } = host({ sessionId: "s-parent", toolCallId: "toolu_1", settled: true });
	watcher.observe("s-child", end("done"));
	await settle();
	assert.deepEqual(log, []);
});

test("开始以后打开交回：第一轮在跑时算数，结束时照新的交；关上的就不交", async () => {
	const on = host({ sessionId: "s-parent", toolCallId: "toolu_1" });
	assert.equal(await on.watcher.set("s-child", true), true);
	assert.equal(on.metas.get("s-child")?.spawnedFrom?.reportBack, true, "写进 meta，窗口照它画");
	on.watcher.observe("s-child", end("done"));
	await settle();
	assert.deepEqual(on.log, ["write:s-child:on", "write:s-child:settled", "deliver:s-parent"]);

	const off = host(FROM);
	assert.equal(await off.watcher.set("s-child", false), true);
	off.watcher.observe("s-child", end("done"));
	await settle();
	assert.equal(off.delivered.length, 0);
});

test("改主意以内存为准：meta 还没写到、第一轮就结束了，也照新的交", async () => {
	const { watcher, delivered, metas } = host({ sessionId: "s-parent", toolCallId: "toolu_1" });
	const asked = watcher.set("s-child", true);
	// 写 meta 的那一拍之前就结束：读到的 meta 还是关着的。
	metas.set("s-child", { id: "s-child", title: "补上使用说明", spawnedFrom: { sessionId: "s-parent", toolCallId: "toolu_1" } });
	watcher.observe("s-child", end("done"));
	await asked;
	await settle();
	assert.equal(delivered.length, 1);
});

test("晚了的不算：第一轮已经结束、已经 settled、没在跑、不是从建议开出来的，都答 false 且不写", async () => {
	const ended = host({ sessionId: "s-parent", toolCallId: "toolu_1" });
	ended.watcher.observe("s-child", end("done"));
	await settle();
	assert.equal(await ended.watcher.set("s-child", true), false, "这个进程里第一轮已经收尾");

	for (const [from, running] of [[{ sessionId: "s-parent", toolCallId: "toolu_1", settled: true as const }, true], [{ sessionId: "s-parent", toolCallId: "toolu_1" }, false], [undefined, true]] as const) {
		const { watcher, log } = host(from, running);
		assert.equal(await watcher.set("s-child", true), false);
		assert.deepEqual(log, []);
	}
});

test("第一轮派了子代理就收尾：条子当场撕掉，等后台的都送回、会话闲下来，交最后那一轮的话和收场", async () => {
	let idle!: () => void;
	const { watcher, delivered, log, say } = host(FROM, true, () => new Promise<void>((resolve) => (idle = resolve)));
	say("已派出三个审查，结果回来再说。");
	watcher.observe("s-child", end("done"));
	// 写 meta 的那一拍还没过，送达那一轮就结束了：也要记到。
	watcher.observe("s-child", end("error"));
	await settle();
	assert.deepEqual(log, ["write:s-child:settled"], "条子当场撕：这段时间里退出应用，重启后也不会把人后来的聊天交回去");
	assert.equal(delivered.length, 0, "派完那一轮收尾时不送");

	say("合并后的结论：a.ts:12 要补空值判断。");
	watcher.observe("s-child", end("done"));
	idle();
	await settle();
	assert.equal(delivered.length, 1);
	assert.deepEqual(delivered[0].report, { sessionId: "s-child", title: "补上使用说明", status: "done", reply: "合并后的结论：a.ts:12 要补空值判断。" });
});

test("中间一轮出错、最后那一轮也没跑完：按最后那一轮标成没跑完", async () => {
	let idle!: () => void;
	const { watcher, delivered } = host(FROM, true, () => new Promise<void>((resolve) => (idle = resolve)));
	watcher.observe("s-child", end("done"));
	watcher.observe("s-child", end("stalled"));
	await settle();
	idle();
	await settle();
	assert.equal(delivered[0]?.report.status, "failed");
});

test("等后台结果的时候人按了停：最后那一轮是 aborted，不交", async () => {
	let idle!: () => void;
	const { watcher, delivered } = host(FROM, true, () => new Promise<void>((resolve) => (idle = resolve)));
	watcher.observe("s-child", end("done"));
	watcher.observe("s-child", end("aborted"));
	await settle();
	idle();
	await settle();
	assert.equal(delivered.length, 0);
});

test("审阅会话派了审查子代理：交回的是它们送回之后那一轮写的报告，`review` 撕条子后还在", async () => {
	let idle!: () => void;
	const { watcher, delivered, metas, say } = host({ ...FROM, review: true }, true, () => new Promise<void>((resolve) => (idle = resolve)));
	say("已派出 4 个审查子智能体，结果回来后核实。");
	watcher.observe("s-child", end("done"));
	await settle();
	assert.deepEqual(metas.get("s-child")?.spawnedFrom, { sessionId: "s-parent", toolCallId: "toolu_1", review: true, settled: true }, "凭它拒绝再转交、只读");

	// 四份结果陆续送达，每份一轮；最后一轮写出报告，会话才闲下来。
	for (let i = 0; i < 3; i++) watcher.observe("s-child", end("done"));
	say("## Review: local changes · effort medium\n\n### Findings\n1. a.ts:12 — CONFIRMED");
	watcher.observe("s-child", end("done"));
	assert.equal(delivered.length, 0, "子代理还没都回来时不交");
	idle();
	await settle();
	assert.equal(delivered.length, 1);
	assert.match(delivered[0].report.reply, /^## Review: .*\n[\s\S]*CONFIRMED/);
	assert.equal(delivered[0].report.status, "done");
});
