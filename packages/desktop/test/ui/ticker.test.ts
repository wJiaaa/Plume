/**
 * 共用的一拍——见 `ui/motion/ticker.ts`。
 *
 * 钉住四件事：120Hz 屏上一秒只来 30 拍左右，不是 120 次；窗口最小化时更慢、失焦不慢；同一拍约的回调在同一帧里一起跑（几个面板的
 * 写入才会合成一次提交）；拍与拍之间不挂 rAF，合成器没有理由每帧来要主线程帧。
 *
 * 显示器是模拟的：一个按 120Hz 走的 vsync 和一份按时间排的计时器，不靠真时间，结果不随机器快慢变。
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { cancelTick, requestTick, setWindowMinimized, TICK_MS } from "../../src/ui/motion/ticker.ts";

const VSYNC = 1000 / 120;
/** 整个文件共用一只表：真的 `performance.now()` 不会倒着走，节拍器记着上一拍的时刻。 */
let now = 0;

function display(t: TestContext) {
	let seq = 0;
	const frames = new Map<number, FrameRequestCallback>();
	const timers = new Map<number, { at: number; run: () => void }>();
	let rafCalls = 0;
	t.mock.method(globalThis, "requestAnimationFrame", (callback: FrameRequestCallback) => {
		rafCalls++;
		frames.set(++seq, callback);
		return seq;
	});
	t.mock.method(globalThis, "cancelAnimationFrame", (id: number) => frames.delete(id));
	t.mock.method(performance, "now", () => now);
	t.mock.method(window, "setTimeout", ((run: () => void, ms = 0) => {
		timers.set(++seq, { at: now + ms, run });
		return seq;
	}) as never);
	t.mock.method(window, "clearTimeout", ((id: number) => timers.delete(id)) as never);

	/** 往前走 `ms` 毫秒：计时器按时刻触发，每个 vsync 跑一遍当时挂着的 rAF。 */
	const run = (ms: number) => {
		const until = now + ms;
		for (let vsync = Math.ceil(now / VSYNC) * VSYNC; vsync <= until; vsync += VSYNC) {
			for (;;) {
				const next = [...timers].filter(([, timer]) => timer.at <= vsync).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				timers.delete(next[0]);
				now = next[1].at;
				next[1].run();
			}
			now = vsync;
			const due = [...frames.values()];
			frames.clear();
			for (const callback of due) callback(vsync);
		}
		now = until;
	};
	return { run, rafCalls: () => rafCalls };
}

test("120Hz 屏上一秒约 30 拍，不是每帧", (t) => {
	const screen = display(t);
	const stamps: number[] = [];
	let id = 0;
	const loop = (at: number) => {
		stamps.push(at);
		id = requestTick(loop);
	};
	id = requestTick(loop);
	screen.run(1000);
	cancelTick(id);
	assert.ok(stamps.length >= 29 && stamps.length <= 31, `一秒 ${stamps.length} 拍`);
	const gaps = stamps.slice(1).map((at, index) => Math.round(at - stamps[index]));
	assert.ok(gaps.every((gap) => gap >= 33 && gap <= 34), `拍距应该是四帧：${gaps.join(",")}`);
});

test("同一拍约的回调在同一帧里一起跑", (t) => {
	const screen = display(t);
	const seen: [string, number][] = [];
	requestTick((at) => seen.push(["正文", at]));
	screen.run(5);
	requestTick((at) => seen.push(["滚动", at]));
	requestTick((at) => seen.push(["淡入", at]));
	screen.run(200);
	assert.equal(seen.length, 3);
	assert.equal(seen[1][1], seen[2][1], `后约的两个应该落在同一帧：${JSON.stringify(seen)}`);
});

test("拍与拍之间不挂 rAF：一秒里约 rAF 的次数和拍数同一个量级", (t) => {
	const screen = display(t);
	let ticks = 0;
	let id = 0;
	const loop = () => {
		ticks++;
		id = requestTick(loop);
	};
	id = requestTick(loop);
	screen.run(1000);
	cancelTick(id);
	assert.ok(screen.rafCalls() <= ticks + 2, `${ticks} 拍约了 ${screen.rafCalls()} 次 rAF，每帧都挂的话是 120 次`);
});

test("全部取消之后什么都不再跑", (t) => {
	const screen = display(t);
	let ran = 0;
	const id = requestTick(() => ran++);
	cancelTick(id);
	const before = screen.rafCalls();
	screen.run(500);
	assert.equal(ran, 0);
	assert.equal(screen.rafCalls(), before, "取消之后不再约帧");
});

test("失焦照旧 30 拍；最小化时一秒约 10 拍，还原立刻恢复 30 拍", (t) => {
	const screen = display(t);
	const stamps: number[] = [];
	let id = 0;
	const loop = (at: number) => {
		stamps.push(at);
		id = requestTick(loop);
	};
	window.dispatchEvent(new Event("blur"));
	try {
		id = requestTick(loop);
		screen.run(1000);
		assert.ok(stamps.length >= 29 && stamps.length <= 31, `失焦一秒 ${stamps.length} 拍：并排摆着的窗口人还看得见`);
		const down = now;
		setWindowMinimized(true);
		screen.run(1000);
		const minimized = stamps.filter((at) => at > down);
		assert.ok(minimized.length >= 9 && minimized.length <= 11, `最小化一秒 ${minimized.length} 拍`);
		const back = now;
		setWindowMinimized(false);
		screen.run(1000);
		const after = stamps.filter((at) => at > back);
		assert.ok(after.length >= 29 && after.length <= 31, `还原一秒 ${after.length} 拍`);
		assert.ok(after[0] - back < TICK_MS, `还原后第一拍不该再等满最小化时约的那 100ms：${Math.round(after[0] - back)}ms`);
	} finally {
		setWindowMinimized(false);
		window.dispatchEvent(new Event("focus"));
		cancelTick(id);
	}
});
