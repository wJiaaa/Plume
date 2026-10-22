import { useLayoutEffect, useState } from "react";

import { motionReduced } from "../../ui/motion/reduced.ts";
import { RunningIndicator } from "./RunningIndicator.tsx";

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
 * 挂在结论底下的话，表格、代码块每长出一截它就被推下去一截，一跳一跳的。不在第一个字就藏：那时分不清
 * 是结论还是调工具前的一句开场白，藏了的话开场白一出来它就消失、工具调用到了才回来。
 *
 * 看不见是当帧的，不淡出：淡出的那 150ms 里，人看到的是字底下冒出来一行，又跟着转录往上滑着消失。
 * 工具调用接上来、它重新出现时照旧淡入。
 *
 * 回答写完（`answered`）以后它先只是看不见，等 `running` 落下那一次提交才当帧收起，不走过渡：
 * 回答底下那一行时间和复制按钮也是等 `running` 落下才长出来的（一轮没结束谁是最后一句还没定，
 * 见 `Conversation` 里的 `continued`），两者在同一次提交里一出一进。两者一样高（都是 28px，
 * 见 `RunningIndicator` 的上边距），转录一像素也不动。操作行这时也不演进场（见 `MessageRow` 的
 * `watched`）：演的话它从 0 慢慢长，这一行却当帧没了，转录先掉一行再被顶回来。
 * 在 `answered` 那一次就收的话，中间隔着一次提交，贴底的转录同样先掉下去一行、再被操作行顶回来；
 * 慢慢收的话，刚读完的那段话会先被操作行顶上去、再随着这一行变矮往下沉。
 */
export function RunningRow({ running, answering, answered, compacting }: {
	running: boolean;
	answering: boolean;
	/** 最后一条是一段正常写完的回答。收尾时消息先定稿，`running` 晚一次提交才落下。 */
	answered: boolean;
	compacting: boolean;
}) {
	const open = running && !compacting;
	/*
	 * 收起时沿用收起前那一刻的隐/显。结论写到一半被停下（或开始压缩）时这一行正隐着，`open` 一落、
	 * 只按 `open && …` 算的话它就不再隐，于是在往下收的那 300ms 里把「Thinking…」淡入回来——
	 * 人刚按了停止，看到的却是它又在想。收完、指示器卸掉以后才放开，下一轮展开时照旧。
	 */
	const quietNow = open && (answering || answered);
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
			style={answered ? { transition: "none" } : undefined}
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
}
