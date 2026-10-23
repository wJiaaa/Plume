/**
 * 「撤回并重新编辑」，和被截掉的那几轮改过的文件，见 `files-back.tsx`。
 *
 * 没碰过文件的撤回照旧：最后一条直接撤，更早的问一句。
 */

import { useState } from "react";
import { Undo2 } from "../../ui/icons/index.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { touchWorkingTree } from "../../ui/hooks/useLiveRefresh.ts";
import { useI18n } from "../../i18n/index.ts";
import { useApp } from "../../store/index.ts";
import { filesBackPlan, useFilesBack } from "./files-back.tsx";

export function RevertAction({ index, sessionId, running, last }: { index: number; sessionId: string | null; running: boolean; last: boolean }) {
	const { t } = useI18n();
	const revertMessage = useApp((s) => s.revertMessage);
	const filesBack = useFilesBack();
	// 演算还没回来：再按一次会弹两个框。
	const [asking, setAsking] = useState(false);

	const run = (files: boolean) => {
		// 退回的文件不是一轮写的，改动统计和 Git 面板闲着时不轮询，得叫它们重读。
		void revertMessage(index, sessionId ?? undefined, files ? { files: true } : undefined).then(() => files && touchWorkingTree());
	};

	const ask = async () => {
		setAsking(true);
		const plan = await filesBackPlan(sessionId, index).finally(() => setAsking(false));
		if (plan) {
			return filesBack.ask(plan, {
				title: t("userMessage.undoConfirmTitle"),
				detail: t("revert.filesDetail", { n: plan.files.length }),
				blocked: t("revert.filesBlocked"),
				withFiles: t("revert.withFiles"),
				without: t("revert.conversationOnly"),
			}, run);
		}
		if (last) return run(false);
		filesBack.confirm.ask({
			title: t("userMessage.undoConfirmTitle"),
			detail: t("userMessage.undoConfirmDetail"),
			confirmLabel: t("userMessage.undoConfirm"),
			onConfirm: () => run(false),
		});
	};

	return (
		<>
			<IconButton
				data-message-undo=""
				label={running ? t("userMessage.undoRunning") : t("userMessage.undo")}
				ariaLabel={t("userMessage.undo")}
				explainDisabled
				disabled={running || asking}
				onClick={() => {
					if (running || asking) return;
					void ask();
				}}
				icon={<Undo2 size={12.5} strokeWidth={1.8} />}
			/>
			{filesBack.element}
		</>
	);
}
