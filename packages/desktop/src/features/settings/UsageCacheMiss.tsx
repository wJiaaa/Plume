import { useI18n, type MessageKey } from "../../i18n/index.ts";
import { Layers } from "../../ui/icons/index.ts";
import { Card, EmptyHint } from "./controls.tsx";
import { formatCompact, formatCost } from "./usage-format.ts";
import type { RequestTotals } from "./usage-requests.ts";

/**
 * 有未命中的那几种原因，按「要不要去查」排：本地改了工具、提示词或历史的排前面，其次是前缀没变
 * 服务商却没读到、没有前缀记录分不清的；最后几种是有意改写或换模型，付了代价但说得清为什么。
 */
const CAUSES: { cause: keyof RequestTotals["cacheMiss"]["byCause"]; label: MessageKey }[] = [
	{ cause: "tools", label: "usage.cacheMissTools" },
	{ cause: "prompt", label: "usage.cacheMissPrompt" },
	{ cause: "rewrite", label: "usage.cacheMissRewrite" },
	{ cause: "provider", label: "usage.cacheMissProvider" },
	{ cause: "unknown", label: "usage.cacheMissUnknown" },
	{ cause: "compaction", label: "usage.cacheMissCompaction" },
	{ cause: "rewind", label: "usage.cacheMissRewind" },
	{ cause: "model", label: "usage.cacheMissModel" },
];

/** 本该从缓存读到、却按全价重算的输入，以及各是为什么。算法见 core 的 `runtime/cache-diagnostics.ts`。 */
export function CacheMissCard({ totals }: { totals: RequestTotals }) {
	const { t } = useI18n();
	const miss = totals.cacheMiss;
	const input = totals.input + totals.cacheRead + totals.cacheWrite;
	const rows = CAUSES.filter(({ cause }) => (miss.byCause[cause] ?? 0) > 0);
	return (
		<Card className="mt-3 p-4" data-usage-cache-miss="true">
			<div className="mb-3 text-label font-medium text-ink">{t("usage.cacheMiss")}</div>
			{miss.tokens === 0 ? (
				<EmptyHint icon={Layers}>{t("usage.cacheMissNone")}</EmptyHint>
			) : (
				<div className="grid gap-4 @2xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
					<div>
						<div className="text-[24px] leading-tight font-semibold tracking-[-0.02em] text-ink tabular-nums">
							{formatCompact(miss.tokens)} <span className="text-label font-normal text-ink-faint">token</span>
						</div>
						<div className="mt-1 text-detail text-ink-faint tabular-nums">
							{t("usage.ofInput", { percent: `${input > 0 ? ((miss.tokens / input) * 100).toFixed(1) : "0.0"}%` })}
							{miss.cost > 0 && <> · {t("usage.cacheMissCost", { cost: formatCost(miss.cost) ?? "$0.00" })}</>}
							{miss.unpriced > 0 && <> · {t("usage.cacheMissUnpriced", { n: formatCompact(miss.unpriced) })}</>}
						</div>
						<div className="mt-2 text-detail leading-relaxed text-ink-faint">{t("usage.cacheMissDetail")}</div>
					</div>
					<div className="divide-y divide-line-soft">
						{rows.map(({ cause, label }) => (
							<div key={cause} className="flex items-center justify-between gap-3 py-2 text-label">
								<span className="text-ink-muted">{t(label)}</span>
								<span className="shrink-0 text-ink tabular-nums">{formatCompact(miss.byCause[cause] ?? 0)}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</Card>
	);
}
