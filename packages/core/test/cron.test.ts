/**
 * 5 字段 cron 的解析与「下一次」：步长、范围、列表、星期（含名字和 7）、日与星期的「或」、本地时区、
 * 夏令时，以及写错时说得出哪里错。
 */

// 每个测试文件一个进程，这里定下时区不影响别的文件；Node 运行中改 TZ 也会生效，夏令时那条据此切换。
process.env.TZ = "Asia/Shanghai";

import assert from "node:assert/strict";
import { test } from "node:test";
import { nextCronTime, parseCron } from "../src/config/cron.ts";

const sorted = (set: ReadonlySet<number>) => [...set].sort((a, b) => a - b);
/** 本地时间，月份从 1 数。 */
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

test("步长、范围、列表、单值带步长", () => {
	const cron = parseCron("*/15 9-17/4 1,15 * *");
	assert.deepEqual(sorted(cron.minute), [0, 15, 30, 45]);
	assert.deepEqual(sorted(cron.hour), [9, 13, 17]);
	assert.deepEqual(sorted(cron.day), [1, 15]);
	assert.equal(cron.month.size, 12);
	assert.deepEqual(sorted(parseCron("5/20 * * * *").minute), [5, 25, 45]);
	assert.deepEqual(sorted(parseCron("1-3,7,10-12 * * * *").minute), [1, 2, 3, 7, 10, 11, 12]);
});

test("星期：名字、7 是周日、范围；月份名字", () => {
	assert.deepEqual(sorted(parseCron("0 9 * * MON-FRI").weekday), [1, 2, 3, 4, 5]);
	assert.deepEqual(sorted(parseCron("0 9 * * 5-7").weekday), [0, 5, 6]);
	assert.deepEqual(sorted(parseCron("0 9 * * sun").weekday), [0]);
	assert.deepEqual(sorted(parseCron("0 9 * jan,Dec *").month), [1, 12]);
});

test("写错的表达式说清是哪一处", () => {
	assert.throws(() => parseCron("* * * *"), /5 fields.*has 4/);
	assert.throws(() => parseCron("60 * * * *"), /minute/);
	assert.throws(() => parseCron("* 24 * * *"), /hour/);
	assert.throws(() => parseCron("* * 0 * *"), /day of month/);
	assert.throws(() => parseCron("*/0 * * * *"), /at least 1/);
	assert.throws(() => parseCron("10-5 * * * *"), /backwards/);
	assert.throws(() => parseCron("a * * * *"), /not a number/);
	assert.throws(() => parseCron("1,,2 * * * *"), /Empty item/);
	assert.throws(() => parseCron("* * * * 8"), /day of week/);
});

test("下一次：严格在之后、对齐到整分钟、按本地时间", () => {
	const every5 = parseCron("*/5 * * * *");
	assert.equal(nextCronTime(every5, local(2026, 10, 23, 14, 3, 20)), local(2026, 10, 23, 14, 5));
	// 正好在一个匹配上：要的是下一个，不是它自己。
	assert.equal(nextCronTime(every5, local(2026, 10, 23, 14, 5)), local(2026, 10, 23, 14, 10));
	// 14:30 本地时间，跨天。
	const daily = parseCron("30 14 * * *");
	assert.equal(nextCronTime(daily, local(2026, 10, 23, 15, 0)), local(2026, 10, 24, 14, 30));
	assert.equal(new Date(nextCronTime(daily, local(2026, 10, 23, 15, 0))!).getUTCHours(), 6, "上海的 14:30 是 UTC 06:30");
});

test("工作日：周五之后是下周一", () => {
	// 2026-10-23 是周五。
	const weekdays = parseCron("0 9 * * 1-5");
	assert.equal(nextCronTime(weekdays, local(2026, 10, 23, 10, 0)), local(2026, 10, 26, 9, 0));
});

test("日和星期都写了时是「或」，有一个是 * 时是「且」", () => {
	// 每月 1 号或者每周一。2026-10-23 周五之后：10-26（周一）先到。
	assert.equal(nextCronTime(parseCron("0 9 1 * MON"), local(2026, 10, 23, 10)), local(2026, 10, 26, 9));
	// 每月 1 号：11-01。
	assert.equal(nextCronTime(parseCron("0 9 1 * *"), local(2026, 10, 23, 10)), local(2026, 11, 1, 9));
	// 星期写成 `*/1` 也是 `*` 开头，按「且」：只剩日这一条，下一个 13 号。
	assert.equal(nextCronTime(parseCron("0 9 13 * */1"), local(2026, 10, 23, 10)), local(2026, 11, 13, 9));
});

test("到 until 为止还没有就是 null", () => {
	const feb30 = parseCron("0 0 30 2 *");
	assert.equal(nextCronTime(feb30, local(2026, 1, 1)), null);
	const later = parseCron("0 9 1 1 *");
	assert.equal(nextCronTime(later, local(2026, 10, 23), local(2026, 10, 26)), null);
});

test("夏令时：拨快那天跳过不存在的 2:30，回拨那天不倒退", () => {
	const before = process.env.TZ;
	process.env.TZ = "America/New_York";
	try {
		// 2026-03-08 02:00 拨到 03:00：当天没有 02:30，下一个是 03-09 02:30。
		const at230 = parseCron("30 2 * * *");
		const next = nextCronTime(at230, local(2026, 3, 8, 1, 0))!;
		assert.equal(new Date(next).getDate(), 9);
		// 2026-11-01 01:00-02:00 走两遍：每 30 分钟的任务一直往前，不会回到已经过去的时刻。
		const every30 = parseCron("*/30 * * * *");
		let at = local(2026, 11, 1, 0, 45);
		for (let i = 0; i < 6; i++) {
			const step = nextCronTime(every30, at)!;
			assert.ok(step > at, "单调往前");
			assert.equal(step - at <= 30 * 60_000, true, "回拨那一小时也不多等");
			at = step;
		}
	} finally {
		process.env.TZ = before;
	}
});
