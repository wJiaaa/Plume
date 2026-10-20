import { translate, useI18n } from "../../i18n/index.ts";
import { ModelIcon } from "../models/index.ts";
import { providerLabel, type ProviderNaming } from "./usage-providers.ts";
import { seriesColor, barValueLabel } from "./usage-bars.tsx";
import { formatCost } from "./usage-format.ts";
import { firstTokenOf, hitRateOf, metricOf, OTHER, speedOf, type BarMetric, type RequestTotals, type Series, type Split } from "./usage-requests.ts";

export function seriesLabel(key: string, split: Split, naming: ProviderNaming): string {
	if (key === OTHER) return translate("usage.other");
	if (split === "provider") return providerLabel(naming, key);
	if (split === "model") return key;
	const [model, provider] = key.split("\u0000");
	return `${model} · ${providerLabel(naming, provider ?? "")}`;
}

function SeriesIcon({ seriesKey, split, naming }: { seriesKey: string; split: Split; naming: ProviderNaming }) {
	if (seriesKey === OTHER) return null;
	if (split === "provider") return <ModelIcon model={seriesKey} name={providerLabel(naming, seriesKey)} size={13} />;
	return <ModelIcon model={seriesKey.split("\u0000")[0] ?? seriesKey} size={13} />;
}

export function seconds(ms: number): string {
	return (ms / 1000).toFixed(1);
}

export function costText(totals: RequestTotals): string {
	const cost = formatCost(totals.cost) ?? "$0.00";
	// 有一部分查不到价，这个数就只是下限。
	return totals.unpriced > 0 ? `≥${cost}` : `≈${cost}`;
}

/** 一个系列的那一行小字：每一项都只在有数的时候出现，免得一排「0 次失败 · 首字 — 秒」。 */
function seriesDetail(totals: RequestTotals, share: number): string[] {
	const parts = [translate("usage.requestCount", { n: totals.requests.toLocaleString() }), costText(totals)];
	const speed = speedOf(totals);
	if (speed !== null) parts.push(translate("usage.speedValue", { n: Math.round(speed) }));
	const first = firstTokenOf(totals);
	if (first !== null) parts.push(translate("usage.firstTokenShort", { s: seconds(first) }));
	const hit = hitRateOf(totals);
	if (hit !== null) parts.push(translate("usage.hitRate", { percent: `${Math.round(hit * 100)}%` }));
	parts.push(`${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`);
	return parts;
}

/**
 * 图右边那一列：每个系列一块，数字、占比条、细节。点一下把它从图上拿掉——拿掉一个大头，剩下的
 * 才有刻度可读。
 */
export function SeriesList({ series, split, metric, naming, hidden, onToggle }: { series: Series[]; split: Split; metric: BarMetric; naming: ProviderNaming; hidden: ReadonlySet<string>; onToggle: (key: string) => void }) {
	const { t } = useI18n();
	return (
		<div className="space-y-1">
			{series.map((each, index) => {
				const off = hidden.has(each.key);
				const color = seriesColor(each.key, index);
				const value = metric === "speed" ? (speedOf(each.totals) === null ? "—" : t("usage.speedValue", { n: Math.round(speedOf(each.totals) ?? 0) })) : metric === "requests" ? each.totals.requests.toLocaleString() : barValueLabel(metricOf(each.totals, metric), metric);
				return (
					<button
						key={each.key}
						type="button"
						aria-pressed={!off}
						data-usage-series={each.key}
						data-ly-tip={off ? t("usage.showSeries") : t("usage.hideSeries")}
						onClick={() => onToggle(each.key)}
						className={`block w-full rounded-lg px-2 py-1.5 text-left transition-[background-color,opacity] duration-[var(--ly-t-quick)] hover:bg-card-hover ${off ? "opacity-45" : ""}`}
					>
						<div className="flex items-center gap-2 text-label">
							<span className="h-2 w-2 shrink-0 rounded-full" style={off ? { boxShadow: `inset 0 0 0 1.5px ${color}` } : { background: color }} />
							<SeriesIcon seriesKey={each.key} split={split} naming={naming} />
							<span data-ly-tip={seriesLabel(each.key, split, naming)} data-ly-tip-when="truncated" className="min-w-0 flex-1 truncate text-ink">{seriesLabel(each.key, split, naming)}</span>
							<span className="shrink-0 font-medium text-ink tabular-nums">{value}</span>
						</div>
						<div className="mt-1 ml-4 h-[3px] overflow-hidden rounded-full bg-ink/[0.06]">
							<div className="h-full rounded-full transition-[width] duration-[var(--ly-t-slow)] ease-[var(--ly-e-out)] motion-reduce:transition-none" style={{ width: `${Math.max(each.share * 100, 1)}%`, background: color }} />
						</div>
						<div className="mt-1 ml-4 text-detail leading-relaxed text-ink-faint tabular-nums">
							{seriesDetail(each.totals, each.share).join(" · ")}
						</div>
					</button>
				);
			})}
		</div>
	);
}

/** 顶上那一排里的一格。 */
export function Kpi({ label, value, children, tone }: { label: string; value: React.ReactNode; children?: React.ReactNode; tone?: "ok" }) {
	return (
		<div className="min-w-0 border-b border-line-soft px-4 py-3.5 odd:border-r last:col-span-2 last:border-b-0 @3xl:border-b-0 @3xl:border-r @3xl:last:col-span-1 @3xl:last:border-r-0">
			<div className="truncate text-detail text-ink-muted">{label}</div>
			<div className={`mt-1 truncate text-[24px] leading-tight font-semibold tracking-[-0.02em] tabular-nums ${tone === "ok" ? "text-ok" : "text-ink"}`}>{value}</div>
			<div className="mt-1 space-y-0.5 text-detail text-ink-faint tabular-nums">{children}</div>
		</div>
	);
}
