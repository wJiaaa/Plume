/**
 * 一条浮着的标注工具栏，量它多大、按住能拖走。看图器（`useMovableBar`）和截图浮层
 * （`useToolbarPlacement`）各有各的落点规矩，量和拖是同一套，从前各写一份。
 *
 * 「按住才拖、空隙处按下就拖」的手势在 `AnnotateToolbar` 里，这里只接它的 `onGrab`。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { Point } from "./screenshot-geometry.ts";

export interface BarSize {
	width: number;
	height: number;
	/**
	 * 它最窄时有多宽。选中一个形状时它会多出一颗按钮；按当前宽度居中的话，每选中、取消一次整排就往旁边
	 * 滑 20pt——画完一个框，正要按的下一个工具挪了位置。按最窄的居中，它只往右长。
	 */
	narrowest: number;
}

/**
 * `clamp`：拖到的位置怎么夹回屏幕里，按此刻量到的尺寸（还没量到时是 null）。每一帧都读最新的那个，
 * 窗口大小变了也作数。
 */
export function useBarDrag(clamp: (at: Point, size: BarSize | null) => Point, initial: Point | null = null) {
	const [size, setSize] = useState<BarSize | null>(null);
	/** 人把它拖到了哪；null 是没动过，落点由调用方的规矩定。 */
	const [manual, setManual] = useState<Point | null>(initial);
	const [dragging, setDragging] = useState(false);
	/** The press that started the current drag, and where the bar was when it did. */
	const drag = useRef<{ from: Point; origin: Point } | null>(null);
	const observer = useRef<ResizeObserver | null>(null);
	const clampTo = useRef(clamp);
	clampTo.current = clamp;

	/*
	 * Watched, not measured once.
	 *
	 * This was a bare ref callback, which runs when the element mounts and never again — so the
	 * width it recorded was the width of the bar *as it first appeared*. The bar does not keep that
	 * width: select a shape and 「删除选中」 joins the row, and a tool with a properties bubble adds
	 * its own controls. Every rule that keeps the bar on screen is computed against this number, so
	 * a stale one disables all of them at once and the real bar hangs off the screen.
	 */
	const measure = useCallback((el: HTMLDivElement | null) => {
		observer.current?.disconnect();
		observer.current = null;
		if (!el) return;
		const read = () => {
			const r = el.getBoundingClientRect();
			if (!r.width || !r.height) return;
			setSize((was) => {
				if (was && Math.abs(was.width - r.width) < 1 && Math.abs(was.height - r.height) < 1) return was;
				const width = Math.ceil(r.width);
				return { width, height: Math.ceil(r.height), narrowest: Math.min(was?.narrowest ?? width, width) };
			});
		};
		read();
		observer.current = new ResizeObserver(read);
		observer.current.observe(el);
	}, []);
	useEffect(() => () => observer.current?.disconnect(), []);

	const startDrag = useCallback((grab: { from: Point; origin: Point }) => {
		drag.current = grab;
		setDragging(true);
	}, []);

	/*
	 * 三样都要清，不是只清位置。
	 *
	 * 只清位置的话，一次截图在工具条被拖着的时候结束（按 Esc，或者别的关闭路径先到），`dragging` 留着
	 * true 进入下一轮：新一轮开场时光标是 grabbing，下面那个 effect 立刻挂上 window 的 pointermove——
	 * 鼠标一动工具条就跟着走，用户根本没按下去。状态分散着清，漏一个没有任何东西会说。
	 */
	const reset = useCallback(() => {
		setManual(null);
		setDragging(false);
		drag.current = null;
	}, []);

	/*
	 * The rest of the drag, on the window rather than on the bar.
	 *
	 * A pointer moving fast leaves the bar behind between two events, and a capture on the element
	 * would have to be released on a page that is about to be torn down and rebuilt for the next
	 * capture. Listening on the window for as long as the drag lasts has neither problem.
	 */
	useEffect(() => {
		if (!dragging) return;
		const move = (event: PointerEvent) => {
			const at = drag.current;
			if (!at) return;
			setManual(clampTo.current({ x: at.origin.x + event.clientX - at.from.x, y: at.origin.y + event.clientY - at.from.y }, size));
		};
		const end = () => {
			drag.current = null;
			setDragging(false);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", end);
		window.addEventListener("pointercancel", end);
		return () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", end);
		};
	}, [dragging, size]);

	return { size, manual, dragging, measure, startDrag, reset };
}
