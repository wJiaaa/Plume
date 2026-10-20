import { useI18n } from "../../i18n/index.ts";
import { heatLevel, monthLabels, type DayUsage } from "./usage-heatmap.ts";

const SHADES = ["bg-ink/[0.06]", "bg-accent/25", "bg-accent/45", "bg-accent/70", "bg-accent"] as const;

/** 一年的格子。按什么上色、气泡里写什么由调用方给：可以是 token、请求数或费用。 */
export function Heatmap({ grid, value, tip }: { grid: DayUsage[][]; value: (day: DayUsage) => number; tip: (day: DayUsage) => string }) {
	const { t } = useI18n();
	const labels = monthLabels(grid);
	const busiest = Math.max(0, ...grid.flat().map(value));
	return <div className="flex w-full overflow-x-auto [justify-content:safe_center]" dir="rtl"><div dir="ltr" className="inline-block py-1"><div className="relative mb-1 h-[14px]">{labels.map((label) => <span key={label.column} className="absolute top-0 text-detail text-ink-faint" style={{ left: label.column * 14 }}>{label.text}</span>)}</div><div className="flex gap-[3px]">{grid.map((week) => <div key={week[0]?.key} className="flex flex-col gap-[3px]">{week.map((day) => { const future = day.date.getTime() > Date.now(); return <span key={day.key} data-ly-tip={future ? undefined : tip(day)} data-ly-tip-side="top" className={`h-[11px] w-[11px] rounded-xs transition-colors duration-[var(--ly-t-quick)] ${future ? "opacity-40" : ""} ${SHADES[heatLevel(value(day), busiest)]}`} />; })}</div>)}</div><div className="mt-2.5 flex items-center justify-end gap-1 text-detail text-ink-faint"><span className="mr-1">{t("usage.less")}</span>{SHADES.map((shade, index) => <span key={shade} className={`h-[11px] w-[11px] rounded-xs ${shade}`} aria-label={t("usage.bucket", { index })} />)}<span className="ml-1">{t("usage.more")}</span></div></div></div>;
}
