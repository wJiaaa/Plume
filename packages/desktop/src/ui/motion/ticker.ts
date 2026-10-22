/**
 * 流式输出期间会动的东西共用的一拍：放字、淡入、数字爬升、思考球。用法和
 * `requestAnimationFrame` 一样，只是回调不在每一帧来，而是约 30 次每秒（窗口没焦点时 10 次）、
 * 并且同一拍里的全部一起来。
 *
 * 为什么要一拍：120Hz 屏上，这几样东西各开一个 rAF，只要其中一个这一帧改了页面，整条样式、布局、
 * 绘制、合成就得为这一帧跑一遍。正文其实每秒只长三四十次，剩下的帧全是这几个循环各自撑起来的。
 * 量过：主会话加三个侧边聊天同时输出，渲染进程 105–114%、GPU 53%；把 rAF 合到 30Hz 并停掉
 * CSS 动画后 44% / 17%。只做其中一样只降两成——另一样还在每帧弄脏页面。见
 * `docs/architecture/smoothness-checklist.md` 第 14 条。
 *
 * 同一拍一起跑也是要点：几个面板各自放字、各自淡入，挤进同一个 rAF 回调里，React 把它们的
 * setState 合成一次提交，页面也只脏这一帧。
 *
 * 用户直接操作的动画（拖动、点「回到底部」的那一下滑行）不走这里，它们要跟手。贴底跟随的弹簧也不走：
 * 试过按拍走，视口每四帧才挪一次，`stream-follow-probe` 量到相邻帧速度差 p95 从 1px 涨到 10.5px，
 * 就是 `useFollowBottom` 专门修掉过的那种「一顿一顿」。正文按拍长、视口逐帧追，台阶由弹簧抹平。
 * 折中成最多 60Hz 也试过：每秒只省下约 28ms 主线程（滚动位置更新加悬停命中测试），速度差 p95 照样
 * 涨到 8.5px，不值。
 */

/** 一拍多长。 */
export const TICK_MS = 1000 / 30;

/**
 * 窗口没有焦点时一拍多长。窗口被整个挡住时浏览器自己会停帧，但并排摆着、人在另一个窗口里打字时
 * 它照常全速画；这时字照样往外放，只是没人盯着看每一笔。
 */
const BLURRED_TICK_MS = 1000 / 10;

/**
 * 帧时间戳有抖动：120Hz 下第四帧可能只隔 33.2ms。差这一点就要多等一帧的话，30Hz 会掉成 24Hz。
 * 留的余量要小于半帧（120Hz 下 4.2ms），不然会提前一帧，变成 40Hz。
 */
const SLACK = 3;

/**
 * 拍与拍之间睡在计时器上，提前这么久醒来去等 vsync。挂着的 rAF 会让合成器每一帧都来要一次主线程帧，
 * 所以不能一直挂着等；醒得太早要多等几帧，太晚会错过这一拍。半个 120Hz 帧：120Hz 下落在到点前
 * 最后两个 vsync 之间，60Hz 下也在最后一个之前。
 */
const EARLY = 4;

const due = new Map<number, (now: number) => void>();
let seq = 0;
let frame = 0;
let timer = 0;
let last = Number.NEGATIVE_INFINITY;
// store 经 `coalesce.ts` 引到这里，Node 里跑的单元测试也会 import 它，那里没有 DOM。
const dom = typeof document !== "undefined";
let focused = dom ? document.hasFocus() : true;

/** 窗口有没有焦点。没焦点时拍子放慢，`ticked.ts` 里的装饰动画干脆停住。 */
export function windowFocused(): boolean {
	return focused;
}

if (dom) {
	window.addEventListener("blur", () => {
		focused = false;
	});
	window.addEventListener("focus", () => {
		focused = true;
		// 失焦时约下的那一拍可能还要等近 100ms：回到窗口的第一眼就该是正常节奏。
		if (!timer) return;
		window.clearTimeout(timer);
		timer = 0;
		schedule();
	});
}

const interval = () => (focused ? TICK_MS : BLURRED_TICK_MS);

function pump(now: number): void {
	frame = 0;
	if (now - last < interval() - SLACK) {
		frame = requestAnimationFrame(pump);
		return;
	}
	last = now;
	const run = [...due.values()];
	due.clear();
	for (const callback of run) callback(now);
	if (due.size) schedule();
}

function schedule(): void {
	if (frame || timer) return;
	const wait = last + interval() - SLACK - EARLY - performance.now();
	if (wait <= 0) {
		frame = requestAnimationFrame(pump);
		return;
	}
	timer = window.setTimeout(() => {
		timer = 0;
		frame = requestAnimationFrame(pump);
	}, wait);
}

/** 下一拍调用 `callback`，参数和 rAF 一样是帧时间戳。隔了一阵没人要拍时，第一拍就在下一帧。 */
export function requestTick(callback: (now: number) => void): number {
	const id = ++seq;
	due.set(id, callback);
	schedule();
	return id;
}

export function cancelTick(id: number): void {
	due.delete(id);
	if (due.size) return;
	cancelAnimationFrame(frame);
	window.clearTimeout(timer);
	frame = 0;
	timer = 0;
}
