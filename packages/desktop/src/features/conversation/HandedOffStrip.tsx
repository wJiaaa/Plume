/**
 * 输入框上方那一条：这个会话交出去的会话此刻怎么样了。
 *
 * 计划交给新会话以后，主会话就停在那里，人盯着的是这个对话；那边在读什么、跑什么，不该要人去侧栏里找。
 * 它不画在转录里：转录记的是这个会话说过、做过的事，那边的进度不是这里发生的，钉在一处、聊到哪都看得见。
 * 只说一句（`session-doing.ts`），不画过程——过程在那个会话自己的转录里，点过去就是。
 *
 * 外观跟着输入框上方的清单走（`TaskList` 的 inline）：同样的圆角、细边、一行 36px，不另加阴影。
 */

import { memo, useMemo, useRef } from "react";
import { focusScreenOf, useScopedSessionId } from "../../app/session-scope.tsx";
import { translate } from "../../i18n/translate.ts";
import { useApp } from "../../store/index.ts";
import { useSessionDoing } from "../../store/session-doing.ts";
import { ChevronRight } from "../../ui/icons/index.ts";
import { GLIDE, useTickedAnimations } from "../../ui/motion/ticked.ts";
import { ScrollText } from "../../ui/scroll/ScrollText.tsx";
import { handedOffFrom, type HandedOff } from "./handed-off.ts";
import { SessionStatus } from "./SessionStatus.tsx";

const SAYS = { waiting: "sessionStatus.waiting", done: "sessionStatus.done", failed: "sessionStatus.failed" } as const;

// 父级也画转录，每个流式 tick 都重画；它自己只在名单变了时重画。
export const HandedOffStrip = memo(function HandedOffStrip() {
	const sessionId = useScopedSessionId();
	// 拼成串，selector 才能按值比较：会话列表每变一次都是新数组，这一条不跟着重画。
	const key = useApp((s) => JSON.stringify(handedOffFrom(s.sessions, s.activity, sessionId)));
	const rows = useMemo(() => JSON.parse(key) as HandedOff[], [key]);
	if (!sessionId || rows.length === 0) return null;
	return (
		<div data-ly-handed-off="" className="ly-enter divide-y divide-line-soft overflow-hidden rounded-xl border border-line-soft bg-card/40">
			{rows.map((row) => <Row key={row.id} row={row} parentId={sessionId} />)}
		</div>
	);
});

function Row({ row, parentId }: { row: HandedOff; parentId: string }) {
	const running = row.activity === "running";
	const doing = useSessionDoing((s) => (running ? s.bySession[row.id] : undefined));
	const state = running ? doing : translate(SAYS[row.activity as keyof typeof SAYS]);
	// 扫光按拍走，和转录里的运行行一样（`ticked.ts`）：每帧推会让整页跟着重画。
	const said = useRef<HTMLSpanElement>(null);
	useTickedAnimations(said, GLIDE, running);
	const open = () => {
		// 分屏时这个对话可能在没聚焦的那一边：在它所在的那一屏打开。
		if (parentId !== useApp.getState().activeSessionId) focusScreenOf(parentId);
		void useApp.getState().openSessionById(row.id);
	};
	return (
		<button type="button" onClick={open} data-ly-handed-off-row={row.id} aria-label={state ? `${row.title} · ${state}` : row.title}
			className="ly-scroll flex h-9 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-card-hover">
			<SessionStatus activity={row.activity} />
			<ScrollText text={row.title} className="ly-fade-tail max-w-[45%] shrink-0 text-label text-ink-muted" />
			<span ref={said} className="min-w-0 flex-1" data-ly-handed-off-state="">
				{state && <ScrollText text={state} className="ly-fade-tail text-label text-ink-faint" textClassName={running ? "ly-glide" : ""} />}
			</span>
			<ChevronRight size={12} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
		</button>
	);
}
