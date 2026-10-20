import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/index.ts";
import { portal } from "../../ui/overlay/portal.ts";
import { axisTicks, CHART, chartTipPlacement, plotHeightFor, viewHeightFor } from "./usage-chart-hover.ts";
import { formatCompact, formatCost } from "./usage-format.ts";
import { emptyTotals, merge, metricOf, OTHER, speedOf, type BarMetric, type Bars, type RequestTotals } from "./usage-requests.ts";

/*
 * 前三色是界面里已有的强调色，后五色接着用 `--ly-chart-*`。
 * 「其他」是灰的：它不是一个东西，只是剩下的那些。
 */
const COLORS = ["var(--color-accent)", "var(--color-violet)", "var(--color-ok)", "var(--ly-chart-3)", "var(--ly-chart-2)", "var(--ly-chart-5)", "var(--ly-chart-6)", "var(--ly-chart-4)"];

export function seriesColor(key: string, index: number): string {
	return key === OTHER ? "var(--color-ink-faint)" : COLORS[index % COLORS.length];
}

export function barValueLabel(value: number, metric: BarMetric): string {
	if (metric === "cost") return formatCost(value) ?? "$0";
	if (metric === "speed") return `${Math.round(value)}`;
	return formatCompact(value);
}

/** 横轴上隔几格写一个字：按小时每 3 小时一个，按天最多八个。 */
function labelStep(count: number, hourly: boolean): number {
	return hourly ? 3 : Math.max(1, Math.ceil(count / 8));
}

function slotLabel(slot: string, hourly: boolean): string {
	if (hourly) return `${slot.slice(11)}:00`;
	const [, month, day] = slot.split("-");
	return `${Number(month)}/${Number(day)}`;
}

interface Hover {
	index: number;
	x: number;
	y: number;
	plot: { top: number; bottom: number };
}

/**
 * 按格堆起来的柱子：每一格是一小时或一天，每一段是一个系列。
 *
 * 速度不堆：两段 100 token/秒摞起来不是 200 token/秒。那一项每格只画一根，是那一格所有可见系列
 * 合起来的速度（总输出 ÷ 总生成时间），各系列自己的速度在气泡和右边的列表里。
 *
 * viewBox 跟着元素的尺寸走（见 `usage-chart-hover.ts` 的 CHART），气泡挂在 body 上：卡片的
 * overflow 会把贴着右边缘的那一格的气泡裁掉。
 */
export function UsageBarChart({ bars, metric, hourly, hidden, labelOf }: { bars: Bars; metric: BarMetric; hourly: boolean; hidden: ReadonlySet<string>; labelOf: (key: string) => string }) {
	const { t } = useI18n();
	const svgRef = useRef<SVGSVGElement>(null);
	const [viewHeight, setViewHeight] = useState<number>(CHART.height);
	const [hover, setHover] = useState<Hover | null>(null);
	const plotHeight = plotHeightFor(viewHeight);
	const count = bars.slots.length;
	const width = CHART.width - CHART.left - CHART.right;
	const slotWidth = count > 0 ? width / count : width;
	const barWidth = Math.max(1, Math.min(28, slotWidth * 0.64));

	const visible = useMemo(() => bars.series.map((series, index) => ({ series, index })).filter(({ series }) => !hidden.has(series.key)), [bars, hidden]);
	/** 每格可见系列合起来；速度柱和气泡的合计读它。 */
	const shown = useMemo(
		() =>
			bars.slots.map((_, slot) => {
				const totals = emptyTotals();
				for (const { series } of visible) merge(totals, series.slots[slot]);
				return totals;
			}),
		[bars, visible],
	);
	const ticks = axisTicks(Math.max(0, ...shown.map((totals) => metricOf(totals, metric))), metric !== "cost");
	const axisTop = ticks.at(-1) || 1;
	const scale = (value: number) => (value / axisTop) * plotHeight;
	const baseline = CHART.top + plotHeight;

	useEffect(() => {
		const svg = svgRef.current;
		if (!svg || typeof ResizeObserver === "undefined") return;
		const measure = () => setViewHeight(viewHeightFor(svg.getBoundingClientRect()));
		const observer = new ResizeObserver(measure);
		observer.observe(svg);
		measure();
		return () => observer.disconnect();
	}, []);

	const showing = hover !== null;
	useEffect(() => {
		if (!showing) return;
		const clear = () => setHover(null);
		window.addEventListener("scroll", clear, true);
		window.addEventListener("blur", clear);
		return () => {
			window.removeEventListener("scroll", clear, true);
			window.removeEventListener("blur", clear);
		};
	}, [showing]);

	const track = (event: React.PointerEvent) => {
		const box = svgRef.current?.getBoundingClientRect();
		if (!box || count === 0) return setHover(null);
		const x = ((event.clientX - box.left) / box.width) * CHART.width;
		const index = Math.floor((x - CHART.left) / slotWidth);
		if (index < 0 || index >= count) return setHover(null);
		const screenX = box.left + ((CHART.left + (index + 0.5) * slotWidth) / CHART.width) * box.width;
		setHover((previous) => (previous && previous.index === index && previous.y === event.clientY ? previous : { index, x: screenX, y: event.clientY, plot: { top: box.top, bottom: box.bottom } }));
	};

	const step = labelStep(count, hourly);
	const at = hover && hover.index < count ? hover : null;

	return (
		<div className="flex min-h-[220px] flex-1 flex-col px-3 pt-2 pb-2" data-usage-bars={metric} onPointerMove={track} onPointerLeave={() => setHover(null)}>
			<svg ref={svgRef} viewBox={`0 0 ${CHART.width} ${viewHeight}`} preserveAspectRatio="none" className="block h-full w-full flex-1 overflow-visible contain-size" role="img" aria-label={t("usage.requestChart")}>
				{ticks.map((tick) => {
					const y = baseline - scale(tick);
					return (
						<g key={tick}>
							<line x1={CHART.left} x2={CHART.width - CHART.right} y1={y} y2={y} stroke="var(--color-line)" strokeWidth="1" />
							<text x={CHART.left - 8} y={y + 4} textAnchor="end" fill="var(--color-ink-faint)" fontSize="11" className="tabular-nums">
								{tick === 0 ? "0" : barValueLabel(tick, metric)}
							</text>
						</g>
					);
				})}

				{at && <rect x={CHART.left + at.index * slotWidth} y={CHART.top} width={slotWidth} height={plotHeight} fill="var(--color-ink)" opacity="0.04" pointerEvents="none" />}

				{bars.slots.map((slot, slotIndex) => {
					const x = CHART.left + slotIndex * slotWidth + (slotWidth - barWidth) / 2;
					if (metric === "speed") {
						const height = scale(speedOf(shown[slotIndex]) ?? 0);
						return <rect key={slot} data-bar-slot={slot} x={x} width={barWidth} rx="1.5" fill="var(--color-accent)" className="transition-[y,height] duration-[var(--ly-t-slow)] ease-[var(--ly-e-out)] motion-reduce:transition-none" style={{ y: baseline - height, height }} />;
					}
					let top = baseline;
					return (
						<g key={slot} data-bar-slot={slot}>
							{visible.map(({ series, index }) => {
								const height = scale(metricOf(series.slots[slotIndex], metric));
								top -= height;
								return <rect key={series.key} x={x} width={barWidth} fill={seriesColor(series.key, index)} className="transition-[y,height] duration-[var(--ly-t-slow)] ease-[var(--ly-e-out)] motion-reduce:transition-none" style={{ y: top, height }} />;
							})}
						</g>
					);
				})}

				{bars.slots.map((slot, index) =>
					index % step === 0 ? (
						<text key={slot} x={CHART.left + (index + 0.5) * slotWidth} y={viewHeight - 6} textAnchor="middle" fill="var(--color-ink-faint)" fontSize="11" className="tabular-nums">
							{slotLabel(slot, hourly)}
						</text>
					) : null,
				)}
			</svg>
			{at && <BarTip anchor={at} title={tipTitle(bars.slots[at.index], hourly)} rows={visible.map(({ series, index }) => ({ key: series.key, label: labelOf(series.key), color: seriesColor(series.key, index), totals: series.slots[at.index] }))} total={shown[at.index]} metric={metric} />}
		</div>
	);
}

function tipTitle(slot: string, hourly: boolean): string {
	if (!hourly) return slot.replaceAll("-", "/");
	const hour = Number(slot.slice(11));
	return `${slot.slice(0, 10).replaceAll("-", "/")} ${`${hour}`.padStart(2, "0")}:00–${`${hour + 1}`.padStart(2, "0")}:00`;
}

function BarTip({ anchor, title, rows, total, metric }: { anchor: Hover; title: string; rows: { key: string; label: string; color: string; totals: RequestTotals }[]; total: RequestTotals; metric: BarMetric }) {
	const { t } = useI18n();
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const placed = chartTipPlacement(anchor, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, anchor.plot);
		el.style.left = `${Math.round(placed.left)}px`;
		el.style.top = `${Math.round(placed.top)}px`;
		el.style.visibility = "visible";
	});
	const text = (totals: RequestTotals) => (metric === "speed" ? (speedOf(totals) === null ? "—" : t("usage.speedValue", { n: Math.round(speedOf(totals) ?? 0) })) : barValueLabel(metricOf(totals, metric), metric));
	const lit = rows.filter((row) => row.totals.requests > 0);
	return portal(
		<div ref={ref} role="tooltip" data-chart-tip="" className="ly-chart-tip ly-glass-solid pointer-events-none fixed z-[200] min-w-[168px] max-w-[300px] rounded-lg border border-line-soft px-2.5 py-2" style={{ left: 0, top: 0, visibility: "hidden" }}>
			<div className="text-detail font-medium text-ink tabular-nums">{title}</div>
			{lit.length === 0 ? (
				<div className="mt-1 text-detail text-ink-faint">{t("usage.noRequestsInSlot")}</div>
			) : (
				<div className="mt-1.5 space-y-1">
					{lit.map((row) => (
						<div key={row.key} className="flex items-center gap-2 text-detail">
							<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: row.color }} />
							<span className="min-w-0 flex-1 truncate text-ink-muted">{row.label}</span>
							<span className="shrink-0 tabular-nums text-ink">{text(row.totals)}</span>
						</div>
					))}
				</div>
			)}
			{lit.length > 1 && (
				<div className="mt-1.5 flex items-center gap-2 border-t border-line-soft pt-1.5 text-detail">
					<span className="flex-1 text-ink-faint">{t("usage.total")}</span>
					<span className="shrink-0 tabular-nums font-medium text-ink">{text(total)}</span>
				</div>
			)}
		</div>,
	);
}
