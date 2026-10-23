/**
 * 「定时唤醒」：模型给这个对话安排的以后再接着做（`schedule_wakeup`、`cron_create`），还没触发的那些。
 *
 * 对话里那次工具调用很快就被顶上去了，而它说的事要几分钟、几小时后才发生——这一节回答「它还会不会
 * 自己动起来、什么时候」，每一项都能当场取消。表在主进程的会话内存里，节底那一句说清楚：退出应用、
 * 按停止都会让它们没了。卡片收着时由标题栏按钮上的圆点提醒（`EnvironmentToggle`）。
 */

import type { SessionWakeup } from "@plume/core";
import { useI18n } from "../../i18n/index.ts";
import { formatDate } from "../../lib/date-format.ts";
import { useApp } from "../../store/index.ts";
import { cancelWakeup, useWakeups, wakeupsOf } from "../../store/session-wakeups.ts";
import { AlarmClock, X } from "../../ui/icons/index.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { Section, SectionLabel } from "./rows.tsx";

/** 今天的只写时刻，别的日子带上日期。 */
function when(at: number, locale: string): string {
	const sameDay = new Date(at).toDateString() === new Date().toDateString();
	return formatDate(at, locale, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 和送达那一行同一句：唤醒写了理由用理由，否则是 prompt 的第一行。 */
function labelOf(wakeup: SessionWakeup): string {
	return wakeup.reason?.trim() || (wakeup.prompt.split("\n").find((line) => line.trim()) ?? "").trim();
}

export function WakeupsSection({ sessionId }: { sessionId: string }) {
	const { t } = useI18n();
	const wakeups = useWakeups((state) => wakeupsOf(state, sessionId));
	if (!wakeups.length) return null;
	return (
		<Section name="wakeups">
			<SectionLabel>{t("wakeups.title")}</SectionLabel>
			{wakeups.map((wakeup) => (
				<Pending key={wakeup.id} sessionId={sessionId} wakeup={wakeup} />
			))}
			<p className="px-2 pt-0.5 pb-1 text-caption text-ink-faint" data-ly-wakeups-note>
				{t("wakeups.memoryOnly")}
			</p>
		</Section>
	);
}

function Pending({ sessionId, wakeup }: { sessionId: string; wakeup: SessionWakeup }) {
	const { t, resolvedLocale } = useI18n();
	const cancel = () => {
		void cancelWakeup(sessionId, wakeup.id).catch((error: unknown) => useApp.getState().notify(String(error), "error"));
	};
	const meta = [
		when(wakeup.nextAt, resolvedLocale),
		wakeup.recurring ? t("wakeups.recurring") : t("wakeups.once"),
		...(wakeup.expiresAt !== undefined ? [t("wakeups.expires", { time: when(wakeup.expiresAt, resolvedLocale) })] : []),
	].join(" · ");
	return (
		<div data-ly-environment-wakeup={wakeup.id} data-recurring={wakeup.recurring ? "" : undefined} className="flex items-start gap-2 rounded-lg px-2 py-1.5">
			<AlarmClock size={14} strokeWidth={1.8} aria-hidden className="mt-[3px] shrink-0 text-ink-muted" />
			{/* 悬停读到完整的 prompt 和 cron 表达式：行里只放得下一句。 */}
			<div className="min-w-0 flex-1" data-ly-tip={wakeup.cron ? `${wakeup.cron}\n${wakeup.prompt}` : wakeup.prompt}>
				<p className="truncate text-label text-ink" data-ly-wakeup-label>
					{labelOf(wakeup)}
				</p>
				<p className="mt-0.5 truncate text-caption tabular-nums text-ink-muted" data-ly-wakeup-meta>
					{meta}
				</p>
			</div>
			<IconButton size="xs" label={t("wakeups.cancel")} icon={<X size={12} strokeWidth={1.9} />} onClick={cancel} data-ly-wakeup-cancel />
		</div>
	);
}
