/**
 * 截图工具条画在哪，以及被拖到哪。
 *
 * 从 `ScreenshotOverlay.tsx` 拆出来的。那个组件有 17 个 `useState`，这五个（两个 state、两个
 * ref、一个派生位置）只服务一件事，彼此之间的来往比它们和别处的来往多得多——所以它们是一组，而
 * 剩下那个组件里再也看不到「工具条现在多宽」这种东西。
 *
 * 对外只有五样：画在哪、正在拖吗、怎么量、怎么开始拖、怎么归位。工具条自己的尺寸、手动位置、
 * 那个 `ResizeObserver`，调用方一个都不需要知道。
 */

import { clampToolbar, toolbarPosition, type Point, type Rect } from "./screenshot-geometry.ts";
import { useBarDrag } from "./useBarDrag.ts";

/**
 * A first guess at the bar's size, replaced by a measurement after the first paint.
 *
 * Only used to place it before it exists. It is deliberately close to the truth — the bar is now
 * 48pt tall and about 800 wide with the two extra actions on it — because being wrong here puts the
 * bar in the wrong place for one frame, and the eye is already following the pointer that just
 * released the selection.
 */
const TOOLBAR_SIZE = { width: 800, height: 48 };

/**
 * How tall the size-and-colour bubble is, including the gap above it.
 *
 * A constant rather than a measurement: it is only needed to decide which side of the region the
 * toolbar goes on, that decision has to be made before the bubble exists, and the bubble is one
 * row of controls in a padded box — a number that changes only if that row is redesigned.
 *
 * 48 rather than the 34 it was: the bar uses 36pt metrics (see `AnnotateToolbar`), whose bubble is a row of
 * 28pt controls with 6pt of padding, plus the 8pt gap that separates it from the bar.
 */
const PROPERTIES_HEIGHT = 48;

/** 工具条最终落在哪，以及气泡该往哪一边开。只有下面那个接口用，所以不导出。 */
type ToolbarAt = (Point & { side: "above" | "below" | "over" }) | null;

export interface ToolbarPlacement {
	/** 画在哪。`null` 表示还没有选区，也就没有工具条。 */
	at: ToolbarAt;
	/** 正在被拖动——调用方拿它改光标。 */
	dragging: boolean;
	/** 挂在工具条那个元素上的 ref 回调。 */
	measure: (el: HTMLDivElement | null) => void;
	/** 按住把手时调用，带上按下的点和当时工具条的位置。 */
	startDrag: (grab: { from: Point; origin: Point }) => void;
	/** 新一轮截图开始时调用：忘掉用户上一轮把它拖到了哪。 */
	reset: () => void;
}

/**
 * `bounds` 可以是 null。
 *
 * 组件在拿到第一帧数据之前就早返回了，而 hook 必须在那之前调用——所以这里收一个可能还不存在的
 * 屏幕尺寸。它为 null 时 `selection` 必然也是 null（没有截图就没有选区），下面那两处算位置的
 * 地方都走不到。
 */
export function useToolbarPlacement(
	selection: Rect | null,
	bounds: { width: number; height: number } | null,
): ToolbarPlacement {
	/**
	 * Where the user has put the toolbar, if they have moved it.
	 *
	 * Null means "wherever `toolbarPosition` says", which is the ordinary case and the good default:
	 * the bar follows the region and ends up under the hand that drew it. This exists for when that
	 * default is wrong — the bar lands on top of the very thing being annotated, which happens for a
	 * region near the bottom of the screen, or over the part of the picture a caption is going on.
	 *
	 * In overlay coordinates, i.e. the same space as the selection.
	 */
	const { size, manual: manualAt, dragging, measure, startDrag, reset } = useBarDrag((at, measured) =>
		// Kept on screen, with room above it for the properties bubble. See `clampToolbar`.
		clampToolbar(at, measured ?? TOOLBAR_SIZE, { width: window.innerWidth, height: window.innerHeight }, PROPERTIES_HEIGHT),
	);

	/*
	 * The bubble counts towards the placement, whether or not one is open right now.
	 *
	 * Measuring only the open one would make the bar jump the moment a tool with properties was
	 * chosen — the placement would change under the pointer that just chose it. Reserving the room
	 * unconditionally costs a few pixels of gap in the rare case nothing opens, and keeps the bar
	 * still.
	 */
	const placed =
		selection && bounds
			? toolbarPosition(selection, bounds, (size ?? TOOLBAR_SIZE), { height: PROPERTIES_HEIGHT })
			: null;

	/*
	 * Where the user put it, if they moved it; otherwise where it belongs.
	 *
	 * The automatic placement is right nearly always — the bar follows the region and lands under the
	 * hand that drew it — and wrong in the case it cannot see: the bar is over the part of the
	 * picture that is about to be annotated, or over a second window the user is comparing against.
	 * There is no rule that fixes that, because the thing it must not cover is not on the screen the
	 * overlay can measure. So it is draggable, and a bar that has been dragged stops following.
	 *
	 * The side is still derived rather than kept, because the bubble must open away from the edge it
	 * is nearest: dragged to the top of the screen, a bubble opening upwards would be off it.
	 *
	 * A bar that was moved by hand is still not allowed off the screen. `clampToolbar` used to run
	 * only while the pointer was down, which kept the drag itself honest and then stopped caring.
	 * The bar changes width after the drag — 「删除选中」 appears the moment a shape is selected —
	 * and the position it was left at was reapplied unchanged, so the extra width went straight off
	 * the right edge. Clamped here instead, against the size measured now, so it holds for every
	 * later change and not just for the gesture that placed it.
	 */
	const manual =
		manualAt && bounds ? clampToolbar(manualAt, (size ?? TOOLBAR_SIZE), bounds, PROPERTIES_HEIGHT) : null;
	const at: ToolbarAt = manual ? { ...manual, side: manual.y >= PROPERTIES_HEIGHT ? "above" : "below" } : placed;

	return { at, dragging, measure, startDrag, reset };
}
