/**
 * 平铺树的几何：停靠面板（`features/dock`）和对话分屏（`features/split`）共用的那一半。
 *
 * 两棵树叶子不同——一个是面板种类，一个是会话——但分支长得一样：方向、每个孩子的份额、孩子。
 * 分隔条在哪、拖到某个像素时近侧该占多少，只看分支，所以只写一份。叶子怎么排（`layoutPanes`）
 * 各自留在自己的域里，那部分才真的不同。
 */

export type Axis = "row" | "col";

/**
 * A rectangle in fractions of the container, 0 to 1 on both axes.
 *
 * Fractions rather than pixels so this stays pure: it needs no element, no measurement and no
 * layout pass, and it produces the same answer before the first paint as after it. The percentages
 * go straight onto the elements, so a window resize is handled by the browser rather than by a
 * recalculation here.
 */
export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** 两棵树共有的形状：只要分支，叶子长什么样这里不关心。 */
type Tiling = { type: "leaf" } | { type: "split"; dir: Axis; sizes: readonly number[]; children: readonly Tiling[] };

/**
 * One draggable boundary between two panes.
 *
 * Identified by the split it belongs to and the child on its near side, which is exactly what
 * `resize` in each tree takes — so a handle can act without anything in between having to work
 * out what it is a handle *for*.
 */
export interface SplitterBox extends Box {
	path: number[];
	index: number;
	dir: Axis;
	/** The near pane's current share, so a drag can start from where the handle actually is. */
	share: number;
	/** The two panes' shares combined, which is the range a drag on this handle may cover. */
	pair: number;
	/**
	 * The box of the split this handle divides.
	 *
	 * Carried here rather than looked up later because it is the frame of reference a drag on this
	 * handle is measured in — and it is already known at the moment the handle is produced.
	 */
	split: Box;
}

export const FULL: Box = { left: 0, top: 0, width: 1, height: 1 };

/**
 * The splitter's grab area, straddling the boundary between two panes.
 *
 * Same 9px as `ResizeHandle` uses on the sidebar, for the same reason: it is the smallest strip
 * that can be hit reliably without being a visible border.
 */
export const SPLITTER_HIT = 9;

/** Keyboard resizing, per press, as a share. Shift multiplies it. */
export const SPLITTER_STEP = 0.02;

/** How long the splitter's grip is: enough to read as a handle, short enough not to read as a border. */
export const GRIP_SPAN = 30;

/**
 * Fractions to CSS.
 *
 * Rounded, and deliberately not to a whole percent. The boxes are computed as exact fractions that
 * tile perfectly; writing them into CSS at low precision reopens the gap between two panes that the
 * arithmetic had just closed, and a sub-pixel seam of window background is visible against a pane.
 * Six decimals is well past what any display can resolve and short enough that the strings stay
 * stable between frames — which matters, because a style string that changes on every frame
 * invalidates the transition it is meant to be animating.
 */
export const pct = (fraction: number): string => `${(fraction * 100).toFixed(6)}%`;

/** Carve a child's box out of its parent's, given where along the axis it starts and how much it takes. */
export function slice(rect: Box, dir: Axis, offset: number, share: number): Box {
	return dir === "row"
		? { left: rect.left + offset * rect.width, top: rect.top, width: share * rect.width, height: rect.height }
		: { left: rect.left, top: rect.top + offset * rect.height, width: rect.width, height: share * rect.height };
}

/**
 * Every boundary that can be dragged.
 *
 * A split of n children has n−1 of them — the outer edges of a split are the edges of whatever
 * contains it, and are not boundaries between two panes.
 *
 * Each is drawn as a zero-thickness line; the grab area is added by the component, which is the
 * only place that knows how many pixels nine of them are.
 */
export function layoutSplitters(tree: Tiling, within: Box = FULL): SplitterBox[] {
	const out: SplitterBox[] = [];
	const walk = (node: Tiling, rect: Box, path: number[]) => {
		if (node.type === "leaf") return;
		let offset = 0;
		node.children.forEach((child, i) => {
			const share = node.sizes[i] ?? 0;
			walk(child, slice(rect, node.dir, offset, share), [...path, i]);
			offset += share;
			// The boundary after this child, unless this was the last one.
			if (i < node.children.length - 1) {
				const next = node.sizes[i + 1] ?? 0;
				out.push({
					path,
					index: i,
					dir: node.dir,
					share,
					pair: share + next,
					split: rect,
					...(node.dir === "row"
						? { left: rect.left + offset * rect.width, top: rect.top, width: 0, height: rect.height }
						: { left: rect.left, top: rect.top + offset * rect.height, width: rect.width, height: 0 }),
				});
			}
		});
	};
	walk(tree, within, []);
	return out;
}

/**
 * Turn a pointer position into the share the handle's near pane should take.
 *
 * The split's own box is the frame of reference, not the container's. A handle inside a nested
 * split moves within *that* split's length, and measuring against the whole window would make it
 * travel at the wrong rate — sluggish inside a narrow column, and running off both ends of a wide one.
 *
 * `position` is a client coordinate on the drag axis: `clientX` for a row, `clientY` for a column.
 */
export function shareFromPointer(handle: SplitterBox, position: number, container: Box): number {
	const { split } = handle;
	const row = handle.dir === "row";
	const span = row ? split.width * container.width : split.height * container.height;
	if (!(span > 0)) return handle.share;

	// Where the split starts, and where the pointer is, both as a share of the split's length.
	const origin = row ? container.left + split.left * container.width : container.top + split.top * container.height;
	const at = (position - origin) / span;
	// How much of the split lies before the near pane — everything on this side of the handle
	// except the pane the handle is *for*.
	const boundary = row ? (handle.left - split.left) / split.width : (handle.top - split.top) / split.height;
	return at - (boundary - handle.share);
}
