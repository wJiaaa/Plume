/**
 * One scrolling surface's relationship with its own bottom.
 *
 * The rule is in `follow.ts` and is testable without a browser. What is here is everything that
 * needs a DOM: where the reader's intention is heard from, when the position is written, and how
 * the way back is animated.
 *
 * Every transcript calls this — the conversation (the side chat is one too) and a delegate's — and
 * before it they each had their own near-copy. The copies had drifted: different slack, only one of them
 * watching for content resizing, only one offering a way back. Anything fixed in one stayed broken
 * in the other two, which is the actual reason this exists.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
	followsAfterRestore,
	isAway,
	isDegenerate,
	marker as makeMarker,
	nextState,
	targetScrollTop,
	unreadSince,
	visualBottom,
	type Direction,
	type FollowState,
	type Marker,
	type Reading,
} from "./follow.ts";
import { readFollow, writeFollow, type FollowSnapshot } from "./memory.ts";
import { motionReduced } from "../motion/reduced.ts";
import { windowFocused } from "../motion/ticker.ts";

/** How long the ride back down takes. The curve matches `--ly-e-out`, like everything else here. */
const GLIDE_MS = 420;
/**
 * 一次按下能按住多久的锚。
 *
 * 要盖住展开动画走完（`--ly-t-slow` 那一档）加上图片落位，又不能长到把后面一次无关的长高也
 * 按住。滚一下就作废，所以宁可稍长。
 */
const HOLD_MS = 900;
/**
 * 贴着底部时，内容长高了多少以内算「输出」，计进输出速度（`FLOW_TAU`）。
 *
 * 回复写到底部时，每起一行转录长高一行（二十几像素）。从前每一次都当场把位置写到底，于是整段
 * 回复一顿一顿地往上顶，一行一顿。这么小的一截改成追：滑过去而不是跳过去，一行接一行连成一条平稳的
 * 上移，新的那行字也正在淡入，两者合在一起才是一条流。超过一屏的（打开会话、一次倒进来一大篇）
 * 一步到位。
 */
const CHASE_MAX = 200;
/**
 * 追的时候最多落后底部多少；超出的部分在长高的同一帧写掉。
 *
 * 不能没有：整块到的工具卡整段慢慢追时，量到运行行被压到视口下沿以下 129px、21 帧。也不能小：正文
 * 换段、起标题一次就长 35–70px，截在 40px 时每次都是单帧 20–30px 的跳。落后的那一截里是刚放出来、
 * 还在淡入的字。
 */
const LAG_MAX = 120;
/**
 * 追的方式：两个临界阻尼的弹簧串起来，前一个把台阶状的目标抹成斜坡，后一个跟着斜坡走。
 *
 * 版面是一行一行、一段一段长的：每次 24–70px，间隔 20–560ms。只用一个弹簧，刚度够让落后小，两行
 * 之间就追平停住，下一行再从零起步，一行一顿，量到过四成的帧原地不动。串起来以后速度跨着台阶接着
 * 用，原地不动的帧剩一成上下，多在上游停顿里。
 *
 * 刚度随输出速度变（`stiffness`），稳定输出时落后约 `CHASE_LAG`：慢的时候软，快的时候硬，落后不随
 * 速度变长。参数是拿真窗口录下的逐帧版面离线比出来的，见 `e2e/stream-follow-probe.ts`。
 */
const CHASE_LAG = 36;
/** 刚度的上下限，按时间常数（毫秒）记。上限管写完以后最后一行多久追平：一行约 0.4s。 */
const TAU_MIN = 12;
const TAU_MAX = 60;
/** 落后超出 `CHASE_LAG` 越多弹簧越硬，多出 70px 时时间常数 20ms：整块到的一截靠它很快追完。 */
const BOOST = 1400;
/** 输出速度按多长的时间窗来估。要比一行的间隔长得多，估出来的速度才不随每一行忽高忽低。 */
const FLOW_TAU = 800;
/**
 * `live` 落下以后还算输出的时长。上游写完时屏幕上的字还没放完：出字最多落后上游 700ms，最后一个
 * 字再淡 180ms（`stream-pace.ts`）。这段里长出来的行当成静止时的长高、当帧写到底，收尾那几行就
 * 一行一跳，量到过单帧 49px。
 */
const TAIL_MS = 1000;
/** 转录里会做过渡的高度属性：界面块的 `height`，折叠区（`.ly-reveal`）的 `grid-template-rows`。见 `growing`。 */
const SIZES = new Set(["height", "grid-template-rows"]);

export interface FollowBottom {
	/** Hand to `Scroller`'s `scrollRef`. */
	scrollRef: React.RefObject<HTMLDivElement | null>;
	/**
	 * Put at the very end of the scrolled content.
	 *
	 * This is what "you have seen the newest message" means, and it has to be an element rather
	 * than an arithmetic test: the reader who scrolls up two screens, reads the three paragraphs
	 * that arrived, and stops there has caught up, and no distance-from-bottom threshold can tell
	 * that apart from someone who has not.
	 *
	 * A callback rather than a ref object, and that is not a style choice. The transcript container
	 * is keyed on the session, so opening one — or a blank conversation acquiring its id after the
	 * first message — throws the whole subtree away and builds a new one. A ref object would be
	 * repointed at the new sentinel silently, leaving the observer watching a node that is no longer
	 * in the document and can therefore never intersect anything again. That is exactly what
	 * happened: the mark-as-read never fired once, so 「有新内容」 stayed lit forever.
	 */
	tailRef: (node: HTMLDivElement | null) => void;
	/** Whether to offer the way back. */
	away: boolean;
	/** How many messages arrived while the reader was away. Zero unless something really arrived. */
	unread: number;
	/** The reader asking to go back: the button, or having just sent something. */
	returnToBottom(instant?: boolean): void;
	/** Explicit navigation owns the scroll position even while a reply is streaming. */
	detach(): void;
	/** Jump there at once; navigation owns the position from then on. */
	scrollTo(top: number): void;
	/** Hand to `Scroller`'s `onScroll`. */
	onScroll(el: HTMLDivElement): void;
	/** Hand to `Scroller`'s `onResize`. */
	onResize(el: HTMLDivElement): void;
	/**
	 * Hand to `Scroller`'s `onUserScroll`: the one gesture the viewport cannot hear for itself.
	 *
	 * The overlay scrollbar is drawn beside the viewport rather than inside it and moves the surface
	 * by assignment, so dragging the thumb produces no wheel, no touch and no key — only a scroll
	 * event, which by the rule in `follow.ts` may not detach anything. `Scroller` is the one place
	 * that knows a drag is a drag, so it says so, instead of leaving it to be inferred from the
	 * position afterwards along with everything else that moves a transcript.
	 */
	onUserScroll(direction: Direction): void;
	/**
	 * Hand to `Scroller`'s `onHold`: what the reader has just put a finger on.
	 *
	 * 展开一段折叠区会让转录长高，而长高本身分不清是「新消息到了」还是「读者点开了手里这一块」。
	 * 这一条就是那个区别：按下时记住按到的元素在视口的哪个高度，接下来这一次长高把它放回原处，
	 * 跟随底部让路。没有它，点开历史里的一个工具组会把读者直接甩到转录末尾。
	 */
	hold(target: EventTarget | null): void;
}

export function useFollowBottom({
	surfaceId,
	count,
	tail,
	namespace,
	ready = true,
	live,
}: {
	/** Which conversation, side chat or delegate this is. `null` while there is nothing to show. */
	surfaceId: string | null;
	/** How many rows the transcript has. */
	count: number;
	/** Something that changes when the last row does — see `Marker`. */
	tail: string;
	/** Which family of surfaces to remember against; see `memory.ts`. */
	namespace: string;
	/** A restored offset is meaningful only after this surface's content has arrived. */
	ready?: boolean;
	/**
	 * Whether this transcript is being written right now. Only then — and for `TAIL_MS` after, while
	 * the last words are still being let out — is growth output, and only output is chased: at rest
	 * it is a card or an image landing late — the delivery card fetches its files after mount — and
	 * sliding for that drags the whole history up from below.
	 */
	live: boolean;
}): FollowBottom {
	const scrollRef = useRef<HTMLDivElement>(null);
	/*
	 * Held in state, so that a new sentinel re-runs the observer effect.
	 *
	 * The extra render this costs happens only when the element itself is replaced — a session
	 * swap — and it is the difference between the observer watching what is on screen and watching
	 * a detached node. Reading it out of a ref in an effect with an empty dependency list looked
	 * equivalent and was not.
	 */
	const [tailEl, setTailEl] = useState<HTMLDivElement | null>(null);
	const tailRef = useCallback((node: HTMLDivElement | null) => setTailEl(node), []);

	/*
	 * The state is a ref, not React state.
	 *
	 * It is read in a layout effect on every streamed token and written from a wheel handler; a
	 * re-render for either would be a re-render of the whole transcript. What has to be drawn is
	 * derived from it — `away` and `unread` below — and those change rarely.
	 */
	const state = useRef<FollowState>("following");
	const [away, setAway] = useState(false);
	const [unread, setUnread] = useState(0);

	/** What the reader has caught up to. Null means "everything", which is where a surface starts. */
	const seen = useRef<Marker | null>(null);
	/**
	 * The transcript as it stands, for the callbacks that run outside a render — the sentinel
	 * observer, mainly. Updated inside layout effects rather than during render, so a render React
	 * discards cannot leave a marker behind for a transcript that was never committed.
	 */
	const current = useRef<Marker>(makeMarker(count, tail));

	/**
	 * The last position this hook wrote, so the scroll event it causes is not mistaken for the
	 * reader moving. Cleared on the next frame — scroll events are dispatched before rAF, so
	 * anything still holding this value at that point never produced one.
	 */
	const written = useRef<number | null>(null);
	const lastTop = useRef(0);
	const glide = useRef(0);
	/** 贴底追赶的那一帧，和上一次送到底时内容与视口的高度——分辨「内容长高了一小截」要用。 */
	const chase = useRef(0);
	const size = useRef({ content: 0, view: 0 });
	const flow = useRef<Flow>({ amount: 0, at: 0, since: 0 });
	/**
	 * 滚动区里正在做高度过渡的元素。
	 *
	 * 界面块边写边长（`InterfaceBlock` 的 `Growing`）、折叠区开合，这种长高本身已经是一帧一小截、平滑的，
	 * 再交给弹簧抹一遍只会落后：量到过界面块的下沿被压到视口外 116px。所以它在 `pin` 里当帧跟着挪。
	 * 过渡事件会冒泡，在滚动区上听就够。
	 */
	const growing = useRef(new Set<EventTarget>());
	const restoredSurface = useRef<string | null | undefined>(undefined);
	const selectedSurface = useRef<string | null | undefined>(undefined);
	const restore = useRef<FollowSnapshot | undefined>(undefined);
	const clearWritten = useRef(0);
	/**
	 * 刚露面（换了会话、从 `Activity` 的隐藏里回来）、第一帧还没画完。
	 *
	 * 回来时第一次提交画的是离开时的旧内容，订阅重挂后紧跟着补进离开期间写下的字。那一截不是此刻在出的
	 * 字，滑过去就是切进来先落后一百来像素、再往上滑一段。所以这段时间里贴底一律一步到位。撑两帧：
	 * 补账那次 `pin` 走的是 `ResizeObserver`，晚于同一帧的 rAF。
	 */
	const arriving = useRef({ on: false, frame: 0 });
	/** Read by `pin`, which is memoised and must not be rebuilt on every token. `ended`: when `live` last fell. */
	const writing = useRef({ live, ended: Number.NEGATIVE_INFINITY });
	if (writing.current.live && !live) writing.current.ended = performance.now();
	writing.current.live = live;

	/**
	 * 手指上一次的位置，给 touchmove 定方向用。
	 *
	 * 触摸和滚轮不一样：`wheel` 自带 `deltaY`，`touchmove` 只给坐标，方向得自己算。手指往上抹，
	 * 内容跟着往上走，露出来的是更下面的东西——所以 clientY 变小是 "down"。
	 */
	const touchY = useRef(0);

	/*
	 * 刚被按下的那个东西，和它当时在视口里的高度。
	 *
	 * 展开一段折叠区会让转录长高，而长高会走 `onResize`——那里只问一句「在不在跟随底部」，在就
	 * 滚到底。于是点开一个历史里的折叠区，读者被直接带到转录末尾：量过一次「调用工具 42 个」，
	 * 点中的那个按钮当场飞出视口 1952px；「再显示 1 个文件」则是整段文字平移 36px。人说的「点
	 * 一下就在跳」就是这个。
	 *
	 * 按下时记住它的位置，长高之后把它放回原处——点开的那一段自然向下延展，手指底下的东西一动
	 * 不动。这是「跟随底部」唯一该让路的时候：读者正在看的是手里这一块，不是末尾。
	 */
	const anchor = useRef<{ el: HTMLElement; top: number; until: number } | null>(null);

	/*
	 * 读者眼前那一块（见 `firstInView`）、它离视口顶多远，以及记下时视口有多宽。
	 *
	 * 宽度一变正文就重新断行，上面的内容跟着变高变矮。浏览器的滚动锚定在这里不补：窄窗格里开合
	 * 侧栏，不靠这里时眼前那一段一路被带走 171px；停在离底部 150px 处收起侧栏，画面一帧上跳 123px、
	 * 几乎贴底，展开又跳回来。侧栏、右栏开合，拖分隔线、拖窗口都走这一处。
	 *
	 * 只管宽度变了的那一帧，也只在读者滚开时管：跟着底部的由 `pin` 送到底，按住东西的由 `settle`。
	 * 曾经由侧栏动画接管正文那一栏的宽度来补这件事，它和跟随底部、浏览器的滚动夹位轮流打架。
	 */
	const place = useRef<{ node: Element; top: number; width: number } | null>(null);

	const read = (el: HTMLDivElement): Reading => ({
		scrollTop: el.scrollTop,
		scrollHeight: el.scrollHeight,
		clientHeight: el.clientHeight,
	});

	/** Move the surface, and remember that it was us. */
	const write = useCallback((el: HTMLDivElement, top: number) => {
		el.scrollTop = top;
		// Read back rather than trusting the assignment: the browser clamps, and comparing against
		// the clamped value is what makes the check in `onScroll` reliable on a transcript that has
		// just shrunk.
		written.current = el.scrollTop;
		lastTop.current = el.scrollTop;
		cancelAnimationFrame(clearWritten.current);
		clearWritten.current = requestAnimationFrame(() => {
			written.current = null;
		});
	}, []);

	/**
	 * 把锚点放回按下时那个高度。返回 true 表示这一次长高由锚点做主，跟随底部不要插手。
	 *
	 * 只碰 `scrollTop`，不碰任何 React 状态——它要能在 `ResizeObserver` 的回调里**同步**跑完。
	 * 那个回调发生在布局之后、绘制之前，是这一帧最后一次还来得及改位置的机会；推到 rAF 里就晚
	 * 了一帧，当帧已经拿旧位置画过一遍，展开动画走完就是肉眼可见的一串小抖（量到 14px）。
	 *
	 * 返回 true 的时机也是要点：不光锚点漂了要挪，**没漂也得拦住**跟随底部。一段在底部附近展开
	 * 的折叠区照样把 `scrollHeight` 撑大，不拦就被原样拉到底。
	 */
	const settle = useCallback(
		(el: HTMLDivElement): boolean => {
			const held = anchor.current;
			if (!held) return false;
			if (performance.now() > held.until || !held.el.isConnected) {
				anchor.current = null;
				return false;
			}
			/*
			 * 自己把它挪回去，不要指望浏览器原生的 scroll anchoring。
			 *
			 * 试过只拦不挪：展开一个大工具组（长高 952px）时原生锚定确实顶住了，一动不动；而展开
			 * 底部那张文件卡（36px）它整整漏掉 36px，按钮被推走多少就是多少。两种一起量才看得出
			 * 来——只测大的那个会得出「原生的就够了」这个错结论。
			 */
			const drift = held.el.getBoundingClientRect().top - held.top;
			if (Math.abs(drift) >= 1) write(el, el.scrollTop + drift);
			return true;
		},
		[write],
	);

	/**
	 * 记下读者眼前那一行；跟着底部的不用记。
	 *
	 * 滚动事件里也要记（读者滚到了别处），但宽度已经变了的那一帧不行：滚动事件派发时，这一帧的
	 * 新宽度和重新断行已经排好了，这时记下的是漂过之后的位置，`keepPlace` 就量不到漂移。量到过：
	 * 补偿写下去的下一帧，它自己的滚动事件把基准换掉，一半的帧白白漂走 24px。那一帧留给 `onResize`。
	 */
	const remember = useCallback((el: HTMLDivElement, scrolled = false) => {
		if (scrolled && place.current && el.clientWidth !== place.current.width) return;
		place.current = null;
		if (state.current !== "detached") return;
		const edge = el.getBoundingClientRect().top;
		const node = firstInView(el, edge);
		if (node) place.current = { node, top: node.getBoundingClientRect().top - edge, width: el.clientWidth };
	}, []);

	/**
	 * 宽度变了，把眼前那一行放回原来的高度。和 `settle` 一样只碰 `scrollTop`，在 `ResizeObserver`
	 * 的回调里同步跑完。按屏幕上的位置量：哪一帧浏览器自己锚定过，这里就量到没漂，不会补两遍。
	 */
	const keepPlace = useCallback(
		(el: HTMLDivElement) => {
			const kept = place.current;
			if (!kept || state.current !== "detached" || el.clientWidth === kept.width || !kept.node.isConnected) return;
			const drift = kept.node.getBoundingClientRect().top - el.getBoundingClientRect().top - kept.top;
			if (Math.abs(drift) >= 0.5) write(el, el.scrollTop + drift);
		},
		[write],
	);

	/** Redraw whatever is derived from where we are. */
	const publish = useCallback((reading: Reading) => {
		if (isDegenerate(reading)) return;
		// Only a reader who has settled somewhere above is offered the way back. Mid-glide the
		// button would be offering to do what is already happening.
		setAway(state.current === "detached" && isAway(reading));
	}, []);

	/**
	 * 跟随底部时把位置送到底：一屏以内的长高用弹簧追、最多落后 `LAG_MAX`，其余一步到位——见 `CHASE_MAX`。
	 *
	 * 两个入口共用它：内容签名变了（布局 effect）和尺寸变了（`onResize`），流式输出时两者每帧
	 * 都会来，所以「已经在追」本身就是继续追的理由，第二个入口不能把它打断成一步到位。
	 *
	 * 视口变了不追：输入框长高两行时，最后一行要立刻跟着让出来，不然会被输入框挡住一阵。
	 */
	const pin = useCallback(
		(el: HTMLDivElement) => {
			const reading = read(el);
			const grew = reading.scrollHeight - size.current.content;
			const sameView = reading.clientHeight === size.current.view;
			size.current = { content: reading.scrollHeight, view: reading.clientHeight };
			const now = performance.now();
			const kept = flow.current.amount * Math.exp(-(now - flow.current.at) / FLOW_TAU);
			const added = grew > 0 && grew <= CHASE_MAX ? grew : 0;
			flow.current = { amount: kept + added, at: now, since: added > 0 && kept < 1 ? now : flow.current.since };
			const target = targetScrollTop("following", reading);
			if (target === null) return;

			const moving = chase.current !== 0;
			const output = writing.current.live || now - writing.current.ended < TAIL_MS;
			// 窗口没焦点时不追，直接贴底：正文那时按 10Hz 长（`ticker.ts`），弹簧却照样每帧写 `scrollTop`，
			// 失焦省下的那点几乎全被它吃掉。没人盯着看的时候，这一段滑不滑没有区别。
			const slide =
				!arriving.current.on && output && sameView && grew >= 0 && grew <= reading.clientHeight && target > reading.scrollTop && (moving || grew > 0) && !motionReduced() && windowFocused();
			if (!slide) {
				cancelAnimationFrame(chase.current);
				chase.current = 0;
				write(el, target);
				return;
			}
			// 这里跑在布局之后、绘制之前（布局 effect 或 `ResizeObserver` 回调），下面两次写都当帧生效。
			// 高度过渡里长出来的这一截跟着挪，见 `growing`。
			if (grew > 0 && transitioning(growing.current)) write(el, reading.scrollTop + grew);
			if (target - el.scrollTop > LAG_MAX) write(el, target - LAG_MAX);
			if (moving) return;

			// 位置自己记一份小数：浏览器会把 `scrollTop` 取整到物理像素，每帧挪不到半个像素的那几帧
			// 读回来原地不动，拿读回来的值接着算就永远差那一点。
			const view: Spring = { at: el.scrollTop, speed: 0 };
			// 前一级：抹平了的目标。
			const ramp: Spring = { at: el.scrollTop, speed: 0 };
			let last = 0;
			const step = (now: number) => {
				chase.current = 0;
				// 读者滚开了、按住了东西、或者换了会话：不追了。
				if (state.current !== "following" || anchor.current || !el.isConnected) return;
				const here = read(el);
				if (isDegenerate(here)) return;
				// 别人挪过（浏览器夹住、原生锚定、`LAG_MAX` 那一刀），以实际位置为准；前一级不能落在视口
				// 后面，否则会把视口往回拽。
				if (Math.abs(here.scrollTop - view.at) > 1) view.at = here.scrollTop;
				if (ramp.at < view.at) ramp.at = view.at;
				// 第一帧没有上一帧可比，按一帧算；切到后台回来的那一帧夹住，不一步跳完。
				const dt = last ? Math.min(50, Math.max(0, now - last)) : 16;
				last = now;
				const end = visualBottom(here);
				const omega = stiffness(outputRate(flow.current, now), end - view.at);
				advance(ramp, end, omega, dt);
				advance(view, ramp.at, 2 * omega, dt);
				if (end - view.at < 0.5 && end - ramp.at < 0.5) {
					// 多写一个像素让浏览器夹到真正的底，理由见 `targetScrollTop`。
					write(el, end + 1);
					publish(read(el));
					return;
				}
				write(el, view.at);
				chase.current = requestAnimationFrame(step);
			};
			chase.current = requestAnimationFrame(step);
		},
		[write, publish],
	);

	// ---------------------------------------------------------------------------
	// The reader's intention
	// ---------------------------------------------------------------------------

	/**
	 * Everything that can change the state, in one place.
	 *
	 * Called from native listeners rather than React's synthetic events, because the whole point is
	 * to hear the gesture *before* the frame it causes: a wheel notch and a streamed token race
	 * each other, and losing that race is what made scrolling up during a reply feel like the wheel
	 * had stopped working.
	 */
	const intend = useCallback(
		(direction: Direction) => {
			const el = scrollRef.current;
			if (!el) return;
			const reading = read(el);
			const before = state.current;
			state.current = nextState(before, { kind: "user-scroll", direction }, reading);
			// Leaving `returning` for any reason means the ride is off.
			if (before === "returning" && state.current !== "returning") cancelAnimationFrame(glide.current);
			// 自己滚开了，手里那个锚就不是「正在看的东西」了。
			anchor.current = null;
			publish(reading);
		},
		[publish],
	);

	/*
	 * Three listeners, and every one of them hears a gesture with a name.
	 *
	 * What is *not* here is the point. There used to be `pointerdown` on the host and
	 * `pointermove`/`pointerup`/`pointercancel` on the window, feeding a "the reader has a hand on
	 * something" flag that let `onScroll` read a position change as a gesture. None of those is a
	 * scroll. `pointerup` on the window fires for a click on the sidebar, a button in a panel, the
	 * composer — the whole application — and each one opened a 300ms window in which the next reflow
	 * of a streaming turn ended the follow. `pointerdown` on the host was no better: it sits above
	 * the viewport, so expanding a tool card or selecting a line of text inside the transcript went
	 * through it too. And the flag had no way back if its `pointerup` was swallowed by a native
	 * context menu or lost to a window blur, at which point the surface detached on the next reflow
	 * and stayed that way.
	 *
	 * Dragging the thumb is the one real gesture they existed to catch, and `Scroller` now reports
	 * it through `onUserScroll`. So they are gone rather than narrowed.
	 */
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;

		/** Whether a gesture landed on this surface rather than on one nested inside it. */
		const mine = (event: Event) =>
			!(event.target instanceof Element) || event.target.closest(".ly-scroll-view") === el;

		const onWheel = (event: WheelEvent) => {
			if (event.deltaY === 0) return;
			// A tool result or code block can scroll independently inside the transcript.
			if (!mine(event)) return;
			intend(event.deltaY < 0 ? "up" : "down");
		};
		// A finger down is a claim on the surface before it has moved at all.
		const onTouchStart = (event: TouchEvent) => {
			if (!mine(event)) return;
			touchY.current = event.touches[0]?.clientY ?? 0;
			intend("unknown");
		};
		const onTouchMove = (event: TouchEvent) => {
			if (!mine(event)) return;
			const y = event.touches[0]?.clientY;
			if (y === undefined) return;
			const moved = y - touchY.current;
			touchY.current = y;
			// A finger held still is not a direction; anything else is, however small.
			if (moved === 0) return;
			intend(moved > 0 ? "up" : "down");
		};
		/*
		 * Keys arrive here by bubbling, not by focus.
		 *
		 * The viewport carries no `tabIndex` and never holds focus itself — but it is an ancestor of
		 * everything in the transcript, so `PageUp` pressed while a tool card's expander has focus
		 * passes through, and that is a scroll like any other. Fields are excluded because in one
		 * the same keys move a caret instead.
		 */
		const onKey = (event: KeyboardEvent) => {
			if (event.target instanceof Element && event.target.closest("textarea, input, [contenteditable=true]")) return;
			if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
			intend(["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey) ? "up" : "down");
		};

		// Passive: none of them is prevented, and saying so keeps the wheel off the main thread's
		// critical path.
		el.addEventListener("wheel", onWheel, { passive: true });
		el.addEventListener("touchstart", onTouchStart, { passive: true });
		el.addEventListener("touchmove", onTouchMove, { passive: true });
		el.addEventListener("keydown", onKey);
		return () => {
			el.removeEventListener("wheel", onWheel);
			el.removeEventListener("touchstart", onTouchStart);
			el.removeEventListener("touchmove", onTouchMove);
			el.removeEventListener("keydown", onKey);
		};
	}, [intend]);

	// 哪些元素正在做高度过渡，见 `growing`。
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onRun = (event: TransitionEvent) => {
			if (event.target && SIZES.has(event.propertyName)) growing.current.add(event.target);
		};
		const onEnd = (event: TransitionEvent) => {
			if (event.target && SIZES.has(event.propertyName)) growing.current.delete(event.target);
		};
		el.addEventListener("transitionrun", onRun);
		el.addEventListener("transitionend", onEnd);
		el.addEventListener("transitioncancel", onEnd);
		return () => {
			el.removeEventListener("transitionrun", onRun);
			el.removeEventListener("transitionend", onEnd);
			el.removeEventListener("transitioncancel", onEnd);
		};
	}, []);

	// ---------------------------------------------------------------------------
	// What the scroller reports
	// ---------------------------------------------------------------------------

	const onScroll = useCallback(
		(el: HTMLDivElement) => {
			if (!ready || restoredSurface.current !== surfaceId) return;
			const reading = read(el);
			lastTop.current = reading.scrollTop;

			if (isDegenerate(reading)) return;

			// Our own write, arriving as an event. It says nothing about what the reader wants.
			if (written.current !== null && Math.abs(reading.scrollTop - written.current) < 1) {
				written.current = null;
				remember(el, true);
				publish(reading);
				return;
			}

			/*
			 * Everything else that moved the surface, treated as one thing — because here it is one
			 * thing.
			 *
			 * The tail of a fling, the browser clamping a transcript that just lost its oldest run,
			 * anchoring holding a line still while a thinking block folds open above it: by the time
			 * they reach this handler they are a position and nothing else. `arrived` is the only
			 * honest claim to make from that, and it can only put the surface back on the end, never
			 * take it off. Gestures are heard where they happen, in `intend`.
			 */
			state.current = nextState(state.current, { kind: "arrived" }, reading);
			remember(el, true);
			publish(reading);
		},
		[publish, ready, surfaceId, remember],
	);

	/** 换过来以后头一次量到真尺寸：读者在这儿往上翻过的话，放回上次停的位置。只做一次。 */
	const restoreOnce = useCallback(
		(el: HTMLDivElement) => {
			if (restoredSurface.current === surfaceId) return;
			restoredSurface.current = surfaceId;
			if (state.current === "detached" && restore.current) write(el, restore.current.scrollTop);
		},
		[surfaceId, write],
	);

	/**
	 * The box or its contents changed size.
	 *
	 * This is the callback the side chat and the delegate panel never had, and the one the
	 * conversation only used to update a flag with. Following has to be *applied* here, not merely
	 * re-tested: the composer growing by two lines moves the bottom without moving the content, and
	 * a surface that only re-tests concludes the reader has wandered off.
	 */
	const onResize = useCallback(
		(el: HTMLDivElement) => {
			// 手里按着东西的时候，跟随底部让路——细节见 `settle`。排在下面的门前面：会话还在读盘时点开
			// 一段折叠区，也要把按到的那一块放回原处。
			const held = settle(el);
			if (!ready || selectedSurface.current !== surfaceId) return;
			const reading = read(el);
			if (isDegenerate(reading)) return;
			restoreOnce(el);
			if (!held) {
				if (state.current === "following") pin(el);
				else keepPlace(el);
			}
			remember(el);
			publish(read(el));
		},
		[publish, ready, surfaceId, settle, restoreOnce, pin, keepPlace, remember],
	);

	/**
	 * 按在转录上的那一下：记住按到的是谁，以及它此刻在视口的哪个高度。
	 *
	 * 挂在捕获阶段，比任何 `onClick` 都早——展开的那一帧要用的是**按下时**的位置，等到点击冒泡
	 * 上来，布局可能已经变了。
	 *
	 * 不挑按钮也不挑元素：不改变高度的点击根本不会走到 `onResize`，锚点在超时后自己过期，什么
	 * 也不会发生。挑，反而要在这里重写一遍「哪些东西点了会变高」，而那份名单一定会漏。
	 */
	const hold = useCallback((target: EventTarget | null) => {
		if (!(target instanceof HTMLElement)) return;
		anchor.current = { el: target, top: target.getBoundingClientRect().top, until: performance.now() + HOLD_MS };
	}, []);

	// ---------------------------------------------------------------------------
	// Going back
	// ---------------------------------------------------------------------------

	const returnToBottom = useCallback((instant = false) => {
		const el = scrollRef.current;
		if (!el) return;
		const reading = read(el);
		if (isDegenerate(reading)) return;

		cancelAnimationFrame(glide.current);
		state.current = nextState(state.current, { kind: "user-return" }, reading);
		/*
		 * 回去比按住的那一下新。转录里的按钮发出一句话，按下时 `hold` 记了它；不在这里放掉，气泡一画进来
		 * `settle` 就把按钮放回原处，刚落到底又被拉回去——量过，离底 113px 停了 850ms，自己的话看不见。
		 */
		anchor.current = null;

		const land = () => {
			const settled = read(el);
			// A pixel past the end, for the reason spelled out in `targetScrollTop`: the integer
			// bottom is up to a pixel short of the real one, and landing short is what the ride back
			// would leave behind — the same sub-pixel gap the follow writes were leaving.
			write(el, visualBottom(settled) + 1);
			state.current = nextState(state.current, { kind: "settle" }, settled);
			seen.current = current.current;
			setUnread(0);
			publish(read(el));
		};

		// Sending a message is a snap, not a 420ms flight: the glide from a collapsed window
		// was the second half of the send-time bounce. Already there, or asked not to be moved
		// around, lands the same way. Either way the unread mark still clears.
		if (instant || state.current !== "returning" || motionReduced()) {
			land();
			return;
		}

		const from = reading.scrollTop;
		const started = performance.now();
		const step = (now: number) => {
			// Interrupted: `intend` has already taken the state away and cancelled the frame, but a
			// frame already scheduled can still arrive.
			if (state.current !== "returning") return;
			const progress = Math.min(1, (now - started) / GLIDE_MS);
			const eased = 1 - (1 - progress) ** 3;
			// Re-read every frame: a reply still streaming grows the page underneath the animation,
			// so a target fixed at the start arrives somewhere that is no longer the end.
			const target = visualBottom(read(el));
			write(el, from + (target - from) * eased);
			if (progress < 1) {
				glide.current = requestAnimationFrame(step);
				return;
			}
			land();
		};
		glide.current = requestAnimationFrame(step);
		setAway(false);
	}, [publish, write]);

	// ---------------------------------------------------------------------------
	// Catching up
	// ---------------------------------------------------------------------------

	/*
	 * Seeing the end is what marks it read — not being at the bottom.
	 *
	 * Scrolling up two screens to read what arrived and stopping there is catching up, and no
	 * distance test can tell it from not having caught up. The sentinel is the last thing in the
	 * content, so it entering the viewport is the fact itself rather than a proxy for it.
	 */
	useEffect(() => {
		const root = scrollRef.current;
		if (!root || !tailEl) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				seen.current = current.current;
				setUnread(0);
			},
			{ root },
		);
		observer.observe(tailEl);
		return () => observer.disconnect();
	}, [tailEl]);

	// ---------------------------------------------------------------------------
	// Swapping what the surface shows
	// ---------------------------------------------------------------------------

	/**
	 * Declared before the effect that follows the bottom, because it must run before it.
	 *
	 * React runs layout effects in declaration order, and getting this the wrong way round is the
	 * bug that made the remembered position useless: the follow effect ran first, wrote the
	 * *outgoing* surface's position into the *incoming* surface's memory, and the restore then
	 * faithfully read back what had just been written.
	 *
	 * Saving happens in the cleanup rather than at the top of the next run. Cleanups run after the
	 * DOM has been updated but before any layout effect has touched `scrollTop`, so what is read
	 * there is still the outgoing surface's position — and, unlike a check against a remembered
	 * previous id, it also fires when the component unmounts, which is what switching to the pull
	 * request view does to the whole transcript.
	 */
	useLayoutEffect(() => {
		size.current = { content: 0, view: 0 };
		const arrival = arriving.current;
		arrival.on = true;
		arrival.frame = requestAnimationFrame(() => {
			arrival.frame = requestAnimationFrame(() => {
				arrival.on = false;
			});
		});
		written.current = null;
		touchY.current = 0;
		restoredSurface.current = undefined;
		selectedSurface.current = surfaceId;
		place.current = null;
		current.current = makeMarker(count, tail);
		restore.current = surfaceId ? readFollow(namespace, surfaceId) : undefined;
		// The incoming surface's own remembered intention, never the outgoing one's. Carrying the
		// previous session's across is what made a transcript you had scrolled up in hand its
		// position — and its unread dot — to whichever conversation you opened next.
		state.current = restore.current?.following === false ? "detached" : "following";
		seen.current = restore.current?.seen ?? null;
		setUnread(0);
		setAway(false);

		return () => {
			// A glide belongs to the outgoing surface. Its intention is saved below, while its frames
			// must stop before the incoming surface reuses the same state and element refs. Runs on
			// unmount too, so this is the one place they are all stopped.
			cancelAnimationFrame(glide.current);
			cancelAnimationFrame(chase.current);
			chase.current = 0;
			cancelAnimationFrame(clearWritten.current);
			cancelAnimationFrame(arrival.frame);
			/*
			 * The position comes from `lastTop`, not from the element.
			 *
			 * Two reasons, and the second one is not obvious. React detaches a child's ref before it
			 * runs the parent's layout cleanup, so on unmount `scrollRef.current` is already null here
			 * — and unmounting is exactly what happens to the whole transcript when the pane switches
			 * to the pull request view. And a reading taken while the pane is merely hidden reports
			 * zero, which if stored would put the reader at the top of the transcript next time they
			 * opened it. `lastTop` is written by every scroll and every write we make, and never by a
			 * degenerate measurement, so it is the last position this surface was actually at.
			 */
			// A loading placeholder must never replace a real reading position.
			if (!surfaceId || restoredSurface.current !== surfaceId) return;
			writeFollow(namespace, surfaceId, {
				following: followsAfterRestore(state.current),
				scrollTop: lastTop.current,
				seen: seen.current,
			} satisfies FollowSnapshot);
		};
		// `count` and `tail` are read for the marker but deliberately not depended on: this effect is
		// about the surface changing, and re-running it on every token would re-read the memory and
		// undo the reader's position.
		// oxlint-disable-next-line exhaustive-deps
	}, [surfaceId, namespace, publish, write]);

	/**
	 * Content changed: follow it, or count it.
	 *
	 * The count is computed rather than incremented, from two numbers that describe the transcript
	 * rather than its identity. Opening a session hands React the same messages twice — once from
	 * the cache, once when the disk read lands — and an unread flag driven by identity called the
	 * second one new content. That is the 「有新内容」 that appears on a conversation you have
	 * merely revisited.
	 */
	useLayoutEffect(() => {
		current.current = makeMarker(count, tail);
		const el = scrollRef.current;
		if (!el || !ready) return;
		const reading = read(el);
		if (isDegenerate(reading)) return;
		restoreOnce(el);

		if (state.current === "following") {
			pin(el);
			seen.current = current.current;
			setUnread(0);

		} else {
			setUnread(unreadSince(seen.current, current.current));
		}
		publish(read(el));
	}, [count, tail, publish, ready, restoreOnce, pin]);

	const detach = useCallback(() => {
		cancelAnimationFrame(glide.current);
		state.current = "detached";
	}, []);
	const scrollTo = useCallback((top: number) => {
		detach();
		const el = scrollRef.current;
		if (!el) return;
		write(el, Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight)));
		publish(read(el));
	}, [detach, publish, write]);
	return { scrollRef, tailRef, away, unread, returnToBottom, onScroll, onResize, onUserScroll: intend, detach, scrollTo, hold };
}

/**
 * 读者眼前的第一块：按文档顺序第一个从 `edge` 或更下面开始的元素。
 *
 * 不取被视口顶边切开的那一块：一段纯文字被切开时，它自己重新断行，锚在它的顶上，露出来的那几行
 * 照样会动（量到过 22px）。一段文字比整个视口还高、里面没有别的开头时就找不到，那次不补。
 */
function firstInView(parent: Element, edge: number): Element | null {
	for (const child of parent.children) {
		const box = child.getBoundingClientRect();
		if (box.bottom <= edge) continue;
		if (box.top >= edge) return child;
		const inner = firstInView(child, edge);
		if (inner) return inner;
	}
	return null;
}

interface Spring {
	at: number;
	speed: number;
}

/** 临界阻尼弹簧朝 `target` 走 `dt` 毫秒的精确解，步长再大也不会冲过头或者发散。 */
function advance(spring: Spring, target: number, omega: number, dt: number): void {
	const offset = spring.at - target;
	const decay = Math.exp(-omega * dt);
	const pull = spring.speed + omega * offset;
	spring.at = target + (offset + pull * dt) * decay;
	spring.speed = (spring.speed - omega * pull * dt) * decay;
}

/**
 * 前一级弹簧的角频率（每毫秒），后一级取它的两倍：稳定输出时两级的落后合起来是 3 × 速度 / ω，
 * 也就是 `CHASE_LAG`。落后超出 `CHASE_LAG` 越多越硬（`BOOST`），夹在 `TAU_MIN`–`TAU_MAX` 之间。
 *
 * 速度取内容长高的速度，不取弹簧自己的速度：拿自己的速度定刚度会互相推高，一块大的长高第一帧就
 * 冲出去几百像素。
 */
function stiffness(rate: number, lag: number): number {
	return Math.min(1 / TAU_MIN, Math.max(1 / TAU_MAX, (3 * rate) / CHASE_LAG, (lag - CHASE_LAG) / BOOST));
}

/** 最近小幅长高的总量（按 `FLOW_TAU` 衰减）、记下它的时刻，和这一阵输出从什么时候开始。 */
interface Flow {
	amount: number;
	at: number;
	since: number;
}

/**
 * 输出速度（像素/毫秒）。一阵输出刚开始时衰减的总量还没攒满，按它实际跑了多久归一，不然头几行
 * 估得极慢、落后一大截；最少按 150ms 算，不然头一行会被当成一瞬间到的。
 */
function outputRate(flow: Flow, now: number): number {
	const window = FLOW_TAU * (1 - Math.exp(-Math.max(150, now - flow.since) / FLOW_TAU));
	return (flow.amount * Math.exp(-(now - flow.at) / FLOW_TAU)) / window;
}

/** 还有高度过渡在跑吗。顺手清掉被卸掉的：卸掉的元素收不到结束事件。 */
function transitioning(inFlight: Set<EventTarget>): boolean {
	for (const target of inFlight) {
		if (target instanceof Node && !target.isConnected) inFlight.delete(target);
	}
	return inFlight.size > 0;
}
