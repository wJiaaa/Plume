import { useI18n, type MessageKey } from "../../i18n/index.ts";
import { ChartPie, Clock } from "../../ui/icons/index.ts";
import { SkeletonBar } from "../../ui/primitives/Skeleton.tsx";
import { Card, EmptyHint } from "./controls.tsx";
import { TOKEN_PARTS, timeSegments, tokenSegments, type ActivityTotals, type Segment, type TokenPart } from "./usage-activity.ts";
import { formatCompact, formatDuration } from "./usage-format.ts";
import type { RequestTotals } from "./usage-requests.ts";

const RADIUS = 46;
const STROKE = 12;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** 环在页面上的边长，viewBox 是 120。骨架按同一个数画圈，数据到了圈不挪。 */
const SIZE = 132;

function percent(value: number, total: number): string {
	const share = total > 0 ? (value / total) * 100 : 0;
	if (share <= 0) return "0%";
	// 有、但不到千分之一：写成 0.0% 读起来是「一点都没有」。
	if (share < 0.05) return "<0.1%";
	return `${share.toFixed(share < 10 ? 1 : 0)}%`;
}

/** 一圈分段。段与段之间留一道缝，相邻两段同色系时也分得开；太小的段只画缝不画色。 */
function Donut({ segments, total, value, label }: { segments: Segment[]; total: number; value: string; label: string }) {
	const gap = segments.filter((each) => each.value > 0).length > 1 ? 2 : 0;
	let offset = 0;
	return (
		<div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
			<svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden="true">
				<circle cx="60" cy="60" r={RADIUS} fill="none" strokeWidth={STROKE} className="stroke-ink/[0.06]" />
				{segments.map((each) => {
					const length = total > 0 ? (each.value / total) * CIRCUMFERENCE : 0;
					const start = offset;
					offset += length;
					if (length <= gap) return null;
					return <circle key={each.key} data-donut-segment={each.key} cx="60" cy="60" r={RADIUS} fill="none" strokeWidth={STROKE} stroke={each.color} strokeDasharray={`${length - gap} ${CIRCUMFERENCE}`} strokeDashoffset={-start} />;
				})}
			</svg>
			<div className="absolute inset-0 flex flex-col items-center justify-center">
				<div className="text-[17px] leading-tight font-semibold tracking-[-0.02em] text-ink tabular-nums">{value}</div>
				<div className="mt-0.5 text-detail text-ink-faint">{label}</div>
			</div>
		</div>
	);
}

function Legend({ rows }: { rows: { key: string; color: string; label: string; share: string; detail: string }[] }) {
	return (
		<div className="grid min-w-0 flex-1 grid-cols-1 gap-x-6 gap-y-3 @xl:grid-cols-2">
			{rows.map((row) => (
				<div key={row.key} data-usage-legend={row.key} className="min-w-0">
					<div className="flex items-center gap-2 text-label">
						<span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: row.color }} />
						<span className="min-w-0 flex-1 truncate text-ink">{row.label}</span>
						<span className="shrink-0 font-medium text-ink tabular-nums">{row.share}</span>
					</div>
					<div className="mt-0.5 ml-4 truncate text-detail text-ink-faint tabular-nums">{row.detail}</div>
				</div>
			))}
		</div>
	);
}

const TOKEN_LABELS: Record<TokenPart, MessageKey> = {
	system: "usage.tokenSystem",
	instructions: "usage.tokenInstructions",
	skills: "usage.tokenSkills",
	toolDefs: "usage.tokenToolDefs",
	user: "usage.tokenUser",
	injected: "usage.tokenInjected",
	assistant: "usage.tokenAssistant",
	toolResults: "usage.tokenToolResults",
	outputThinking: "usage.tokenOutputThinking",
	outputReply: "usage.tokenOutputReply",
};

const TIME_LABELS: Record<string, MessageKey> = {
	wait: "usage.timeWait",
	thinking: "usage.timeThinking",
	reply: "usage.timeReply",
	tool: "usage.timeTool",
};

/** 环图那两张卡片：这些 token 是什么、这些时间花在哪。 */
export function UsageBreakdown({ tokens, activity }: { tokens: RequestTotals; activity: ActivityTotals }) {
	const { t } = useI18n();
	const tokenParts = tokenSegments(activity);
	const tokenTotal = tokenParts.reduce((sum, each) => sum + each.value, 0);
	const cacheInput = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	const timeParts = timeSegments(activity);
	const timeTotal = timeParts.reduce((sum, each) => sum + each.value, 0);
	const timeDetail: Record<string, string> = {
		wait: [formatDuration(timeParts[0].value), t("usage.timesCount", { n: activity.timedReplies.toLocaleString() })].join(" · "),
		thinking: formatDuration(activity.thinkingMs),
		reply: formatDuration(timeParts[2].value),
		tool: [formatDuration(activity.toolMs), t("usage.timesCount", { n: activity.tools.toLocaleString() }), ...(activity.toolErrors > 0 ? [t("usage.toolFailed", { n: activity.toolErrors })] : [])].join(" · "),
	};
	const counts = [
		activity.archived > 0 ? t("usage.sessionsArchived", { n: activity.sessions, archived: activity.archived }) : t("usage.sessionsCount", { n: activity.sessions }),
		t("usage.turnsCount", { n: activity.turns.toLocaleString() }),
		t("usage.toolCallsCount", { n: activity.tools.toLocaleString() }),
	];

	return (
		<div className="mt-3 grid gap-3 @4xl:grid-cols-2" data-usage-breakdown="true">
			<Card className="flex flex-col p-4" data-usage-token-breakdown="true">
				<div className="text-label font-medium text-ink">{t("usage.tokenBreakdown")}</div>
				<div className="mt-0.5 text-detail text-ink-faint">{t("usage.tokenBreakdownDetail")}</div>
				{tokenTotal === 0 ? (
					<EmptyHint icon={ChartPie}>{t("usage.noRequests")}</EmptyHint>
				) : (
					<div className="mt-4 flex flex-1 items-center gap-6">
						<Donut segments={tokenParts} total={tokenTotal} value={formatCompact(tokenTotal)} label={t("usage.tokenAll")} />
						<Legend rows={tokenParts.map((each) => ({ key: each.key, color: each.color, label: t(TOKEN_LABELS[each.key as TokenPart]), share: percent(each.value, tokenTotal), detail: each.value > 0 ? `≈${formatCompact(each.value)}` : "0" }))} />
					</div>
				)}
				{/* 缓存这一维换了个来源：账单上的实数，和顶上的命中率同一个口径。 */}
				{tokenTotal > 0 && cacheInput > 0 && (
					<div className="mt-4 text-detail text-ink-faint tabular-nums" data-usage-cache-split="true">
						{t("usage.tokenCacheSplit", { read: percent(tokens.cacheRead, cacheInput), write: percent(tokens.cacheWrite, cacheInput), fresh: percent(tokens.input, cacheInput) })}
					</div>
				)}
			</Card>
			<Card className="flex flex-col p-4" data-usage-time-breakdown="true">
				<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
					<div className="text-label font-medium text-ink">{t("usage.timeBreakdown")}</div>
					<div className="text-detail text-ink-muted tabular-nums" data-usage-activity-counts="true">{counts.join(" · ")}</div>
				</div>
				<div className="mt-0.5 text-detail text-ink-faint">{t("usage.timeBreakdownDetail")}</div>
				{timeTotal === 0 ? (
					<EmptyHint icon={Clock}>{t("usage.noActivity")}</EmptyHint>
				) : (
					<div className="mt-4 flex flex-1 items-center gap-6">
						<Donut segments={timeParts} total={timeTotal} value={formatDuration(timeTotal)} label={t("usage.timeAll")} />
						<Legend rows={timeParts.map((each) => ({ key: each.key, color: each.color, label: t(TIME_LABELS[each.key]), share: percent(each.value, timeTotal), detail: timeDetail[each.key] }))} />
					</div>
				)}
			</Card>
		</div>
	);
}

/** 环的那一圈：内外径照 `RADIUS ± STROKE / 2` 换算到页面上，挖空的中间用遮罩而不是盖一块底色，两种主题下都不露边。 */
const RING_MASK = (() => {
	const scale = SIZE / 120;
	const inner = (RADIUS - STROKE / 2) * scale;
	const outer = (RADIUS + STROKE / 2) * scale;
	return `radial-gradient(circle, transparent ${inner}px, #000 ${inner + 0.5}px, #000 ${outer}px, transparent ${outer + 0.5}px)`;
})();

/** 一行字的占位：条放在和真文字同一个行高的盒子里，只画一根细条的话数据一到卡片就长高一截。 */
function SkeletonLine({ width, size, className = "" }: { width: string; size: "label" | "detail"; className?: string }) {
	return (
		<div className={`flex items-center ${size === "label" ? "text-label" : "text-detail"} ${className}`} style={{ height: "1lh" }}>
			<SkeletonBar width={width} height={size === "label" ? 10 : 8} />
		</div>
	);
}

function SkeletonBreakdownCard({ seed, rows, footer }: { seed: number; rows: number; footer: boolean }) {
	return (
		<Card className="flex flex-col p-4" aria-hidden>
			<SkeletonLine width={`${[72, 64][seed] ?? 68}px`} size="label" />
			<SkeletonLine width={`${[58, 70][seed] ?? 64}%`} size="detail" className="mt-0.5" />
			<div className="mt-4 flex flex-1 items-center gap-6">
				<span data-skeleton-ring="" className="ly-skeleton block shrink-0 rounded-full" style={{ width: SIZE, height: SIZE, mask: RING_MASK, WebkitMask: RING_MASK }} />
				<div className="grid min-w-0 flex-1 grid-cols-1 gap-x-6 gap-y-3 @xl:grid-cols-2">
					{Array.from({ length: rows }, (_, index) => (
						<div key={index}>
							<SkeletonLine width={`${[52, 44, 60, 48][(index + seed) % 4]}%`} size="label" />
							<SkeletonLine width={`${[30, 38, 26, 34][(index + seed) % 4]}%`} size="detail" className="mt-0.5 ml-4" />
						</div>
					))}
				</div>
			</div>
			{footer && <SkeletonLine width="46%" size="detail" className="mt-4" />}
		</Card>
	);
}

/** 两张环图卡片还没数时的样子：排法和真卡片同一套，数据到了只是填进去。 */
export function UsageBreakdownSkeleton() {
	return (
		<div className="mt-3 grid gap-3 @4xl:grid-cols-2" data-usage-breakdown-skeleton="true">
			<SkeletonBreakdownCard seed={0} rows={TOKEN_PARTS.length} footer />
			<SkeletonBreakdownCard seed={1} rows={4} footer={false} />
		</div>
	);
}
