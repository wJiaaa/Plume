import { memo, useEffect, useLayoutEffect, useState } from "react";

import { motionReduced } from "../../ui/motion/reduced.ts";
import { RunningIndicator } from "./RunningIndicator.tsx";

/**
 * 结论停多久，运行行回来。
 *
 * 正文显示比到达最晚慢 700ms（`stream-pace.ts` 的 `MAX_LAG`），2 秒是等屏幕上的字也停稳了再出来；
 * 再短，服务商一阵一停的正常节奏会让它在结论底下一闪一闪。
 */
export const STALL_MS = 2000;

/**
 * The 「运行中」 line under the transcript, folding in and out with the turn.
 *
 * What it shows outlives the turn by one fold. The row's `data-open` and its content used to be the
 * same condition, so a turn that ended without prose — only tools, stopped, failed — or a compaction
 * starting emptied the row in the frame the fold began: the fold had nothing left to animate, and a
 * transcript pinned to the bottom dropped the row's whole height at once. Now the indicator stays
 * until the fold has finished, and only then goes.
 *
 * 结论流进来时它只是看不见，位置照旧占着（`answering`，判据见 client-runtime 的 `looksLikeAnswer`）。
 * 挂在结论底下的话，表格、代码块每长出一截它就被推下去一截，一跳一跳的。这一轮调工具之前的话也藏
 * （`leadsTheTurn`）：那时分不清是结论还是开场白，可不藏的话第一个字一来它就被推下去一行；开场白的
 * 代价是它消失一下、调用开始时淡入回来，比跳两次轻。调过工具以后的开场白不藏，理由见 `leadsTheTurn`。
 *
 * 看不见是当帧的，不淡出：淡出的那 150ms 里，人看到的是字底下冒出来一行，又跟着转录往上滑着消失。
 * 工具调用接上来、它重新出现时照旧淡入。
 *
 * 结论停住了（`grewAt` 起有 `STALL_MS` 没长）它也回来：藏它是怕它跟着字跳，字不动就没什么可跳的；
 * 而一直藏着的话，一段写得慢的结论从第一段末尾到写完，屏幕上不说耗时、不说速度，也看不出是在写还是
 * 卡住了。字一接着长，当帧又藏回去。正文已经写完、在等这条回复收尾的那一两秒不算停住（`grewAt` 是空的），
 * 不然它在结尾冒一下、接着被页脚顶掉。
 *
 * 回答写完（`answered`）以后它先只是看不见，等 `running` 落下那一次提交才当帧收起，不走过渡：
 * 回答底下那一行时间和复制按钮也是等 `running` 落下才长出来的（一轮没结束谁是最后一句还没定，
 * 见 `Conversation` 里的 `continued`），两者在同一次提交里一出一进。两者一样高（都是 28px，
 * 见 `RunningIndicator` 的上边距），转录一像素也不动。操作行这时也不演进场（见 `MessageRow` 的
 * `watched`）：演的话它从 0 慢慢长，这一行却当帧没了，转录先掉一行再被顶回来。
 * 在 `answered` 那一次就收的话，中间隔着一次提交，贴底的转录同样先掉下去一行、再被操作行顶回来；
 * 慢慢收的话，刚读完的那段话会先被操作行顶上去、再随着这一行变矮往下沉。
 *
 * 展开是当帧的，只淡入：发送时这一行和那条消息在同一次提交里出现，转录当帧贴底（`Conversation` 的
 * `returnToBottom(true)`）。高度慢慢长的话，贴底的转录跟着它往上滑，刚发出去的消息先落定、又被顶上去一截。
 */
// 按 props 记住：它和转录挂在同一个组件里，转录流式输出时每一拍都重画。
export const RunningRow = memo(function RunningRow({ running, answering, grewAt, answered, compacting }: {
	running: boolean;
	answering: boolean;
	/** 末尾那段正文上一次变长的时刻（`proseGrewAt`）；没在写、或者已经写完，是 `undefined`。 */
	grewAt: number | undefined;
	/** 最后一条是一段正常写完的回答。收尾时消息先定稿，`running` 晚一次提交才落下。 */
	answered: boolean;
	compacting: boolean;
}) {
	const open = running && !compacting;
	const stalled = useStalled(grewAt, open && answering);
	/*
	 * 收起时沿用收起前那一刻的隐/显。结论写到一半被停下（或开始压缩）时这一行正隐着，`open` 一落、
	 * 只按 `open && …` 算的话它就不再隐，于是在往下收的那 300ms 里把「Thinking…」淡入回来——
	 * 人刚按了停止，看到的却是它又在想。收完、指示器卸掉以后才放开，下一轮展开时照旧。
	 */
	const quietNow = open && ((answering && !stalled) || answered);
	const [foldQuiet, setFoldQuiet] = useState(quietNow);
	if (open && foldQuiet !== quietNow) setFoldQuiet(quietNow);
	const [retained, setRetained] = useState(open);
	const quiet = open ? quietNow : foldQuiet && retained;
	useLayoutEffect(() => {
		if (open) setRetained(true);
		else if (answered || motionReduced()) setRetained(false);
	}, [open, answered]);
	// A hidden `Activity` cancels the fold before its `transitionend`; see the same release in `Collapse`.
	useLayoutEffect(() => () => setRetained(false), []);
	return (
		<div
			className="ly-reveal"
			data-open={open}
			aria-hidden={!open || quiet}
			// 过渡按变化之后的样式取：打开时只剩透明度，收起时回到 `.ly-reveal` 的整套。
			style={answered ? { transition: "none" } : open ? { transition: "opacity var(--ly-t-base) var(--ly-e-out)" } : undefined}
			onTransitionEnd={(event) => {
				if (event.target === event.currentTarget && event.propertyName === "grid-template-rows" && !open) setRetained(false);
			}}
		>
			<div>
				<div
					data-ly-running-quiet={quiet || undefined}
					className={`transition-opacity ${quiet ? "opacity-0 duration-0" : "duration-[var(--ly-t-base)]"}`}
				>
					{(open || retained) && <RunningIndicator />}
				</div>
			</div>
		</div>
	);
});

/**
 * 从 `grewAt` 起已经过了 `STALL_MS`。
 *
 * 判断在渲染时现读时钟：字一长，`grewAt` 换成新的时刻，同一次渲染里就不再算停，不用等 effect 再提交一次——
 * 那一次提交里新的字已经画出来，运行行还挂在它底下。停住那一刻 store 里什么都不变，所以由计时器叫醒一次。
 */
function useStalled(grewAt: number | undefined, watching: boolean): boolean {
	const [, wake] = useState(0);
	useEffect(() => {
		if (!watching || grewAt === undefined) return;
		const left = STALL_MS - (Date.now() - grewAt);
		if (left <= 0) return;
		const timer = setTimeout(() => wake((n) => n + 1), left);
		return () => clearTimeout(timer);
	}, [grewAt, watching]);
	return watching && grewAt !== undefined && Date.now() - grewAt >= STALL_MS;
}
