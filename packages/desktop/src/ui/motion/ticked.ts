import { type RefObject, useEffect } from "react";
import { motionReduced } from "./reduced.ts";
import { cancelTick, requestTick, windowFocused } from "./ticker.ts";

/** 运行行上扫过摘要的那道光，见 `glide.css`。 */
export const GLIDE: ReadonlySet<string> = new Set(["ly-glide"]);

/**
 * 没有终点的装饰动画（侧栏的呼吸点、运行行上的扫光）改成按拍走：关键帧和曲线还在 CSS 里，只是
 * 不再由浏览器每帧推，而是暂停住、每拍把 `currentTime` 往前拨一次（`ticker.ts`）。
 *
 * 为什么不留给浏览器：呼吸点动 `border-color` / `background`、扫光动 `background-position`，都只能
 * 在主线程逐帧重绘；120Hz 屏上只要一个会话在跑，整页就每秒重画 120 次，哪怕正文一个字没动。量过：
 * 模型还没出字时 GPU 进程 34%、渲染进程 25%，单关呼吸点降到 25% / 18%，两样都在才降不下去——
 * 和正文那边是同一回事，见 `ticker.ts`。`steps()` 也救不了：浏览器对不能合成的动画每帧都要服务一次，
 * 不看曲线是不是阶梯。
 *
 * 改成只动透明度和缩放、交给合成器也试过（变色换成叠一层 violet 淡入淡出）：主线程是不管了，可
 * 合成器照样每个 vsync 出一帧，模型挂住时 GPU 进程 22.6%、渲染进程 11.2%，按拍走是 11.9% / 10.4%。
 * 一秒 120 帧再便宜，也比 30 帧贵。
 *
 * 窗口没焦点时停在原处：拍子本来就慢到每秒 10 次，一个没人看着的呼吸点，不值得为它每秒重画十遍。
 *
 * 只认 `names` 里点名的：同一个元素上可能还有要跟手的动画（摘要悬停时的滚动），那些照常逐帧。
 */
export function useTickedAnimations(ref: RefObject<HTMLElement | null>, names: ReadonlySet<string>, active = true): void {
	useEffect(() => {
		if (!active || motionReduced()) return;
		const entry: Entry = { ref, names, clocks: new Map() };
		entries.add(entry);
		if (!tick) tick = requestTick(loop);
		return () => {
			entries.delete(entry);
			if (!entries.size) {
				cancelTick(tick);
				tick = 0;
				previous = 0;
			}
			// 元素还在、只是不该再按拍走了（比如不再运行）：交还给浏览器，不留一个停住的动画。
			for (const animation of entry.clocks.keys()) if (animation.playState === "paused") animation.play();
		};
	}, [ref, names, active]);
}

/** 一个挂着的元素，和它名下每个动画自己走到了哪。按拍子的时间差往前拨，各自的相位不变。 */
interface Entry {
	ref: RefObject<HTMLElement | null>;
	names: ReadonlySet<string>;
	clocks: Map<Animation, number>;
}

/*
 * 所有元素共用一条循环，先全部读完再一起写。`getAnimations` 要先把样式算到最新，拨 `currentTime` 又把
 * 样式弄脏：各走各的循环时，侧栏 N 个会话在跑就是每拍被逼着重算 N−1 次样式——`measure-batch.ts`
 * 在滚动那边修掉的同一种读写交错。
 */
const entries = new Set<Entry>();
let tick = 0;
let previous = 0;

function loop(now: number): void {
	// 窗口没焦点的那几拍不拨，回来时从停下的地方接着走，不会一下跳过去。
	const step = windowFocused() && previous ? now - previous : 0;
	previous = now;
	// 每拍现读：挂扫光的那层可能比「开始运行」晚出现（摘要是流式写进来的）。
	const found = [...entries].map((entry) => [entry, entry.ref.current?.getAnimations({ subtree: true }) ?? []] as const);
	for (const [entry, animations] of found) {
		// 换了一句话，扫光那层跟着重挂，旧的动画就没了：不清的话，一段活跑得越久这里攒得越多。
		for (const animation of entry.clocks.keys()) if (!animations.includes(animation)) entry.clocks.delete(animation);
		for (const animation of animations) {
			// 只认 CSS 动画；按属性认而不是 `instanceof`，测试用的 DOM 里没有 `CSSAnimation` 这个类。
			if (!("animationName" in animation) || !entry.names.has((animation as CSSAnimation).animationName)) continue;
			const time = entry.clocks.get(animation);
			if (time === undefined) {
				entry.clocks.set(animation, Number(animation.currentTime ?? 0));
				animation.pause();
				continue;
			}
			if (!step) continue; // 原地再写一遍也会让它重画
			entry.clocks.set(animation, time + step);
			animation.currentTime = time + step;
		}
	}
	tick = requestTick(loop);
}
