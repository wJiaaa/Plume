/**
 * 侧边聊天里一次 `dispatch_task`、而人没点名交给主会话时画成的卡片：这件事交给谁做，人来选。
 *
 * 交给主会话是排进它的队列（回执在面板底下的 `TaskStrip`），开新会话照建议卡片的「开始」走、挂在主会话
 * 下面，在这里做是替人对侧边聊天说一句「就在这里做」——它手上有那条指令，接着做就是。选过以后缩成
 * 一行：开新会话的那一行和建议卡片开始以后是同一行（`Started`），点了过去。
 *
 * 参数还在写、或者被点名直接派了的，都是普通的工具行（`fallback`）。
 */

import { useState, type ReactNode } from "react";
import type { AssistantContent, DispatchSuggestionDetails } from "@plume/core";
import { useI18n } from "../../i18n/index.ts";
import { translate } from "../../i18n/translate.ts";
import { useScopedSessionId } from "../../app/session-scope.tsx";
import { bridge } from "../../services/index.ts";
import { useApp, type ToolRun } from "../../store/index.ts";
import { chooseDispatch, useDispatchChoices, type DispatchChoice } from "../../store/dispatch-choices.ts";
import { startedFrom } from "../../store/session-suggestions.ts";
import { Forward, MessageCircle, SquarePen } from "../../ui/icons/index.ts";
import { Button } from "../../ui/primitives/Button.tsx";
import { FlowRow } from "./FlowRow.tsx";
import { Started } from "./SessionSuggestionCard.tsx";

type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;

export function DispatchSuggestionCard({ block, run, fallback }: { block: ToolCall; run?: ToolRun; fallback: ReactNode }) {
	const sideId = useScopedSessionId();
	const mainId = useApp((s) => (sideId ? (s.sessionCache[sideId]?.meta.parentId ?? null) : null));
	const details = run?.status === "done" ? (run.result?.details as DispatchSuggestionDetails | undefined) : undefined;
	if (details?.kind !== "dispatch_suggestion" || !sideId || !mainId) return fallback;
	return <Choose sideId={sideId} mainId={mainId} callId={block.id} details={details} />;
}

/** 排进主会话的队列。没排上（主会话起不来、调用出错）就告诉人，返回 false。 */
async function toMain(mainId: string, instruction: string, sideId: string): Promise<boolean> {
	let reason: string;
	try {
		if (await bridge.tasks.enqueue(mainId, instruction, sideId)) return true;
		reason = translate("sideChat.mainUnavailable");
	} catch (cause) {
		reason = cause instanceof Error ? cause.message : String(cause);
	}
	useApp.getState().notify(translate("sideChat.dispatchFailed", { reason }), "error");
	return false;
}

const CHOSEN_ICON: Record<DispatchChoice, ReactNode> = {
	main: <Forward size={13} strokeWidth={1.8} />,
	here: <MessageCircle size={13} strokeWidth={1.8} />,
};

function Choose({ sideId, mainId, callId, details }: { sideId: string; mainId: string; callId: string; details: DispatchSuggestionDetails }) {
	const { t } = useI18n();
	// 新会话挂在主会话下面（侧边聊天不在侧栏里），所以按主会话找。
	const startedId = useApp((s) => startedFrom(s.sessions, mainId, callId)?.id ?? null);
	const chosen = useDispatchChoices((s) => s.chosen[callId]);
	const [busy, setBusy] = useState<DispatchChoice | "new" | null>(null);

	if (startedId) return <Started sessionId={mainId} callId={callId} title={details.title} startedId={startedId} icon={<SquarePen size={13} strokeWidth={1.8} />} label={t("sessionOps.newSession")} lateReportBack={false} />;
	if (chosen)
		return (
			<div data-ly-dispatch-suggestion={chosen} data-ly-suggestion-call={callId}>
				<FlowRow icon={CHOSEN_ICON[chosen]} title={<span className="font-normal">{t(chosen === "main" ? "sideChat.dispatchedMain" : "sideChat.dispatchHere")}</span>} summary={<span data-ly-suggestion-title>{details.title}</span>} />
			</div>
		);

	const act = async (choice: DispatchChoice | "new") => {
		if (busy) return;
		setBusy(choice);
		try {
			if (choice === "new") {
				await useApp.getState().startSession(details.instruction, { sessionId: mainId, toolCallId: callId }, { title: details.title });
				return;
			}
			// 先记下，卡片当场收起；没成再退回去。
			chooseDispatch(callId, choice);
			const ok =
				choice === "main"
					? await toMain(mainId, details.instruction, sideId)
					: await useApp.getState().send([{ type: "text", text: translate("sideChat.dispatchHereMessage", { title: details.title }) }], { sessionId: sideId });
			if (!ok) chooseDispatch(callId, null);
		} finally {
			setBusy(null);
		}
	};

	return (
		// 图标放进标题那一行，不单占一列：侧边面板常常只有三百来像素，三颗按钮要的就是那一列的宽度。
		<section data-ly-dispatch-suggestion="pending" data-ly-suggestion-call={callId} aria-label={details.title} className="w-full max-w-[420px] rounded-xl border border-line bg-card/30 px-3 py-2.5 text-label">
			<div className="min-w-0">
				<p className="flex items-start gap-1.5 font-medium text-ink">
					<Forward size={14} strokeWidth={1.7} aria-hidden className="mt-[3px] shrink-0 text-ink-muted" />
					<span className="min-w-0" data-ly-suggestion-title>
						{details.title}
					</span>
				</p>
				<p className="mt-0.5 line-clamp-3 text-caption text-ink-muted" data-ly-dispatch-instruction data-ly-tip={details.instruction}>
					{details.instruction}
				</p>
				<div className="mt-2 flex flex-wrap items-center gap-1.5">
					<Button size="sm" variant="primary" loading={busy === "main"} disabled={busy !== null} label={t("sideChat.dispatchToMainTip")} onClick={() => void act("main")} data-ly-dispatch-action="main">
						{t("sideChat.dispatchToMain")}
					</Button>
					<Button size="sm" variant="soft" loading={busy === "new"} disabled={busy !== null} label={t("sideChat.dispatchNewTip")} onClick={() => void act("new")} data-ly-dispatch-action="new">
						{t("sideChat.dispatchNew")}
					</Button>
					<Button size="sm" variant="soft" loading={busy === "here"} disabled={busy !== null} label={t("sideChat.dispatchHereTip")} onClick={() => void act("here")} data-ly-dispatch-action="here">
						{t("sideChat.dispatchHere")}
					</Button>
				</div>
			</div>
		</section>
	);
}
