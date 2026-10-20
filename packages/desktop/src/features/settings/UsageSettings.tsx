import { useCallback, useEffect, useMemo, useState } from "react";
import type { UsageScan } from "../../../electron/usage-scan.ts";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { SkeletonBar, useSlowLoad } from "../../ui/primitives/Skeleton.tsx";
import { Card, EmptyHint } from "./controls.tsx";
import type { ProviderNaming } from "./usage-providers.ts";
import { UsageRequests } from "./UsageRequests.tsx";

export function UsageSettings() {
	const { t } = useI18n();
	const settings = useApp((state) => state.settings);
	/*
	 * 两个来源，因为这一页问的是「这笔账是谁花的」，而不是「现在配着谁」。
	 *
	 * 账按 `providerId` 记，名字只活在 `providers` 里——一个供应商删掉，它花过的钱照样在日志里，
	 * 页面上却只剩一串 id。`providerNames` 是那份不会随删除消失的档案，见 core 里那条注释。
	 */
	const naming = useMemo<ProviderNaming>(
		() => ({ providers: settings?.providers, names: settings?.providerNames }),
		[settings?.providers, settings?.providerNames],
	);
	const [scan, setScan] = useState<UsageScan | null>(null);
	/** 「今天」从哪一刻算：跟着每次扫描走，页面开过零点、自动刷新还在跑时，今天得是新的那一天。 */
	const [scannedAt, setScannedAt] = useState(() => new Date());
	const [failed, setFailed] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const slow = useSlowLoad(scan === null && !failed);

	const load = useCallback(async (refresh = false) => {
		if (refresh) setRefreshing(true);
		setFailed(false);
		try {
			setScan(await bridge.usage.scan());
			setScannedAt(new Date());
		} catch {
			setFailed(true);
		} finally {
			setRefreshing(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<div className="pt-2">
			<header className="pb-5">
				<h1 className="text-display leading-tight font-semibold tracking-tight text-ink">{t("usage.title")}</h1>
				<p className="mt-2 text-label text-ink-muted">{t("usage.intro")}</p>
			</header>
			{scan ? <UsageRequests scan={scan} now={scannedAt} naming={naming} reload={load} refreshing={refreshing} /> : slow || failed ? <UsageSkeleton failed={failed} /> : null}
		</div>
	);
}

function UsageSkeleton({ failed }: { failed: boolean }) {
	const { t } = useI18n();
	if (failed) return <Card><EmptyHint>{t("usage.readFailed")}</EmptyHint></Card>;
	return <div aria-busy="true" aria-live="polite"><span className="sr-only">{t("usage.reading")}</span><Card className="grid grid-cols-5 gap-4 p-4">{[0, 1, 2, 3, 4].map((index) => <div key={index}><SkeletonBar width="40%" height={10} /><SkeletonBar width="70%" height={24} className="mt-3" /></div>)}</Card><Card className="mt-3 p-4"><div className="flex h-[200px] items-end gap-2">{[24, 38, 30, 62, 44, 78, 55, 70, 48, 66, 36, 58].map((height, index) => <span key={index} className="ly-skeleton flex-1 rounded-t" style={{ height: `${height}%` }} />)}</div></Card></div>;
}
