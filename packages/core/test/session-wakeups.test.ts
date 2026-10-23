/**
 * 定时唤醒的任务表（`session-wakeups.ts`），用假时钟：一次性唤醒到点送一次就没了、下限抬到 60 秒、
 * 上限拒绝；cron 循环、一次性、过期前最后一次说清楚；数量上限；上一次开的那一轮没结束时跳过而不是
 * 排成一串；取消；睡过头不补发。
 */

process.env.TZ = "Asia/Shanghai";

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionWakeup } from "../src/agent/events.ts";
import { CRON_MAX_AGE_MS, MAX_WAKEUPS, SessionWakeups, type WakeupClock } from "../src/runtime/agent-session/session-wakeups.ts";
import type { Message } from "../src/types.ts";

const MINUTE = 60_000;
/** 2026-10-23 14:00:30，上海时间。 */
const START = new Date(2026, 9, 23, 14, 0, 30).getTime();

function fakeClock(start = START) {
	let now = start;
	let seq = 0;
	const timers = new Map<number, { at: number; run: () => void }>();
	const clock: WakeupClock & { advance(ms: number): void; jump(ms: number): void; pending(): number } = {
		now: () => now,
		setTimeout(run, ms) {
			seq += 1;
			timers.set(seq, { at: now + ms, run });
			return seq;
		},
		clearTimeout(handle) {
			timers.delete(handle as number);
		},
		/** 时间往前走，路上到点的计时器按先后跑。 */
		advance(ms) {
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
		/** 墙上时间跳过去，计时器不动——合盖睡眠。 */
		jump(ms) {
			now += ms;
		},
		pending: () => timers.size,
	};
	return clock;
}

function harness() {
	const clock = fakeClock();
	const delivered: Message[] = [];
	const lists: SessionWakeup[][] = [];
	const wakeups = new SessionWakeups({ deliver: (message) => delivered.push(message), changed: (list) => lists.push(list), clock });
	return { clock, delivered, lists, wakeups };
}

const textOf = (message: Message) => message.content.map((part) => ("text" in part ? part.text : "")).join("\n");
/** 送进去的那一轮开始、结束：会话会发的那两个事件。 */
function runTurn(wakeups: SessionWakeups, message: Message) {
	wakeups.observe({ type: "message_start", message });
	wakeups.observe({ type: "agent_end", reason: "done" });
}

test("一次性唤醒：到点送一次，带着 id 和理由，送完就从表里没了", () => {
	const h = harness();
	const { wakeup, clamped } = h.wakeups.wakeup(600, "看 CI 结果", "等 #482 的 CI");
	assert.equal(clamped, false);
	assert.equal(wakeup.nextAt, START + 10 * MINUTE);
	assert.deepEqual(h.wakeups.list().map((one) => one.id), [wakeup.id]);
	h.clock.advance(10 * MINUTE - 1);
	assert.equal(h.delivered.length, 0, "没到点不送");
	h.clock.advance(1);
	assert.equal(h.delivered.length, 1);
	const [message] = h.delivered;
	assert.ok(message?.role === "user" && message.synthetic, "运行时递的，不是人说的话");
	assert.deepEqual(message.role === "user" ? message.delivery : null, [{ id: wakeup.id, kind: "wakeup", agent: "", description: "等 #482 的 CI", status: "done" }]);
	assert.match(textOf(message!), new RegExp(`schedule_wakeup.*id="${wakeup.id}".*等 #482 的 CI`));
	assert.match(textOf(message!), /一次性的，之后不会再唤醒你/);
	assert.match(textOf(message!), /<wakeup id="wake-1">\n看 CI 结果\n<\/wakeup>/);
	assert.deepEqual(h.wakeups.list(), []);
	assert.deepEqual(h.lists.at(-1), [], "表变了交出去");
	assert.equal(h.clock.pending(), 0, "没有任务就不留计时器");
});

test("唤醒短于 60 秒抬到 60 秒，长于 24 小时拒绝", () => {
	const h = harness();
	const { wakeup, clamped } = h.wakeups.wakeup(5, "x", "y");
	assert.equal(clamped, true);
	assert.equal(wakeup.nextAt, START + MINUTE);
	assert.throws(() => h.wakeups.wakeup(24 * 3600 + 1, "x", "y"), /24 hours.*Scheduled page/);
	assert.throws(() => h.wakeups.wakeup(Number.NaN, "x", "y"), /number/);
});

test("循环 cron：每次到点送一条，写明第几次、下一次和过期时刻", () => {
	const h = harness();
	const job = h.wakeups.cron("*/5 * * * *", "看部署", true);
	// 14:00:30 建的，60 秒以后的第一个整五分钟。
	assert.equal(job.nextAt, new Date(2026, 9, 23, 14, 5).getTime());
	assert.equal(job.expiresAt, START + CRON_MAX_AGE_MS);
	h.clock.advance(5 * MINUTE);
	assert.equal(h.delivered.length, 1);
	assert.match(textOf(h.delivered[0]!), /cron_create.*id="cron-1".*cron="\*\/5 \* \* \* \*".*第 1 次触发/);
	assert.match(textOf(h.delivered[0]!), /下一次在 2026-10-23 14:10 \(UTC\+08:00\)；它在 2026-10-26 14:00 \(UTC\+08:00\) 过期/);
	assert.equal(h.wakeups.list()[0]?.nextAt, new Date(2026, 9, 23, 14, 10).getTime());
	runTurn(h.wakeups, h.delivered[0]!);
	h.clock.advance(5 * MINUTE);
	assert.equal(h.delivered.length, 2);
	assert.match(textOf(h.delivered[1]!), /第 2 次触发/);
	assert.equal(h.wakeups.list()[0]?.fired, 2);
});

test("cron 第一次至少在 60 秒之后", () => {
	const h = harness();
	// 14:00:30 时，14:01 只差 30 秒，跳到 14:02。
	assert.equal(h.wakeups.cron("* * * * *", "x", true).nextAt, new Date(2026, 9, 23, 14, 2).getTime());
});

test("recurring: false 只触发一次就删掉", () => {
	const h = harness();
	const once = h.wakeups.cron("30 14 * * *", "看队列", false);
	assert.equal(once.nextAt, new Date(2026, 9, 23, 14, 30).getTime());
	assert.equal(once.expiresAt, undefined);
	h.clock.advance(30 * MINUTE);
	assert.equal(h.delivered.length, 1);
	assert.match(textOf(h.delivered[0]!), /一次性的（recurring: false），触发这一次后已经删掉/);
	assert.deepEqual(h.wakeups.list(), []);
	h.clock.advance(24 * 60 * MINUTE);
	assert.equal(h.delivered.length, 1);
});

test("3 天内对不上的 cron 不收", () => {
	const h = harness();
	assert.throws(() => h.wakeups.cron("0 9 1 1 *", "x", true), /3 days.*Scheduled page/);
	assert.throws(() => h.wakeups.cron("0 9 * *", "x", true), /5 fields/);
	assert.deepEqual(h.wakeups.list(), []);
});

test("循环任务过期：最后一次送达说这是最后一次，之后不再触发", () => {
	const h = harness();
	// 每天 15:00：23、24、25、26 号的 15:00 里，26 号那次在过期（26 号 14:00:30）之后。
	h.wakeups.cron("0 15 * * *", "日报", true);
	for (let day = 0; day < 3; day++) {
		h.clock.advance(24 * 60 * MINUTE);
		runTurn(h.wakeups, h.delivered.at(-1)!);
	}
	assert.equal(h.delivered.length, 3);
	assert.doesNotMatch(textOf(h.delivered[1]!), /最后一次/);
	assert.match(textOf(h.delivered[2]!), /这是它过期前的最后一次触发，之后不会再唤醒你/);
	assert.deepEqual(h.wakeups.list(), []);
	h.clock.advance(3 * 24 * 60 * MINUTE);
	assert.equal(h.delivered.length, 3);
});

test("每个会话最多 10 个，删一个才能再建", () => {
	const h = harness();
	for (let i = 0; i < MAX_WAKEUPS; i++) h.wakeups.wakeup(600 + i, `p${i}`, `r${i}`);
	assert.throws(() => h.wakeups.cron("*/5 * * * *", "x", true), /already has 10.*cron_delete/);
	assert.equal(h.wakeups.cancel("wake-3"), true);
	assert.equal(h.wakeups.cancel("wake-3"), false, "删过的再删答 false");
	h.wakeups.cron("*/5 * * * *", "x", true);
	assert.equal(h.wakeups.list().length, MAX_WAKEUPS);
});

test("上一次开的那一轮没结束：这次跳过不排队，下一次送达说跳过了几次", () => {
	const h = harness();
	h.wakeups.cron("*/5 * * * *", "看部署", true);
	h.clock.advance(5 * MINUTE);
	assert.equal(h.delivered.length, 1);
	// 排着还没轮上（人那一轮还在跑）：别的回合收尾不算它的。
	h.wakeups.observe({ type: "agent_end", reason: "done" });
	h.clock.advance(5 * MINUTE);
	assert.equal(h.delivered.length, 1, "排着的那条还没开始，不再排一条");
	// 轮到它了，那一轮跑了很久。
	h.wakeups.observe({ type: "message_start", message: h.delivered[0]! });
	h.clock.advance(5 * MINUTE);
	assert.equal(h.delivered.length, 1, "它开的那一轮还在跑，也跳过");
	h.wakeups.observe({ type: "agent_end", reason: "done" });
	h.clock.advance(5 * MINUTE);
	assert.equal(h.delivered.length, 2);
	assert.match(textOf(h.delivered[1]!), /又到点了 2 次，那几次跳过了/);
	assert.equal(h.wakeups.list()[0]?.fired, 2, "跳过的不算次数");
});

test("上一次没送进去（提交出错）：不当成「还没看完」，下一次照常送", async () => {
	const clock = fakeClock();
	const delivered: Message[] = [];
	const wakeups = new SessionWakeups({
		deliver: async (message) => {
			delivered.push(message);
			return delivered.length > 1;
		},
		changed: () => {},
		clock,
	});
	wakeups.cron("*/5 * * * *", "看部署", true);
	clock.advance(5 * MINUTE);
	assert.equal(delivered.length, 1);
	await new Promise((resolve) => setImmediate(resolve));
	clock.advance(5 * MINUTE);
	assert.equal(delivered.length, 2, "第一条没进对话，没有哪一轮会替它收尾");
	assert.doesNotMatch(textOf(delivered[1]!), /跳过/);
});

test("全部取消：答取消了几个，计时器也收掉", () => {
	const h = harness();
	h.wakeups.wakeup(600, "a", "b");
	h.wakeups.cron("*/5 * * * *", "c", true);
	assert.equal(h.wakeups.cancelAll(), 2);
	assert.deepEqual(h.lists.at(-1), []);
	assert.equal(h.clock.pending(), 0);
	h.clock.advance(60 * MINUTE);
	assert.equal(h.delivered.length, 0);
	assert.equal(h.wakeups.cancelAll(), 0);
});

test("合盖睡过了几次触发：醒来只送一次，下一次从现在算", () => {
	const h = harness();
	h.wakeups.cron("*/5 * * * *", "看部署", true);
	h.clock.jump(2 * 60 * MINUTE);
	h.clock.advance(0);
	assert.equal(h.delivered.length, 1, "不补发睡过去的那二十多次");
	assert.ok(h.wakeups.list()[0]!.nextAt > h.clock.now());
	assert.ok(h.wakeups.list()[0]!.nextAt - h.clock.now() <= 5 * MINUTE);
});

test("睡过了过期时刻才醒：过期了就不再开一轮", () => {
	const h = harness();
	h.wakeups.cron("*/5 * * * *", "看部署", true);
	h.clock.jump(CRON_MAX_AGE_MS + 10 * MINUTE);
	h.clock.advance(0);
	assert.equal(h.delivered.length, 0);
	assert.deepEqual(h.wakeups.list(), []);
});
