/**
 * The 「运行中」 row folds away with its content still in it.
 *
 * Its `data-open` and its content used to be one condition, so a turn that ended without an answer
 * (only tools, stopped, failed) or a compaction starting emptied the row in the frame its fold began:
 * nothing was left to animate, and a transcript pinned to the bottom lost the row's height at once.
 * happy-dom runs no transitions, so the tests deliver the `transitionend` the fold would end with.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";

import { RunningRow, STALL_MS } from "../../src/features/conversation/RunningRow.tsx";
import { fire, mount } from "../helpers/mount.ts";

/** happy-dom's `TransitionEvent` drops `propertyName` from its init, so it is put on by hand. */
function foldEnds(row: Element, propertyName: string) {
	const event = new Event("transitionend", { bubbles: true });
	Object.defineProperty(event, "propertyName", { value: propertyName });
	return fire(row, event);
}

test("a turn that ends without an answer folds the row with the indicator still in it", async () => {
	const view = await mount(h(RunningRow, { running: true, answering: false, grewAt: undefined, answered: false, compacting: false }));
	try {
		const row = view.find(".ly-reveal");
		assert.equal(row.dataset.open, "true");
		assert.ok(view.host.querySelector("[data-ly-running]"), "the indicator shows while the turn runs");
		// 发送那一帧转录就贴了底，高度再慢慢长，刚发出去的消息会被顶上去一截。
		assert.equal(row.style.transition, "opacity var(--ly-t-base) var(--ly-e-out)", "opening animated its height under a pinned transcript");

		await view.rerender(h(RunningRow, { running: false, answering: false, grewAt: undefined, answered: false, compacting: false }));
		assert.equal(row.dataset.open, "false", "the fold starts at once");
		assert.equal(row.style.transition, "", "the fold keeps the reveal's own transition");
		assert.ok(view.host.querySelector("[data-ly-running]"), "emptied in the frame the fold began");

		await foldEnds(row, "opacity");
		assert.ok(view.host.querySelector("[data-ly-running]"), "the fade ending is not the fold ending");
		await foldEnds(row, "grid-template-rows");
		assert.ok(!view.host.querySelector("[data-ly-running]"), "kept after the fold had finished");
	} finally {
		await view.unmount();
	}
});

test("a compaction starting folds the row the same way", async () => {
	const view = await mount(h(RunningRow, { running: true, answering: false, grewAt: undefined, answered: false, compacting: false }));
	try {
		await view.rerender(h(RunningRow, { running: true, answering: false, grewAt: undefined, answered: false, compacting: true }));
		const row = view.find(".ly-reveal");
		assert.equal(row.dataset.open, "false");
		assert.ok(view.host.querySelector("[data-ly-running]"));
		await foldEnds(row, "grid-template-rows");
		assert.ok(!view.host.querySelector("[data-ly-running]"));
	} finally {
		await view.unmount();
	}
});

test("while the conclusion streams the row is only hidden: it keeps its height, and is back when a tool call follows", async () => {
	const view = await mount(h(RunningRow, { running: true, answering: false, grewAt: undefined, answered: false, compacting: false }));
	try {
		const row = view.find(".ly-reveal");
		await view.rerender(h(RunningRow, { running: true, answering: true, grewAt: undefined, answered: false, compacting: false }));
		assert.equal(row.dataset.open, "true", "folding here moved the transcript before the first words were drawn");
		assert.ok(view.host.querySelector("[data-ly-running-quiet]"), "hidden while the conclusion is landing");
		assert.ok(view.host.querySelector("[data-ly-running]"), "still drawn, so its height stays");

		// 写着写着接上了工具调用：同一格里亮回来，高度没动过。
		await view.rerender(h(RunningRow, { running: true, answering: false, grewAt: undefined, answered: false, compacting: false }));
		assert.equal(row.dataset.open, "true");
		assert.ok(!view.host.querySelector("[data-ly-running-quiet]"));
	} finally {
		await view.unmount();
	}
});

test("stopped while the conclusion streams, the row folds away still hidden instead of fading the indicator back in", async () => {
	const view = await mount(h(RunningRow, { running: true, answering: true, grewAt: undefined, answered: false, compacting: false }));
	try {
		const row = view.find(".ly-reveal");
		assert.ok(view.host.querySelector("[data-ly-running-quiet]"));

		// 停止：`running` 落下，被中断的回答不算写完（`answered` 为 false），于是走动画收起。
		await view.rerender(h(RunningRow, { running: false, answering: false, grewAt: undefined, answered: false, compacting: false }));
		assert.equal(row.dataset.open, "false");
		assert.ok(view.host.querySelector("[data-ly-running]"), "the fold still has its content");
		assert.ok(view.host.querySelector("[data-ly-running-quiet]"), "the indicator faded back in over the fold, right after the stop");

		await foldEnds(row, "grid-template-rows");
		assert.ok(!view.host.querySelector("[data-ly-running]"));

		// 下一轮照常展开，不带着上一轮收起时的隐。
		await view.rerender(h(RunningRow, { running: true, answering: false, grewAt: undefined, answered: false, compacting: false }));
		assert.equal(row.dataset.open, "true");
		assert.ok(view.host.querySelector("[data-ly-running]"));
		assert.ok(!view.host.querySelector("[data-ly-running-quiet]"), "the next turn opened with the indicator hidden");
	} finally {
		await view.unmount();
	}
});

test("a finished answer takes the row's place in one frame, with nothing left behind", async () => {
	const view = await mount(h(RunningRow, { running: true, answering: true, grewAt: undefined, answered: false, compacting: false }));
	try {
		const row = view.find(".ly-reveal");
		// 消息先定稿，`running` 晚一步才落下；回答底下的操作行要等 `running` 落下才长出来。
		await view.rerender(h(RunningRow, { running: true, answering: false, grewAt: undefined, answered: true, compacting: false }));
		assert.equal(row.dataset.open, "true", "folding before the action row grows drops a pinned transcript by the row's height");
		assert.ok(view.host.querySelector("[data-ly-running-quiet]"), "not flashed back in before the turn ends");

		await view.rerender(h(RunningRow, { running: false, answering: false, grewAt: undefined, answered: true, compacting: false }));
		assert.equal(row.dataset.open, "false", "the reply's action row is growing in this same commit");
		assert.equal(row.style.transition, "none", "an animated fold would sink the answer after the action row lifted it");
		assert.ok(!view.host.querySelector("[data-ly-running]"), "an indicator stayed mounted after the turn");

		// 下一轮开始：最后一条成了人说的话，照常展开。
		await view.rerender(h(RunningRow, { running: true, answering: false, grewAt: undefined, answered: false, compacting: false }));
		assert.equal(row.dataset.open, "true");
		assert.doesNotMatch(row.style.transition, /grid-template-rows|none/, "the next turn opens at full height, only fading in");
		assert.match(row.style.transition, /opacity/);
	} finally {
		await view.unmount();
	}
});

/*
 * 一段写得慢的结论：藏到写完的话，从第一段末尾起屏幕上就不说耗时和速度，也看不出是在写还是卡住了。
 */
const row = (grewAt: number | undefined, more: Partial<{ running: boolean; answering: boolean; answered: boolean }> = {}) =>
	h(RunningRow, { running: true, answering: true, grewAt, answered: false, compacting: false, ...more });

test("a conclusion that stops growing brings the row back, and the next words hide it again in the same frame", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
	const view = await mount(row(10_000));
	try {
		assert.ok(view.host.querySelector("[data-ly-running-quiet]"), "hidden while the conclusion is landing");

		await act(async () => t.mock.timers.tick(STALL_MS - 1));
		assert.ok(view.host.querySelector("[data-ly-running-quiet]"), "back before the words had stopped long enough");

		// 还在长：每来一段就重新等。
		await view.rerender(row(Date.now()));
		await act(async () => t.mock.timers.tick(STALL_MS - 1));
		assert.ok(view.host.querySelector("[data-ly-running-quiet]"), "the wait did not restart when more words came");

		await act(async () => t.mock.timers.tick(1));
		assert.ok(!view.host.querySelector("[data-ly-running-quiet]"), "still hidden after the conclusion stalled");
		assert.ok(view.host.querySelector("[data-ly-running]"));

		await view.rerender(row(Date.now()));
		assert.ok(view.host.querySelector("[data-ly-running-quiet]"), "left showing under words that are growing again");
	} finally {
		await view.unmount();
		t.mock.timers.reset();
	}
});

/*
 * 会话 a931dccf：正文写完以后网关隔了约两秒才收尾。那段时间不是停住——运行行冒出来一下，接着就被页脚顶掉。
 */
test("a conclusion that has been written out is not a stall while the reply waits to close", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
	const view = await mount(row(10_000));
	try {
		// 正文块标了 `ended`：`proseGrewAt` 没有时刻。
		await view.rerender(row(undefined));
		await act(async () => t.mock.timers.tick(STALL_MS * 3));
		assert.ok(view.host.querySelector("[data-ly-running-quiet]"), "the row came back in the gap before the reply closed");
	} finally {
		await view.unmount();
		t.mock.timers.reset();
	}
});

test("coming back to a conclusion that stopped long ago shows the row at once, without waiting again", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 60_000 });
	// 字停在一分钟前：时刻记在消息上，不是从这一行看见它起算。
	const view = await mount(row(0));
	try {
		assert.ok(!view.host.querySelector("[data-ly-running-quiet]"), "hidden for another wait after switching back");
	} finally {
		await view.unmount();
		t.mock.timers.reset();
	}
});
