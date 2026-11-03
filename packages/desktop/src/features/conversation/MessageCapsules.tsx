/**
 * 气泡里技能和会话引用那两种胶囊：它们确实是这句话的一部分（附件不是，附件在气泡外面那一排）。
 */

import type { SkillEntry, UserMessage } from "@plume/core";
import { useDockScope } from "../../app/session-scope.tsx";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { Boxes, MessagesSquare } from "../../ui/icons/index.ts";
import { openFilePane } from "../dock/index.ts";
import { jumpToSession } from "./jump-to-session.ts";

/**
 * Where a conversation runs, read at the moment it is needed rather than subscribed to.
 *
 * The answer `useScopedWorkspace` gives, as a directory: the live slot's project — or its directory
 * outside any project — for the conversation holding it; the directory a parked conversation works
 * in, which is its project or its project-less directory, the same path either way; and for a blank
 * screen away from the live slot, where it was opened. Read on a press, because every message in
 * every transcript would otherwise carry the subscriptions.
 */
function directoryOf(sessionId: string | null): string {
	const state = useApp.getState();
	if (sessionId === state.activeSessionId) return state.workspace?.path ?? state.scratchCwd ?? "";
	if (sessionId === null) return state.parkedDraft?.workspace?.path ?? state.parkedDraft?.scratchCwd ?? "";
	return (state.sessionCache[sessionId]?.meta ?? state.sessions.find((one) => one.id === sessionId))?.cwd ?? "";
}

/*
 * 附件不在这里面了。
 *
 * 它们从前算一份「胶囊」，跟技能和会话引用一样住在气泡里；于是一条只附了几个文件、一个字
 * 没打的消息，气泡里装的全是文件名——气泡是「我说的那句话」的容器，它不该盛这个。附件整体
 * 搬到气泡外面那一排上之后，只剩这两样还要气泡：它们确实是这句话的一部分。
 *
 * 顺带修掉一个空壳：附件还算在里面时，正文为空的那条消息会渲染出一个只有内边距的气泡。
 */
export function hasCapsules(message: UserMessage): boolean {
	return Boolean(message.skillRef || message.sessionRefs?.length);
}

export function MessageCapsules({ message, sessionId }: { message: UserMessage; sessionId: string | null }) {
	const { t } = useI18n();
	// The screen a skill this message names opens in: a press on another screen would open it in the focused one.
	const screen = useDockScope();
	const skillRef = message.skillRef;
	return (
		<>
			{skillRef && (
				<div className="mb-1.5 flex flex-wrap items-center gap-1.5">
					<button
						type="button"
						data-ly-tip={t("userMessage.openSkill")}
						onClick={async () => {
							// Listed from this conversation's directory; the live slot's is the focused screen's.
							const cmdCwd = directoryOf(sessionId);
							const list = await bridge.commands.list(cmdCwd).catch(() => null);
							const targetPath = list?.skills?.find((skill: SkillEntry) => skill.name === skillRef.name && skill.pluginId === skillRef.pluginId)?.path;
							if (targetPath) {
								void openFilePane(targetPath, screen ?? undefined);
							} else {
								useApp.getState().notify(t("userMessage.skillMissing", { name: skillRef?.name ?? "" }), "warn");
							}
						}}
						className="inline-flex items-center gap-1.5 rounded-lg border border-line-soft bg-card-hover/80 px-2.5 py-1 text-label font-medium text-accent transition-colors hover:bg-card-hover active:scale-[0.98]"
					>
						<Boxes size={13} strokeWidth={2} className="text-accent" />
						<span>{skillRef.name}</span>
					</button>
				</div>
			)}

			{message.sessionRefs && message.sessionRefs.length > 0 && (
				<div className="mb-1.5 flex flex-wrap items-center gap-1.5">
					{message.sessionRefs.map((sRef) => (
						<button
							key={sRef.id}
							type="button"
							data-ly-tip={t("userMessage.jumpToSession")}
							onClick={() => {
								if (!jumpToSession(sessionId, sRef.id)) useApp.getState().notify(t("userMessage.sessionMissing", { title: sRef.title }), "warn");
							}}
							className="inline-flex items-center gap-1.5 rounded-lg border border-line-soft bg-card-hover/80 px-2 py-0.5 text-caption font-medium text-ink-muted transition-colors hover:bg-card-hover hover:text-ink active:scale-[0.98]"
						>
							<MessagesSquare size={12} strokeWidth={1.8} className="text-ink-faint" />
							<span className="max-w-[180px] truncate">{sRef.title}</span>
						</button>
					))}
				</div>
			)}
		</>
	);
}
