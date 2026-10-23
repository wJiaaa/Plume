/**
 * 截掉一段对话之前，问一句那几轮改过的文件要不要一起退回去。
 *
 * 撤回和编辑重发做的是同一个截断，截掉的那几轮改过的文件原样留在磁盘上——重问时模型以为回到了这句话
 * 之前，读到的代码却已经被「不存在的那几轮」改过。所以两边先问主进程那几轮碰过哪些文件（只演算），再像
 * ZCode / qwen-code 那样让人选：连文件一起，或者只动对话。有一个文件不能安全写回，就只剩后者，并说明
 * 是哪个、为什么。见 ADR-0056。
 */

import type { RevertPlan } from "@plume/contract";
import { useCallback } from "react";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { useConfirmer } from "../../ui/overlay/Confirm.tsx";
import { useI18n } from "../../i18n/index.ts";
import { relativeTo } from "../../lib/paths.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { useScopedProjectPath } from "../../app/session-scope.tsx";
import { Counts } from "./TurnDelivery.tsx";

/** 这个框在这一处的说法：标题、两种说明、两颗按钮。 */
export interface FilesBackWords {
	title: string;
	/** 全部能退回时。 */
	detail: string;
	/** 有文件不能安全退回时。 */
	blocked: string;
	withFiles: string;
	without: string;
}

/**
 * 被截掉的那几轮碰过哪些文件；没碰过、或者读不出来，都是 null。
 *
 * 读不出来当没碰过：只动对话照样做得成，真要写文件时主进程会再查一遍。
 */
export async function filesBackPlan(sessionId: string | null, index: number): Promise<RevertPlan | null> {
	const id = sessionId ?? useApp.getState().activeSessionId;
	if (!id) return null;
	try {
		const plan = await bridge.agent.revertPlan(id, index);
		return plan.files.length ? plan : null;
	} catch {
		return null;
	}
}

export function useFilesBack() {
	const { t } = useI18n();
	const workspace = useScopedProjectPath();
	const confirm = useConfirmer();
	const confirmAsk = confirm.ask;

	const ask = useCallback(
		(plan: RevertPlan, words: FilesBackWords, choose: (files: boolean) => void, onCancel?: () => void) => {
			const safe = !plan.unrecorded && plan.files.every((file) => file.problem === null);
			confirmAsk({
				title: words.title,
				detail: safe ? words.detail : words.blocked,
				confirmLabel: safe ? words.withFiles : words.without,
				onConfirm: () => choose(safe),
				...(safe ? { alternate: { label: words.without, onConfirm: () => choose(false) } } : {}),
				...(onCancel ? { onCancel } : {}),
				children: (
					<Scroller className="max-h-48" contentClassName="flex flex-col gap-1.5 text-label" top="fade" bottom="fade">
						{plan.files.map((file) => (
							<div key={file.path} data-revert-file="" className="flex min-w-0 items-center gap-3">
								<RevertFileName path={workspace ? relativeTo(workspace, file.path) : file.path} />
								{file.problem ? <span className="shrink-0 text-ink-muted">{t(`revert.problem.${file.problem}`)}</span> : <Counts added={file.added} removed={file.removed} />}
							</div>
						))}
						{plan.unrecorded && <p className="text-ink-muted">{t("revert.unrecorded")}</p>}
					</Scroller>
				),
			});
		},
		[confirmAsk, t, workspace],
	);

	return { ask, confirm, element: confirm.element };
}

/**
 * 目录让位，文件名留全。
 *
 * 交付卡片的 `FileName` 整条一起截，卡片够宽看不出来；这个框只有 400px，路径稍长就只剩一串目录、
 * 文件名被截没了——而人要认的正是文件名。
 */
function RevertFileName({ path }: { path: string }) {
	const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
	return (
		<span className="flex min-w-0 flex-1" title={path}>
			<span className="min-w-0 truncate text-ink-muted">{path.slice(0, split)}</span>
			<span className="shrink-0 text-ink">{path.slice(split)}</span>
		</span>
	);
}
