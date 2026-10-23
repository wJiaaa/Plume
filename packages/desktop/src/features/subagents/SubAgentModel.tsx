/**
 * 它跑在哪个模型上、想多久——在输入框那一行，主输入框放模型和推理强度的同一个位置。
 *
 * 只读：派出去的那一刻就定了（见 `SubAgentSummary.model`），这里点了也换不了，所以不画成按钮、
 * 不带下拉箭头；要换去设置里改，悬停说明里写着。
 *
 * 模型名带 `ly-fit-probe`：面板常常只有三百来像素，名字被挤到认不出时，那一行按主输入框同一个
 * 顺序先让出上下文表（见 `composer/fit.ts`）。
 */

import type { Settings, SubAgentSummary } from "@plume/core";
import { useI18n } from "../../i18n/index.ts";
import { modelTooltip } from "../../lib/model-grouping.ts";
import { useApp } from "../../store/index.ts";
import { Brain } from "../../ui/icons/index.ts";
import { effortLabel, formatWindow, ModelIcon } from "../models/index.ts";

export function SubAgentModel({ used }: { used: NonNullable<SubAgentSummary["model"]> }) {
	const { t } = useI18n();
	const settings = useApp((s) => s.settings);
	const identity = identify(settings, used);
	// 服务商删了、模型改了名，这里照样要说得出它当时用的是谁：找不到就原样写 id。
	const name = identity?.model.name ?? used.model;
	const level = used.thinking ? effortLabel(used.thinking, identity?.model, t) : null;
	const tip = [identity ? modelTooltip(identity, formatWindow) : `${used.provider} · ${used.model}`, level && t("composer.thinking", { level }), t("subAgent.modelTip")]
		.filter(Boolean)
		.join("\n");
	return (
		<span className="ly-composer-control flex min-w-0 items-center gap-1 px-1.5 text-label text-ink-muted" data-ly-tip={tip} data-sub-model="">
			<ModelIcon model={used.model} name={name} />
			<span className="ly-fit-probe min-w-0 truncate">{name}</span>
			{level && (
				<>
					<Brain size={16} className="ml-1.5 shrink-0" aria-hidden />
					<span className="shrink-0 whitespace-nowrap" data-sub-thinking="">{level}</span>
				</>
			)}
		</span>
	);
}

function identify(settings: Settings | null, used: { provider: string; model: string }) {
	const provider = settings?.providers.find((each) => each.id === used.provider);
	const model = provider?.models.find((each) => each.modelId === used.model);
	return provider && model ? { provider, model } : null;
}
