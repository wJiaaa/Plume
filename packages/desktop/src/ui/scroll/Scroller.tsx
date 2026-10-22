import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { scrollFade } from "./fade.ts";
import { cancelMeasure, type Measure, queueMeasure } from "./measure-batch.ts";
import type { Direction } from "./follow.ts";

/**
 * The app's only scrolling surface.
 *
 * Three things the native scroller does not do, and which the reference has everywhere:
 *
 *   - a scrollbar that overlays the content instead of reserving a gutter, so nothing
 *     reflows sideways the moment a list grows past its box;
 *   - an edge that says more is hidden that way, drawn as whatever the boundary actually is:
 *     a fade where content dissolves into empty space, a hairline where it slides under
 *     something solid. See `top` — picking the wrong one is what makes a list look broken.
 *
 * `overscroll-contain` keeps a wheel that reaches the end here rather than passing it to the
 * window behind — a nested list would otherwise scroll its parent as soon as it bottomed out.
 *
 * For surfaces embedded inside an outer scroller (e.g. tool cards, error logs, or code outputs
 * in a transcript), `overscroll="auto"` allows natural scroll chaining once the inner content
 * is scrolled to the boundary.
 */
export function Scroller({
	children,
	className = "",
	contentClassName = "",
	top = "fade",
	fadeTop,
	bottom = "fade",
	overscroll = "contain",
	onScroll,
	onResize,
	onUserScroll,
	onHold,
	scrollRef,
}: {
	children: React.ReactNode;
	className?: string;
	contentClassName?: string;
	/**
	 * 滚到自己的边界之后，滚轮还传不传给外面。
	 *
	 * 判断标准是这一块**是页面里的一段内容，还是一块独立的面**。一段内容——设置页里的发版说明、一列
	 * 搜索结果——读到底了还想接着往下看页面，是很自然的一件事，那就该给 `"auto"`。一块
	 * 独立的面——弹窗、浮层、菜单、转录本身——滚到底就该停住，不然一个嵌套列表刚到底就把它背后的整页
	 * 带跑了，那是默认的 `"contain"` 要挡的事。
	 *
	 * 「滚不动的面要不要拦」不用在这里操心：它一律放行，见下面 `chain` 那段。
	 */
	overscroll?: "contain" | "auto";
	/**
	 * How the top edge ends.
	 *
	 * `"fade"` softens the last rows away, which says "there is more this way" without drawing
	 * anything. It works whatever is above — empty pane or opaque nav — because it takes the
	 * content's own alpha down rather than painting over it; see `.ly-fade-y` in styles.css for
	 * why that distinction is the whole story.
	 *
	 * It only appears once something has actually gone under, so a short list has no edge
	 * treatment at all: a boundary is worth drawing when it is doing something.
	 */
	top?: "fade" | "none";
	/** How deep the top fade reaches, in px, when the default does not suit this list. */
	fadeTop?: number;
	/** Same question at the bottom. */
	bottom?: "fade" | "none";
	onScroll?: (element: HTMLDivElement) => void;
	/** Called whenever content or viewport dimensions change. */
	onResize?: (element: HTMLDivElement) => void;
	/**
	 * A drag of the thumb below, reported as the gesture it is.
	 *
	 * The thumb is a sibling of the viewport and moves it by assigning `scrollTop`, so the drag
	 * reaches a follower as a scroll event indistinguishable from the browser clamping a shrinking
	 * transcript — and a follower that may not detach on an anonymous position change (see
	 * `follow.ts`) would never notice the reader pulling away. This is that gesture said out loud by
	 * the one component in a position to know.
	 */
	onUserScroll?: (direction: Direction) => void;
	/**
	 * 读者刚把手指按在了什么上面。
	 *
	 * 给跟随底部的那一方一个机会，把接下来这一次长高认成「读者点开了手里这一块」而不是「新消息
	 * 到了」——两者在 `onResize` 里长得一模一样，而处理方式正好相反。
	 */
	onHold?: (target: EventTarget | null) => void;
	/** Exposed for callers that drive the scroll position themselves, like the transcript. */
	scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
	const own = useRef<HTMLDivElement>(null);
	const viewport = scrollRef ?? own;
	const drag = useRef<{ startY: number; startTop: number } | null>(null);
	/*
	 * Activity preserves the DOM, but Chromium resets native scroll offsets while hidden: restore the
	 * last position `read` saw, before paint. Not read at hide time — that runs in the middle of React
	 * removing the old page, and each scroller asking for `scrollTop` there forced a whole-page layout.
	 */
	const seenTop = useRef<number | null>(null);

	useLayoutEffect(() => {
		const el = viewport.current;
		if (el && seenTop.current !== null) el.scrollTop = seenTop.current;
	}, [viewport]);

	const [metrics, setMetrics] = useState({ height: 0, overflow: false, atTop: true, atBottom: true });
	const [active, setActive] = useState(false);
	/*
	 * 滑块的位置和长度不进 state，直接写到它身上。
	 *
	 * 贴底跟随每帧都在挪 `scrollTop`，滑块跟着动半个像素就是一次 React 重画、一次样式写入。几个面板
	 * 同时在输出时，一个面板的 scroll 回调刚写完，下一个面板的 scroll 回调读 `scrollHeight`，就为它把
	 * 整页的样式和布局强制算一遍——量过，这里一处占了渲染进程 12%。只有边缘渐隐和要不要画滑块这几样
	 * 真的改变渲染，留在 state 里。
	 *
	 * 写也不能弄脏布局：这一写就夹在各个面板的 scroll 回调之间，写 `top` 会让紧接着读 `scrollTop`
	 * 的下一个面板再排一遍版，量到强制布局翻了一倍多（401 → 980 次 / 3s）。位置走 `transform`，只动绘制；长度取整，
	 * 内容每长一截它只变零点几像素，取整后多半不用写。
	 */
	const thumb = useRef<HTMLDivElement>(null);
	const geometry = useRef({ top: 0, height: 0 });
	const paintThumb = useCallback(() => {
		const element = thumb.current;
		if (!element) return;
		const top = `translateY(${Math.round(geometry.current.top * 2) / 2}px)`;
		const height = `${Math.round(geometry.current.height)}px`;
		if (element.style.transform !== top) element.style.transform = top;
		if (element.style.height !== height) element.style.height = height;
	}, []);

	/** 只读，交回写的那一半——好让 `queueMeasure` 把几个面板的读全排在写前面。 */
	const read = useCallback<Measure>(() => {
		const el = viewport.current;
		if (!el) return () => {};
		const { scrollTop, scrollHeight, clientHeight } = el;
		if (clientHeight > 0) seenTop.current = scrollTop;
		const overflow = scrollHeight - clientHeight > 1;
		// A thumb shorter than this is impossible to grab; it stops tracking exactly once the
		// content is very long, which is a fair trade for staying usable.
		const thumbHeight = overflow ? Math.max(28, (clientHeight / scrollHeight) * clientHeight) : 0;
		const travel = clientHeight - thumbHeight;
		const progress = scrollHeight - clientHeight <= 0 ? 0 : scrollTop / (scrollHeight - clientHeight);
		const newThumbTop = travel * progress;
		const newAtTop = scrollTop <= 1;
		const newAtBottom = scrollTop >= scrollHeight - clientHeight - 1;

		return () => {
			geometry.current = { top: newThumbTop, height: thumbHeight };
			paintThumb();
			setMetrics((prev) => {
				if (prev.height === clientHeight && prev.overflow === overflow && prev.atTop === newAtTop && prev.atBottom === newAtBottom) return prev;
				return { height: clientHeight, overflow, atTop: newAtTop, atBottom: newAtBottom };
			});
		};
	}, [viewport, paintThumb]);
	const measure = useCallback(() => read()(), [read]);

	// 滑块是 `overflow` 变真时才挂上的，那一刻它身上还没有位置。
	useLayoutEffect(paintThumb, [metrics.overflow, paintThumb]);

	useLayoutEffect(() => {
		const el = viewport.current;
		if (!el) return;
		onResize?.(el);
		measure();

		const scheduleMeasure = () => queueMeasure(read);

		/*
		 * The content is watched, not just the box — they are different measurements.
		 *
		 * `observe(el)` alone reports the *viewport's* size, and the viewport is a flex item: its
		 * height is decided by the layout above it and does not move when what is inside grows or
		 * shrinks. So collapsing a tool group — which animates an inner height to zero without
		 * touching a single node — changed `scrollHeight` by hundreds of pixels and fired nothing.
		 * Measured: shrinking a child from 900px to 200px produced zero callbacks.
		 *
		 * Watching the direct children fixes it, because height propagates outward through ordinary
		 * block flow: a group three levels down collapses, its ancestors shorten, and the child of
		 * the viewport shortens with them.
		 *
		 * The mutation observer stays, and now has a second job: children come and go as messages
		 * arrive, and a new one has to be picked up by the size observer too.
		 */
		/*
		 * 位置在这里就地改完，其余的照旧推到下一帧。
		 *
		 * 这个回调跑在布局之后、绘制之前——是这一帧最后一次还来得及改 `scrollTop` 的机会。测量和
		 * 那些跟着重画的状态留在 rAF 里（它们不急，而且同步做会把布局搅乱）；位置不能等，展开动画
		 * 每一帧都长高一点，晚一帧就是一串看得见的小抖。
		 *
		 * 上面这段话一直是对的，可从前只有锚点照着做了，贴底跟随（`onResize`）却被一起
		 * 推进了 rAF——于是内容长高的那一帧先按没补偿的位置画了出来，下一帧才拉回去。录屏里逮到过
		 * 一次：运行行上「本轮 N tokens」冒出来的同一帧，整块转录往下掉 38px，再一帧弹回原位。一
		 * 帧 16 毫秒，看着就是「闪了一下」。
		 */
		const observer = new ResizeObserver(() => {
			const el = viewport.current;
			if (el) onResize?.(el);
			scheduleMeasure();
		});
		const watch = () => {
			observer.disconnect();
			observer.observe(el);
			for (const child of el.children) observer.observe(child);
		};
		watch();

		const mutations = new MutationObserver(() => {
			watch();
			scheduleMeasure();
		});
		mutations.observe(el, { childList: true, subtree: false });

		return () => {
			cancelMeasure(read);
			observer.disconnect();
			mutations.disconnect();
		};
	}, [measure, read, onResize, viewport]);

	// Dragging continues outside the thumb, so the listeners live on the window.
	useEffect(() => {
		if (!active) return;
		let frame = 0;
		let latestEvent: MouseEvent | null = null;

		const updateScroll = () => {
			frame = 0;
			const event = latestEvent;
			if (!event) return;
			const el = viewport.current;
			const state = drag.current;
			if (!el || !state) return;
			const travel = el.clientHeight - geometry.current.height;
			if (travel <= 0) return;
			const ratio = (event.clientY - state.startY) / travel;
			/*
			 * Name the gesture *before* assigning `scrollTop`.
			 *
			 * The assignment fires `scroll` synchronously. If that event reaches `arrived` while
			 * the surface is still following, the next follow write fights the drag for a frame —
			 * the thumb that would not leave the bottom. Intending first detaches; then the write
			 * is just a position.
			 *
			 * Direction is taken from the clamped target, not the raw ratio. A drag that has run
			 * out of travel produces no movement, and reporting one would let a thumb held against
			 * the end stop a following transcript.
			 */
			const travelMax = el.scrollHeight - el.clientHeight;
			const next = Math.max(0, Math.min(travelMax, state.startTop + ratio * travelMax));
			const before = el.scrollTop;
			if (next < before) onUserScroll?.("up");
			else if (next > before) onUserScroll?.("down");
			el.scrollTop = next;
		};

		const onMove = (event: MouseEvent) => {
			latestEvent = event;
			if (!frame) {
				frame = requestAnimationFrame(updateScroll);
			}
		};
		const onUp = () => {
			if (frame) {
				cancelAnimationFrame(frame);
				updateScroll();
			}
			drag.current = null;
			setActive(false);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			if (frame) cancelAnimationFrame(frame);
		};
	}, [active, onUserScroll, viewport]);

	/*
	 * 滚不动的时候不拦滚轮。
	 *
	 * `contain` 要拦的是「滚到边界了别带动外面」，不是「我自己滚不动也不让你滚」。可 `overflow-y: auto`
	 * 的元素**即使内容没溢出**仍然是个 scroll container，`overscroll-behavior` 照样生效——于是设置页
	 * 里一张内容没撑满的卡片，鼠标停上去整页就滚不动了，移开又好。
	 *
	 * 真窗口里拿真滚轮量过：滚不动的盒子挂 `contain`，外层一动不动；同一个盒子换成 `auto`，外层照常
	 * 走 360px。两种溢出状态各试一遍才分得清——只测「可滚且到底」那一半，会把这个毛病当成 `contain`
	 * 本来该做的事放过去。见 `e2e/overscroll-chain-probe.ts`。
	 */
	const chain = overscroll === "auto" || !metrics.overflow ? "overscroll-auto" : "overscroll-contain";

	// Both only mean anything once something is actually hidden that way.
	const hiddenAbove = metrics.overflow && !metrics.atTop;
	const showTopFade = top === "fade" && hiddenAbove;
	const showBottomFade = bottom === "fade" && metrics.overflow && !metrics.atBottom;
	const fades = top === "fade" || bottom === "fade";

	return (
		<div className={`ly-scroll-host relative flex min-h-0 flex-col ${className}`}>
			<div
				ref={viewport}
				onScroll={(event) => {
					queueMeasure(read);
					onScroll?.(event.currentTarget);
				}}
				/*
				 * 捕获阶段，早于任何 onClick。
				 *
				 * 展开一段折叠区的那一帧要用的是**按下时**元素在视口的高度；等点击冒泡上来，布局
				 * 已经变了，量到的是展开之后的位置，锚也就锚错了地方。
				 */
				onPointerDownCapture={(event) => onHold?.(event.target)}
				/*
				 * A flex child, not `height: 100%`.
				 *
				 * `height: 100%` needs a parent with a *resolved* height. Given one bounded by
				 * `max-height` instead — which is how every menu here is sized — it resolves to
				 * `auto`, the viewport grows with its content, and nothing scrolls: the branch
				 * list simply ran off the bottom of its own menu. Percentage `max-height` fails
				 * the same way, for the same reason. Making the host a flex column and this its
				 * item hands the sizing to the flex algorithm, which honours both a fixed height
				 * and a `max-height` — so one Scroller works in a pane and in a popover.
				 */
				/*
				 * The fade is a mask on this element, and the depths are the whole of its state —
				 * zero means no fade, so the same declaration covers both ends and both directions
				 * and the transition between them is one interpolating length. Only mounted with the
				 * class where a fade is possible: a mask promotes the scroller to its own composited
				 * layer, and there is no reason to pay that on a scroller that will never soften.
				 */
				/*
				 * Vertical only, and `overflow-x` stated rather than left to the browser.
				 *
				 * `overflow-y: auto` with `overflow-x: visible` is not a combination CSS has: the
				 * spec makes the visible one `auto` too. So every scroller in the app was quietly
				 * able to scroll sideways, and one over-wide child — a code block holding a commit
				 * hash, a table — dragged the whole column with it. What you saw was the transcript
				 * itself shifted left, headings and prose and all, to make room for something that
				 * has its own way of handling being too wide.
				 *
				 * Which is the actual fix: `pre` already scrolls itself (see `.prose-dw pre`), and
				 * clipping here is what lets it. A reading column has no meaning off to the right —
				 * anything genuinely wider than the window is wide *inside* its own box.
				 */
				className={`ly-scroll-view min-h-0 flex-auto overflow-x-hidden overflow-y-auto ${
					chain
				/*
				 * `ly-fade-y`，不是 `ly-scroll-fade`——后者没有对应的 CSS 规则。
				 *
				 * 上面那个 `style` 只写 `--ly-fade-top` 和 `--ly-fade-bottom` 两个变量，而遮罩本身
				 * 读不到它们：`.ly-fade-y`（`styles/scroll.css`）先把这两个变量派生成四个，`mask-image`
				 * 只认那四个。类名一改，变量照样写得出去，遮罩规则却不再命中，于是每一个带渐隐的滚动面
				 * ——转录、侧栏、设置页、浮层——上下边缘都是硬切。
				 *
				 * 没有任何检查拦得住这个：类名是字符串，typecheck 和 lint 都不看它。
				 */
				} ${fades ? "ly-fade-y" : ""} ${contentClassName}`}
				tabIndex={-1}
				style={
					fades
						? ({
								"--ly-fade-top": showTopFade ? `${scrollFade(metrics.height, "top", fadeTop)}px` : "0px",
								"--ly-fade-bottom": showBottomFade ? `${scrollFade(metrics.height, "bottom")}px` : "0px",
							} as React.CSSProperties)
						: undefined
				}
			>
				{children}
			</div>

			{metrics.overflow && (
				<div
					/*
					 * On the edge, above everything on it, and taking no clicks of its own.
					 *
					 * Two things want this strip: the thumb, and — in a resizable pane — the drag handle
					 * that widens it. They used to be at the same depth with the handle on top, so the
					 * thumb was drawn, could be seen, and could never be grabbed. Insetting the track
					 * past the handle did fix that and cost more than it was worth: a scrollbar floating
					 * nine pixels off the edge it belongs to, in every pane in the app.
					 *
					 * They are not really competing, though, because the track is not a control. It has
					 * no fill and nothing to hit — only the thumb inside it does. So the track goes above
					 * the handle to keep the thumb visible over sticky headers and hands every press
					 * straight through; the thumb takes its own back. What is left is a thumb-shaped
					 * hole in the resize strip, at a spot the pointer can see, rather than a scrollbar
					 * moved out of position everywhere to make room for a handle in one pane.
					 *
					 * Clicking the track to jump goes with it. It was never discoverable on a 10px strip
					 * with no visible track, and it is not worth an edge you cannot drag.
					 */
					className="pointer-events-none absolute top-0 right-0 bottom-0 z-40 w-[10px]"
				>
					{/* Hidden from assistive technology: the viewport underneath is what scrolls. */}
					<div
						ref={thumb}
						aria-hidden
						tabIndex={-1}
						onMouseDown={(event) => {
							event.preventDefault();
							const el = viewport.current;
							if (!el) return;
							drag.current = { startY: event.clientY, startTop: el.scrollTop };
							setActive(true);
							// A hand on the thumb is a claim on the surface before it has moved at all —
							// and, if a ride back down is in flight, the thing that calls it off.
							onUserScroll?.("unknown");
						}}
						className={`ly-thumb absolute top-0 right-[2px] w-[6px] rounded-full bg-ink-faint ${active ? "ly-thumb-active" : ""}`}
					/>
				</div>
			)}
		</div>
	);
}
