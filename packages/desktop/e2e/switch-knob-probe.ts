/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * 设置页的开关点下去，圆点是滑过去的还是跳过去的。
 *
 * 写着 transition 不等于屏幕上在动（元素被重建、属性没对上都会变成硬切），读源码判断不了。按**绘制帧**
 * 取，不按时间采样：rAF 里逐帧读 computed 值，滑过去会经过一串中间位置，跳过去只有两头两个。
 *
 * 原先和用量趋势图的补间放在同一个探针里（chart-switch-probe），那张图随用量页改版删了，这一半留下。
 *
 * 跑：node --experimental-strip-types e2e/switch-knob-probe.ts
 */

import { startApp } from "./app.ts";
import { clickAt, frames, openSettings } from "./drive.ts";

const PORT = 9483;
const KNOB = `document.querySelector('[data-view] button[role="switch"] span')`;

const app = await startApp({ port: PORT });
let ok = false;
try {
	await openSettings(app, "常规");
	const toggle = await app.evaluate<{ x: number; y: number } | null>(`(() => {
		const el = document.querySelector('[data-view] button[role="switch"]');
		if (!el) return null;
		el.scrollIntoView({ block: "center" });
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`);
	if (!toggle) throw new Error("这一页没有开关");
	await frames(app, 10);
	console.log(`按之前：${await app.evaluate<string>(`(() => { const k = ${KNOB}; return k ? getComputedStyle(k).left + " | " + getComputedStyle(k).transitionProperty : "none"; })()`)}`);

	const seen = app.evaluate<string[]>(`(() => new Promise((resolve) => {
		const seen = [];
		let still = 0;
		const started = performance.now();
		const tick = () => {
			const knob = ${KNOB};
			const value = knob ? getComputedStyle(knob).left + " " + getComputedStyle(knob).transform : "";
			if (seen.length && value === seen[seen.length - 1]) still++;
			else { seen.push(value); still = 0; }
			if (still < 12 && performance.now() - started < 1500) requestAnimationFrame(tick);
			else resolve(seen);
		};
		requestAnimationFrame(tick);
	}))()`);
	await new Promise((resolve) => setTimeout(resolve, 30));
	await clickAt(app, toggle);
	const positions = await seen;
	console.log(`圆点经过 ${positions.length} 个位置：${positions.slice(0, 5).join(" → ")}${positions.length > 5 ? " …" : ""}`);
	ok = positions.length > 3;
	console.log(`${ok ? "✔" : "✖"} 圆点是滑过去的（跳过去只有 2 个位置）`);
} catch (error) {
	console.error("探针自己出错了:", error);
} finally {
	await app.stop();
}

if (!ok) process.exitCode = 1;
