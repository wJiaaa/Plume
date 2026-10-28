/**
 * 这个会话批准过的计划：一行一份，写的是计划的标题，点了在右侧计划面板里摊开那一份。
 *
 * 只列批准过的（`approvedPlans`），交给新会话的也列——计划文件就是交出去的那份，人回头要找的多半是它。
 * 打回的不列：那份改过以后又交了，批准的才是定稿。
 */

import { approvedPlans, planTitle } from "@plume/core/plan-view";
import { useShallow } from "zustand/react/shallow";
import { ListOrdered } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { useDockScope, useScopedFromMessages } from "../../app/session-scope.tsx";
import { usePlanReview } from "../../store/plan-review.ts";
import { TimeAgo } from "../../ui/primitives/TimeAgo.tsx";
import { openScopedPanel } from "../dock/index.ts";
import { ROW, Section, SectionLabel } from "./rows.tsx";

export function PlansSection({ sessionId }: { sessionId: string }) {
	const { t } = useI18n();
	const scope = useDockScope();
	const plans = useScopedFromMessages(useShallow(approvedPlans));
	if (!plans.length) return null;

	return (
		<Section name="plans">
			<SectionLabel>{t("plan.title")}</SectionLabel>
			{plans.map((plan) => (
				<button
					key={plan.approvedAt}
					type="button"
					data-ly-environment-plan={plan.approvedAt}
					data-ly-tip={plan.handoff ? t("plan.handedOff") : undefined}
					className={ROW}
					onClick={() => {
						usePlanReview.getState().view(sessionId, plan.approvedAt);
						void openScopedPanel("plan", scope ?? undefined);
					}}
				>
					<ListOrdered size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
					<span className="min-w-0 flex-1 truncate">{planTitle(plan)}</span>
					<TimeAgo iso={new Date(plan.approvedAt).toISOString()} className="shrink-0 text-caption text-ink-faint" />
				</button>
			))}
		</Section>
	);
}
