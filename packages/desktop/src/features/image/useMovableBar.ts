/**
 * 看图器里那条标注工具栏摆在哪：默认贴着窗口底边居中，按住能拖走，拖到哪记到哪。
 *
 * 截图浮层那条有自己的一套（`useToolbarPlacement`），它跟着选区走；这里没有选区，只有一张居中的图
 * 和一扇窗。共用的是：夹在窗口里的那条规矩（`clampToolbar`），量它多大、拖到哪（`useBarDrag`）。
 *
 * 从前这一条钉死在窗口底边，理由是「没有别处可去」。可它要躲的从来不是窗口，是图：在图的下半部
 * 写字、画框时，工具栏和它上面那排粗细颜色正好压在要标的地方，挪不开就只能放大了绕着画。
 */

import { useEffect, useState } from "react";

import { clampToolbar, type Point } from "./screenshot-geometry.ts";
import { useBarDrag } from "./useBarDrag.ts";

/**
 * Room the bar keeps above itself for the size-and-colour bubble, gap included.
 *
 * The bubble always opens above the bar, so a bar dragged to the top of the window stops this far
 * down rather than pushing its bubble off the top edge: 28pt controls, 6pt of padding each side and a
 * border make 42, the gap 8, and 6 more keeps it off the edge.
 */
const BUBBLE = 56;
/**
 * Where it sits until it is moved: this far above the window's bottom edge, level with the zoom
 * control. 12 rather than the 24 it was: the bar and its bubble are 100pt tall now, and those points
 * are what keep the bubble off the bottom of a 16:9 picture in an 860pt window — measured, the bubble
 * met the picture's bottom edge at 16.
 */
const BOTTOM = 12;
/** How far it keeps from the zoom control, the one other thing on that edge. */
const GAP = 12;

type Size = { width: number; height: number };

/**
 * Where the bar was last left, for the next picture opened.
 *
 * For as long as the app runs, not saved: someone who moved it out of the way of one picture wants it
 * out of the way of the next one too, but a position from yesterday's window size is a guess.
 */
let remembered: Point | null = null;

/**
 * Off the obstacle, by whichever way is shorter — up above it, or to its right — as long as that way
 * still fits in the window.
 *
 * The zoom control sits in the bottom-left corner. A bar dropped on it, or a centred bar in a window
 * narrow enough to reach it, put one row of buttons over another: two controls in one place, and
 * whichever was drawn on top took every press meant for the other.
 */
function dodge(at: Point, bar: Size, obstacle: DOMRect, viewport: Size): Point {
	const overlaps =
		at.x < obstacle.right + GAP && at.x + bar.width > obstacle.left - GAP && at.y < obstacle.bottom + GAP && at.y + bar.height > obstacle.top - GAP;
	if (!overlaps) return at;
	const up = { x: at.x, y: obstacle.top - GAP - bar.height };
	const right = { x: obstacle.right + GAP, y: at.y };
	const fitsRight = right.x + bar.width <= viewport.width - GAP;
	const distance = (to: Point) => Math.hypot(to.x - at.x, to.y - at.y);
	return fitsRight && distance(right) < distance(up) ? right : up;
}

export interface MovableBar {
	/** Where to draw it, in window coordinates, or null until it has been measured. */
	at: Point | null;
	/** The holder's position as a style: centred by CSS until measured, then placed in pixels. */
	style: React.CSSProperties;
	/** Being dragged right now: no easing on the position, and the cursor says so. */
	dragging: boolean;
	/** The ref callback for the element that holds the bar. */
	measure: (el: HTMLDivElement | null) => void;
	/** What `AnnotateToolbar` calls when a press turns into a drag. */
	startDrag: (grab: { from: Point; origin: Point }) => void;
}

export function useMovableBar(avoid: React.RefObject<HTMLElement | null>): MovableBar {
	const [viewport, setViewport] = useState<Size>(() => ({ width: window.innerWidth, height: window.innerHeight }));
	const { size, manual, dragging, measure, startDrag } = useBarDrag(
		(at, measured) => (measured ? clampToolbar(at, measured, viewport, BUBBLE) : at),
		remembered,
	);

	// A window made smaller must not leave the bar outside it.
	useEffect(() => {
		const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);

	useEffect(() => {
		if (!dragging && manual) remembered = manual;
	}, [dragging, manual]);

	/*
	 * Eased only once it has been placed in pixels at least once. The first placement replaces a CSS
	 * centring with the same position in pixels; eased, `left` slid from 50% while the transform that
	 * went with it was dropped at once, and the bar swept in from the middle of the window.
	 */
	const [settled, setSettled] = useState(false);
	useEffect(() => {
		if (!size || settled) return;
		const id = requestAnimationFrame(() => setSettled(true));
		return () => cancelAnimationFrame(id);
	}, [size, settled]);

	/*
	 * Until it has been measured, centred by CSS on the same line it will be placed on. It used to wait
	 * hidden at the window's corner, and opening the viewer straight into 编辑 measured it a frame
	 * late: the bubble above it was laid out at the left edge and then jumped 355 points to the middle.
	 */
	if (!size) return { at: null, style: { left: "50%", bottom: BOTTOM, transform: "translateX(-50%)" }, dragging, measure, startDrag };
	// Centred by the narrowest it has been, so a button joining the row grows it to the right. See `BarSize`.
	const wanted = manual ?? { x: (viewport.width - size.narrowest) / 2, y: viewport.height - BOTTOM - size.height };
	const kept = clampToolbar(wanted, size, viewport, BUBBLE);
	/*
	 * Kept off the zoom control once it is let go, not while it is being carried: jumping round the
	 * obstacle under the hand would fight the drag. Let go on top of it, it slides clear.
	 */
	const obstacle = dragging ? null : avoid.current?.getBoundingClientRect();
	const at = obstacle ? dodge(kept, size, obstacle, viewport) : kept;
	const ease = "left var(--ly-t-base) var(--ly-e-out), top var(--ly-t-base) var(--ly-e-out)";
	return { at, style: { left: at.x, top: at.y, transition: dragging || !settled ? "none" : ease }, dragging, measure, startDrag };
}
