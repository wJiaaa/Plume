import type { Settings } from "@plume/core";
import { useI18n } from "../../i18n/index.ts";
import { useApp } from "../../store/index.ts";
import { ArrowRightLeft } from "../../ui/icons/index.ts";
import type { ModelUsed } from "./grouping.ts";
import { DividerRow } from "./DividerRow.tsx";

/**
 * 「服务商/模型」，用设置里起的名字。
 *
 * 回复上记的是 id。服务商删了、模型改了名，历史里的切换照样要读得出来，所以找不到就原样写 id。
 */
function modelLabel(settings: Settings | null, used: ModelUsed): string {
	const provider = settings?.providers.find((each) => each.id === used.provider);
	const model = provider?.models.find((each) => each.modelId === used.model);
	return `${provider?.name ?? used.provider}/${model?.name ?? used.model}`;
}

/** 转录里换了模型的地方：分隔线当中写从哪个换到哪个。 */
export function ModelSwitchRow({ from, to }: { from: ModelUsed; to: ModelUsed }) {
	const { t } = useI18n();
	const settings = useApp((s) => s.settings);
	const text = t("conversation.modelSwitched", { from: modelLabel(settings, from), to: modelLabel(settings, to) });
	return <DividerRow data-ly-model-switch icon={<ArrowRightLeft size={12} strokeWidth={1.8} aria-hidden className="shrink-0" />} text={text} />;
}
