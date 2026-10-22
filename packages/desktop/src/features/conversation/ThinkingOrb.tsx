import { useEffect, useRef } from "react";
import { MODE_FRAMES, paintFrame, resolvePreset } from "thinking-orbs/engine";
import type { OrbState } from "thinking-orbs";

import { motionReduced } from "../../ui/motion/reduced.ts";
import { cancelTick, requestTick } from "../../ui/motion/ticker.ts";

/**
 * 运行行上那颗点阵球，按拍子画（`ticker.ts`），不按帧。
 *
 * 画法全用 `thinking-orbs` 的引擎，这里换掉的只是它自带组件的那个循环：那个循环每一帧都画，
 * 120Hz 屏上一颗 20px 的球每秒重画、重新上传 120 次，正文没在长的时候页面也每帧都脏——会话在跑、
 * 模型还没出字时，GPU 进程 36%、渲染进程 29%，大半是它和侧栏的呼吸点撑着的。它也没有限帧的选项。
 * 现在和放字、跟随滚动同一拍，每秒 30 次。
 *
 * 和原组件的另一处不同：主题直接读 `<html>` 上的 `dark` 类，每拍读一次。原组件为了跟着主题走，在
 * 整个文档上挂了一个 `subtree` 的 MutationObserver，页面上任何一处换 class 它都要回调一次。
 */
export function ThinkingOrb({ state, size, className }: { state: OrbState; size: 20; className?: string }) {
	const canvas = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const element = canvas.current;
		const context = element?.getContext("2d");
		if (!element || !context) return;
		const ratio = Math.min(2, window.devicePixelRatio || 1);
		element.width = Math.round(size * ratio);
		element.height = Math.round(size * ratio);
		const { mode, speed, opts } = resolvePreset(state, size);
		const frameOf = MODE_FRAMES[mode];
		const draw = (seconds: number) => {
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.clearRect(0, 0, size, size);
			paintFrame(context, frameOf(size, seconds, opts), document.documentElement.classList.contains("dark"));
		};
		// 和原组件一样：不动的时候停在 0.6 秒那一帧，那一帧的样子是调过的。
		if (motionReduced()) {
			draw(0.6);
			return;
		}

		let tick = 0;
		const loop = (now: number) => {
			draw((now / 1000) * speed);
			tick = requestTick(loop);
		};
		draw((performance.now() / 1000) * speed);
		// 滚出视口就停：一段长回复把运行行顶到屏幕外以后，没人看得见它。
		const observer = new IntersectionObserver(([entry]) => {
			cancelTick(tick);
			tick = entry?.isIntersecting ? requestTick(loop) : 0;
		});
		observer.observe(element);
		return () => {
			observer.disconnect();
			cancelTick(tick);
		};
	}, [state, size]);

	return <canvas ref={canvas} aria-hidden className={className} style={{ width: size, height: size, display: "block" }} />;
}
