import { Activity, useLayoutEffect, useRef, type ReactNode } from "react";

import { finishReplayedAnimations } from "../../ui/layout/RetainedViews.tsx";

/**
 * 侧边聊天在后台标签里时整个停下：不订阅 store、不跑逐帧放字和跟随滚动、不排版。
 *
 * 面板本身只是透明加 `inert`（见 `DockPane`），那样藏着的对话照样跟着每个 token 重画、排版：主会话加
 * 三个侧边聊天（两个在后台）时渲染进程 96%，只开一个是 60%。这里换成 `Activity`，和主区的
 * `RetainedViews` 一样：局部状态、草稿、滚动位置都留着，回来时离开期间写下的字直接画出来
 * （`useArrival`），挂着的 CSS 动画不重演。
 *
 * 只给侧边聊天用。`DockPane` 不用 `display: none` 的理由——终端的网格会失效——对终端仍然成立。
 */
export function RetainedPanel({ hidden, children }: { hidden: boolean; children: ReactNode }) {
	const box = useRef<HTMLDivElement>(null);
	const wasHidden = useRef(hidden);
	useLayoutEffect(() => {
		const returning = wasHidden.current && !hidden;
		wasHidden.current = hidden;
		const element = box.current;
		if (!returning || !element) return;
		// 下一帧之前做：重新订阅 store 补进来的那次提交排在显示它的这次之后，见 `finishReplayedAnimations`。
		const frame = requestAnimationFrame(() => finishReplayedAnimations(element));
		return () => cancelAnimationFrame(frame);
	}, [hidden]);
	return (
		<Activity mode={hidden ? "hidden" : "visible"}>
			<div ref={box} className="flex min-h-0 min-w-0 flex-1 flex-col">
				{children}
			</div>
		</Activity>
	);
}
