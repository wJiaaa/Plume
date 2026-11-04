import { useEffect, useRef, useState, type ReactNode } from "react";
import { Layers } from "../../ui/icons/index.ts";
import { Collapse } from "../../ui/layout/Collapse.tsx";
import { motionReduced } from "../../ui/motion/reduced.ts";
import { translate } from "../../i18n/translate.ts";
import { FlowRow } from "./FlowRow.tsx";
import { describeCalls } from "./call-words.ts";
import type { TurnFold } from "./turn-fold.ts";
import { useTranscriptDisclosure } from "./view-state.ts";

/** 这一轮里的一行。 */
export interface TurnEntry {
	key: string;
	node: ReactNode;
	/** 跑完后收进那一行（见 `turn-fold.ts`）。收起的几行是连着的；夹在中间不收的（页面、图）排到那一行后面。 */
	folded?: boolean;
	/** 回答那一行：收起时它在屏幕上不动。 */
	answer?: boolean;
}

/**
 * 有过程的一轮：跑着时过程一行行摊在对话里，跑完只留回答，前面的过程和中途说的话收成一行
 * （怎么分见 `turn-blocks.ts` 的 `TurnBlock`，收哪几行见 `turn-fold.ts`）。
 *
 * 跑着时不挂整轮的锚（「已工作 N 秒」）：它和底部运行指示说同一个数，跑完之前又问不出这一轮会不会有过程，
 * 挂早了没调工具的一轮也顶着一行，挂晚了是开口、调工具时突然冒出来。所以那一行只在跑完时出现，说的是
 * 里面有什么，不计时。
 *
 * 跑完收起曾经因为「一整段内容在眼前塌掉」被删过（dfc96aa9）。现在收的时候回答钉在原地（`onSettle`），
 * 收起的内容贴着下沿、从上往下被吃掉，变化都在回答上方。对话短到收起后不满一屏时回答仍会往上走：内容从
 * 顶上排，下面没东西撑着。
 *
 * 每一行各自一个带 key 的盒子：一句中途说的话，说出来的时候站在回答的位置上，模型接着干活它就成了过程的
 * 一部分——位置不变，不卸掉重建。收起的那几行在收的那一刻换进折叠区，是重挂的，可它们正要被收走。
 */
export function TurnWork({ entries, fold, live = false, stateKey, onSettle }: {
	/** 这一轮里的每一行。 */
	entries: TurnEntry[];
	/** 跑完收起的那一段说什么；不给就不收（子智能体面板）。 */
	fold?: TurnFold | null;
	/** 这一轮还在跑。从跑着变成跑完的那一下，收起是有动画的；打开会话时跑完的轮直接是收着的。 */
	live?: boolean;
	stateKey?: string;
	/** 跑完收起之前，回答那一行此刻在哪：交给转录把它按住。 */
	onSettle?: (answer: HTMLElement) => void;
}) {
	const box = useRef<HTMLDivElement>(null);
	const first = fold ? entries.findIndex((entry) => entry.folded) : -1;
	/*
	 * 刚跑完记在 state 里，不记在 ref 里：开发时 StrictMode 把渲染跑两遍，渲染出错时 React 也会同步重来
	 * 一遍，改 ref 的写法第二遍就读到「早就跑完了」，收起没了过渡。
	 *
	 * 回答的位置在换的那一次渲染里读：读的是屏幕上还挂着的旧样子。等到提交以后，那一行已经被上面多出来的
	 * 一行挤下去了。读两遍按的是同一个位置，不碍事。
	 */
	const [wasLive, setWasLive] = useState(live);
	const [settling, setSettling] = useState(false);
	if (wasLive !== live) {
		setWasLive(live);
		setSettling(wasLive && !live && first >= 0);
		if (wasLive && !live && first >= 0 && onSettle) {
			const key = entries.find((entry) => entry.answer)?.key;
			// 按住里面那一行，不按外面这层：这层的行距在收起后会变（紧跟那一行的不再垫 `pt-2.5`），按它就差 10px。
			const answer = [...(box.current?.children ?? [])].find((el) => el.getAttribute("data-ly-entry") === key)?.firstElementChild;
			// 藏着的会话（Activity）量不到位置，按住只会按到 0 上。
			if (answer instanceof HTMLElement && answer.getClientRects().length > 0) onSettle(answer);
		}
	}

	const row = (entry: TurnEntry, index: number) => (
		// 第一行贴着上面那行，和一句回答离它同一个距离。里面那行什么也没画出来（一条空正文的回复），
		// 这层行距跟着不要，否则看不见的一行在两行之间多空出 10px。
		<div key={entry.key} data-ly-entry={entry.key} className={index === 0 ? "has-[>:empty]:hidden" : "pt-2.5 has-[>:empty]:hidden"}>
			{entry.node}
		</div>
	);
	return (
		// `group/turn`：收尾那句的页脚单独成行时（`Run.trailer`）跟着整轮悬停显出来。
		<div ref={box} data-ly-turn-process className="group/turn">
			{first < 0 || !fold ? entries.map(row) : [
				...entries.slice(0, first).map(row),
				<div key="fold" className={first === 0 ? "" : "pt-2.5"}>
					<TurnFoldRow fold={fold} stateKey={stateKey} settling={settling}>
						{entries.filter((entry) => entry.folded).map(row)}
					</TurnFoldRow>
				</div>,
				// 紧跟那一行的不再垫行距：那一行自己带着下面的空（见 `TurnFoldRow`）。
				...entries.slice(first).filter((entry) => !entry.folded).map((entry, index) => row(entry, index)),
			]}
		</div>
	);
}

/**
 * 收起的那一行，照 Lyra 折叠行的样子：图标、里面有什么、箭头。点开是挂在一条竖线上的原样那几行。
 *
 * 不计时：试过「已工作 2m 14s」的锚，说的是花了多久，而人想知道的是里面做了什么。
 *
 * `settling`：这一轮刚在眼前跑完。先照原样展开着挂上，下一帧再收——直接挂成收着的就没有过渡，是一帧之间
 * 整段消失。收的时候内容贴着下沿（`ly-reveal-end`），和回答钉在原地是一回事：被吃掉的是离回答远的那头。
 */
function TurnFoldRow({ fold, stateKey, settling, children }: {
	fold: TurnFold;
	stateKey?: string;
	settling: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useTranscriptDisclosure(stateKey);
	const [closing, setClosing] = useState(settling);
	const [fromEnd, setFromEnd] = useState(settling);
	// 那一行正在从 0 长出来：这时裁掉溢出，长完放开，焦点框不被裁。减弱动效时没有过渡、也等不到 transitionend。
	const [growing, setGrowing] = useState(() => settling && !motionReduced());
	useEffect(() => {
		if (!closing) return;
		// 两帧：第一帧让展开着的样子先算出来，过渡才有起点。
		let frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => setClosing(false));
		});
		return () => cancelAnimationFrame(frame);
	}, [closing]);

	const shown = open || closing;
	const toggle = () => {
		setFromEnd(false);
		setClosing(false);
		setOpen((value) => !value);
	};
	const parts = [describeCalls(fold.calls)];
	if (fold.thought > 0) parts.unshift(translate("step.thinking", { n: fold.thought }));
	/*
	 * 竖线只在人点开时画。收的那一下不画：内容一换进缩进 22px 的竖线里，长句子多折一行，回答在收起开始的
	 * 那一帧被往下挤（量到 25px）。
	 */
	const rail = !fromEnd;
	return (
		<div data-ly-turn-fold={shown ? "open" : "closed"}>
			{/*
			 * 刚跑完时这一行连同它下面的空从 0 长出来，和下面的收起走同一个钟：两头加起来高度连续，回答不会先被
			 * 往下挤一截再滑回来（直接挂上时量到 34px）。所以下面的空归这一行（`pb-2.5`），收起的内容自己带着
			 * 和回答之间的空：挂上那一帧和收起之前逐像素相同。
			 */}
			{/* `minmax(0, 1fr)`：网格列默认按内容的最小宽度撑，不换行的长摘要会把这一行撑出整列、箭头被裁掉。 */}
			<div
				className="grid grid-cols-[minmax(0,1fr)]"
				style={{ gridTemplateRows: closing ? "0fr" : "1fr", transition: growing ? "grid-template-rows var(--ly-t-slow) var(--ly-e-out)" : undefined }}
				onTransitionEnd={(event) => {
					if (event.target === event.currentTarget) setGrowing(false);
				}}
			>
				<div className={growing ? "min-h-0 overflow-hidden" : "min-h-0"}>
					<div className="pb-2.5">
						{/* 和正文一样宽：一轮做的事多时超出整列的化开，鼠标放上去自己读出来（`FlowRow`）。 */}
						<FlowRow
							icon={<Layers size={13} strokeWidth={1.8} className="shrink-0" />}
							summary={parts.join(translate("step.separator"))}
							open={shown}
							onToggle={toggle}
							label={translate("turnFold.label")}
						/>
					</div>
				</div>
			</div>
			<Collapse open={shown} className={fromEnd ? "ly-reveal-end" : ""} bodyClassName="pb-2.5">
				{/* 竖线在行首图标的正下方，和一段活点开时同一种挂法。 */}
				<div data-ly-turn-fold-rail="" className={rail ? "ml-[7px] flex flex-col border-l border-line-soft pl-[14px]" : "flex flex-col"}>
					{children}
				</div>
			</Collapse>
		</div>
	);
}
