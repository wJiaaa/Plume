import { useEffect } from "react";
import { Layers } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { useScopedSessionId, useScopedFromToolRuns } from "../../app/session-scope.tsx";
import { useApp } from "../../store/index.ts";
import { toggleEnvironmentCard, useEnvironmentCard } from "../../store/environment-card.ts";
import { pendingSuggestions, useDismissedSuggestions } from "../../store/session-suggestions.ts";
import { attachWakeups, useWakeups, wakeupsOf } from "../../store/session-wakeups.ts";
import { attachMonitors, monitorsOf, useMonitors } from "../../store/session-monitors.ts";
import { ToolbarButton } from "../../app/window/WindowControls.tsx";

/**
 * 标题栏上开关环境卡片的那颗。
 *
 * 和旁边几颗「只管打开」的面板按钮不同，它是开关，开着就亮：卡片就在按钮正下方，亮着的按钮和
 * 看得见的卡片说的是同一件事。
 *
 * 卡片收着、里面又有建议的新会话在等人决定时，按钮上挂一个圆点：建议不拦着这一轮，对话里那一行
 * 很快就滚走了，不说一声就等于藏起来。人把那一节关掉了就不再提醒。待触发的定时唤醒同理：它们过一会儿
 * 会自己开一轮，人该知道还挂着几个。在跑的 `monitor` 也是：有输出就叫醒会话。
 */
export function EnvironmentToggle() {
	const { t } = useI18n();
	const open = useEnvironmentCard((state) => state.open);
	const sectionHidden = useEnvironmentCard((state) => state.hidden.includes("suggestions"));
	const sessionId = useScopedSessionId();
	const sessions = useApp((s) => s.sessions);
	const dismissed = useDismissedSuggestions((s) => s.ids);
	// 数，不是记录表：订阅整张表的话，命令每吐一块输出这颗按钮就重画一次。
	const waiting = useScopedFromToolRuns((runs) => (!open && !sectionHidden && sessionId ? pendingSuggestions(runs, sessions, sessionId, dismissed).length : 0));
	const wakeupsHidden = useEnvironmentCard((state) => state.hidden.includes("wakeups"));
	const scheduled = useWakeups((state) => (!open && !wakeupsHidden ? wakeupsOf(state, sessionId).length : 0));
	const jobsHidden = useEnvironmentCard((state) => state.hidden.includes("jobs"));
	const monitors = useMonitors((state) => (!open && !jobsHidden ? monitorsOf(state, sessionId) : 0));
	// 表只在主进程里，窗口刚开、会话刚换过来时还没听到过它的事件：问一次。
	useEffect(() => {
		if (!sessionId) return;
		attachWakeups(sessionId);
		attachMonitors(sessionId);
	}, [sessionId]);
	const label = [
		t("environment.title"),
		...(waiting ? [t("environment.pendingSuggestions", { n: waiting })] : []),
		...(scheduled ? [t("environment.pendingWakeups", { n: scheduled })] : []),
		...(monitors ? [t("environment.runningMonitors", { n: monitors })] : []),
	].join(" · ");
	return (
		<ToolbarButton label={label} active={open} onClick={toggleEnvironmentCard}>
			<span data-ly-environment-toggle className="relative flex items-center justify-center">
				<Layers size={13} strokeWidth={1.9} />
				{waiting + scheduled + monitors > 0 && <span aria-hidden data-ly-environment-dot className="absolute -top-1 -right-1.5 h-1.5 w-1.5 rounded-full bg-accent" />}
			</span>
		</ToolbarButton>
	);
}
