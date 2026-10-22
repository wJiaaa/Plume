import { useCallback, useEffect, useMemo, useState } from "react";
import type { UsageRequestBucket, UsageScan } from "@plume/contract";
import { translate, useI18n } from "../../i18n/index.ts";
import { CalendarDays, ChartLine, RefreshCw } from "../../ui/icons/index.ts";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import { Card, EmptyHint, InlineSelect, Segmented, TextInput } from "./controls.tsx";
import { providerLabel, type ProviderNaming } from "./usage-providers.ts";
import { UsageBarChart } from "./usage-bars.tsx";
import { formatCompact } from "./usage-format.ts";
import { dayKey, heatmapWeeks } from "./usage-heatmap.ts";
import { costText, Kpi, seconds, seriesLabel, SeriesList } from "./UsageRequestParts.tsx";
import { CacheMissCard } from "./UsageCacheMiss.tsx";
import { UsageBreakdown } from "./UsageBreakdown.tsx";
import { activityTotals } from "./usage-activity.ts";
import { barsFor, dailyTotals, emptyTotals, filterRequests, firstTokenOf, hitRateOf, isHourly, metricOf, rangeBounds, requestsCsv, requestTotals, slotsFor, speedOf, type BarMetric, type RequestRange, type Split } from "./usage-requests.ts";
import { Heatmap } from "./UsageHeatmap.tsx";

const WEEKS = 53;
const INTERVALS = ["0", "5", "30", "60"] as const;
type Interval = (typeof INTERVALS)[number];
type HeatMetric = "tokens" | "requests" | "cost";

/** 选项按用量排：最常用的在最上面，而不是按字母把一个只调过两次的排到第一个。 */
function optionsOf(rows: UsageRequestBucket[], pick: (row: UsageRequestBucket) => string): string[] {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(pick(row), (counts.get(pick(row)) ?? 0) + row.requests);
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value);
}

function download(name: string, text: string): void {
	// 带 BOM：没有它，Excel 会把中文的供应商名当成本地编码读成乱码。
	const url = URL.createObjectURL(new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 用量页：每一次模型调用，按时间、供应商、模型来切。
 *
 * 回答「这些请求是什么样的」——今天几点最忙、哪个模型在烧 token、哪个中转慢、首字要等几秒。
 * 数据是扫描按小时合好的（`UsageRequestBucket`），这里只做筛选和摆放。
 */
export function UsageRequests({ scan, now, naming, reload, refreshing }: { scan: UsageScan; now: Date; naming: ProviderNaming; reload: (refresh?: boolean) => Promise<void>; refreshing: boolean }) {
	const { t } = useI18n();
	const [range, setRange] = useState<RequestRange>("today");
	const [custom, setCustom] = useState(() => {
		const today = new Date();
		return { from: dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)), to: dayKey(today) };
	});
	const [provider, setProvider] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [metric, setMetric] = useState<BarMetric>("tokens");
	const [split, setSplitState] = useState<Split>("modelProvider");
	const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
	const [heatMetric, setHeatMetric] = useState<HeatMetric>("tokens");
	const [interval, setIntervalChoice] = useState<Interval>("0");

	// 换了拆分维度，系列整批换掉，上一批关掉的那些没有意义了。
	const setSplit = useCallback((next: Split) => {
		setSplitState(next);
		setHidden(new Set());
	}, []);
	const toggle = useCallback((key: string) => {
		setHidden((current) => {
			const next = new Set(current);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	}, []);

	/*
	 * 自动刷新只在窗口看得见的时候跑。扫描是增量的，没有新行时只是一次空读，但切到别的应用时
	 * 连这个也没必要。
	 */
	useEffect(() => {
		const seconds = Number(interval);
		if (!seconds) return;
		const timer = window.setInterval(() => {
			if (document.visibilityState === "visible") void reload();
		}, seconds * 1000);
		return () => window.clearInterval(timer);
	}, [interval, reload]);

	const bounds = useMemo(() => rangeBounds(range, now, custom), [range, now, custom]);
	const hourly = isHourly(bounds);
	const describe = useCallback((row: Pick<UsageRequestBucket, "model" | "provider">) => [row.model, providerLabel(naming, row.provider), row.provider].join(" "), [naming]);
	// 热力图只吃筛选、不吃区间：它看的是一整年里这一类请求的节奏。
	const filtered = useMemo(() => filterRequests(scan.requests, { from: null, to: null, provider, query }, describe), [scan.requests, provider, query, describe]);
	const rows = useMemo(() => filterRequests(filtered, { ...bounds, provider: null, query: "" }, describe), [filtered, bounds, describe]);
	const totals = useMemo(() => requestTotals(rows), [rows]);
	const activity = useMemo(() => activityTotals(scan.activity, { ...bounds, provider, query }, describe), [scan.activity, bounds, provider, query, describe]);
	const slots = useMemo(() => slotsFor(bounds, rows, now), [bounds, rows, now]);
	const bars = useMemo(() => barsFor(rows, split, metric, slots, hourly), [rows, split, metric, slots, hourly]);
	const byDay = useMemo(() => dailyTotals(filtered), [filtered]);
	const grid = useMemo(() => heatmapWeeks([], now, WEEKS), [now]);

	const providers = useMemo(() => optionsOf(scan.requests, (row) => row.provider), [scan.requests]);

	const speed = speedOf(totals);
	const first = firstTokenOf(totals);
	const hit = hitRateOf(totals);
	const heatValue = (key: string) => metricOf(byDay.get(key) ?? emptyTotals(), heatMetric);

	const exportCsv = () => download(`plume-requests-${bounds.from ?? "all"}_${bounds.to ?? dayKey(now)}.csv`, requestsCsv(rows, (id) => providerLabel(naming, id)));

	return (
		<div data-usage-requests="true" className="@container">
			<div className="flex flex-wrap items-center gap-2">
				<Segmented value={range} onChange={setRange} options={[{ value: "today", label: t("usage.today") }, { value: "7", label: t("usage.days7") }, { value: "30", label: t("usage.days30") }, { value: "all", label: t("common.all") }, { value: "custom", label: t("common.custom") }]} />
				{range === "custom" && (
					<div className="flex items-center gap-1.5 text-detail text-ink-faint">
						<TextInput type="date" value={custom.from} max={custom.to || dayKey(now)} onChange={(from) => setCustom((current) => ({ ...current, from }))} aria-label={t("usage.customFrom")} className="ly-field-compact w-[132px]" />
						<span>–</span>
						<TextInput type="date" value={custom.to} min={custom.from} max={dayKey(now)} onChange={(to) => setCustom((current) => ({ ...current, to }))} aria-label={t("usage.customTo")} className="ly-field-compact w-[132px]" />
					</div>
				)}
				<div className="ml-auto flex items-center gap-2">
					<InlineSelect compact ariaLabel={t("usage.autoRefresh")} value={interval} onChange={setIntervalChoice} options={INTERVALS.map((value) => ({ value, label: value === "0" ? t("usage.autoRefreshOff") : value === "60" ? t("usage.everyMinute") : t("usage.everySeconds", { n: Number(value) }) }))} />
					<Button label={t("usage.refresh")} onClick={() => void reload(true)} disabled={refreshing} icon={refreshing ? <ActionSpinner size={14} /> : <RefreshCw size={14} strokeWidth={1.8} />} />
				</div>
			</div>

			<div className="mt-2 flex flex-wrap items-center gap-2">
				<InlineSelect compact ariaLabel={t("common.provider")} value={provider ?? ""} onChange={(next) => setProvider(next || null)} options={[{ value: "", label: t("usage.allProviders") }, ...providers.map((value) => ({ value, label: providerLabel(naming, value) }))]} />
				<div className="ml-auto flex items-center gap-2">
					<TextInput value={query} onChange={setQuery} placeholder={t("usage.searchRequests")} aria-label={t("usage.searchRequests")} className="ly-field-compact w-[220px]" />
					<Button data-usage-export="" onClick={exportCsv} disabled={rows.length === 0}>{t("usage.exportCsv")}</Button>
				</div>
			</div>

			<div className="mt-3 mb-2 text-detail text-ink-faint">{t("usage.requestsNote")}</div>

			<Card aria-label={t("usage.metrics")} className="grid grid-cols-2 @3xl:grid-cols-5" data-usage-request-kpis="true">
				<Kpi label="Token" value={formatCompact(totals.tokens)}>
					<div>{[t("usage.partInput", { n: formatCompact(totals.input) }), t("usage.partOutput", { n: formatCompact(totals.output) }), t("usage.partCacheWrite", { n: formatCompact(totals.cacheWrite) })].join(" · ")}</div>
				</Kpi>
				<Kpi label={t("usage.metricRequests")} value={totals.requests.toLocaleString()}>
					{totals.requests > 0 && <div>{t("usage.perRequest", { n: formatCompact(totals.tokens / totals.requests) })}</div>}
				</Kpi>
				<Kpi label={t("common.cost")} value={costText(totals)} tone="ok">
					<div>{totals.unpriced > 0 ? t("usage.costUnpriced", { n: totals.unpriced }) : t("usage.costEstimated")}</div>
				</Kpi>
				<Kpi label={t("usage.kpiHitRate")} value={hit === null ? "—" : `${(hit * 100).toFixed(1)}%`}>
					<div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink/[0.06]"><div className="h-full rounded-full bg-ok transition-[width] duration-[var(--ly-t-slow)] ease-[var(--ly-e-out)]" style={{ width: `${(hit ?? 0) * 100}%` }} /></div>
					<div className="pt-1">{t("usage.partCacheRead", { n: formatCompact(totals.cacheRead) })}</div>
				</Kpi>
				<Kpi label={t("usage.kpiSpeed")} value={speed === null ? "—" : t("usage.speedValue", { n: Math.round(speed) })}>
					<div>{speed === null ? t("usage.noTiming") : t("usage.timedCount", { n: totals.timed })}</div>
					{/* 整段到达的回复有首字没有速度，两个次数才会不同；相同时再写一遍只是重复。 */}
					{first !== null && <div>{t("usage.firstTokenAvg", { s: seconds(first) })}{totals.firstTokens !== totals.timed && ` · ${t("usage.timedCount", { n: totals.firstTokens })}`}</div>}
				</Kpi>
			</Card>

			<Card className="mt-3 flex flex-col">
				<div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3.5">
					<Segmented value={metric} onChange={setMetric} options={[{ value: "tokens", label: "Token" }, { value: "cost", label: t("common.cost") }, { value: "requests", label: t("usage.metricRequests") }, { value: "speed", label: t("usage.metricSpeed") }]} />
					<div className="flex items-center gap-2">
						<span className="text-detail text-ink-faint">{t("usage.splitBy")}</span>
						<Segmented value={split} onChange={setSplit} options={[{ value: "model", label: t("common.model") }, { value: "modelProvider", label: t("usage.splitModelProvider") }, { value: "provider", label: t("common.provider") }]} />
					</div>
				</div>
				{rows.length === 0 ? (
					<EmptyHint icon={ChartLine}>{t("usage.noRequests")}</EmptyHint>
				) : (
					<div className="grid gap-2 @3xl:grid-cols-[minmax(0,1fr)_minmax(260px,320px)]">
						<UsageBarChart bars={bars} metric={metric} hourly={hourly} hidden={hidden} labelOf={(key) => seriesLabel(key, split, naming)} />
						<div className="max-h-[300px] overflow-y-auto px-2 pt-2 pb-3" data-usage-series-list="true">
							<SeriesList series={bars.series} split={split} metric={metric} naming={naming} hidden={hidden} onToggle={toggle} />
						</div>
					</div>
				)}
			</Card>

			<UsageBreakdown tokens={totals} activity={activity} />

			<CacheMissCard totals={totals} />

			<Card className="mt-3" data-usage-heatmap="true">
				<div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3.5">
					<div>
						<div className="text-label font-medium text-ink">{t("usage.heatmapTitle")}</div>
						<div className="mt-0.5 text-detail text-ink-faint">{t("usage.heatmapDetail", { n: WEEKS })}</div>
					</div>
					<Segmented value={heatMetric} onChange={setHeatMetric} options={[{ value: "tokens", label: "Token" }, { value: "requests", label: t("usage.metricRequests") }, { value: "cost", label: t("common.cost") }]} />
				</div>
				{byDay.size === 0 ? <EmptyHint icon={CalendarDays}>{t("usage.noRecords")}</EmptyHint> : <div className="px-4 py-4"><Heatmap grid={grid} value={(day) => heatValue(day.key)} tip={(day) => heatTip(day.key, byDay.get(day.key))} /></div>}
			</Card>

			<div className="mt-3 pb-4 text-detail text-ink-faint tabular-nums" data-usage-request-footer="true">
				{[t("usage.requestCount", { n: totals.requests.toLocaleString() }), t("usage.partInput", { n: formatCompact(totals.input) }), t("usage.partOutput", { n: formatCompact(totals.output) }), t("usage.partCacheWrite", { n: formatCompact(totals.cacheWrite) }), t("usage.partCacheRead", { n: formatCompact(totals.cacheRead) })].join(" · ")}
			</div>
		</div>
	);
}

function heatTip(key: string, totals: ReturnType<typeof emptyTotals> | undefined): string {
	const [, month, day] = key.split("-");
	const date = `${Number(month)}/${Number(day)}`;
	if (!totals || totals.requests === 0) return date;
	return [date, translate("usage.dayTokens", { n: formatCompact(totals.tokens) }), translate("usage.requestCount", { n: totals.requests.toLocaleString() }), costText(totals)].join(" · ");
}
