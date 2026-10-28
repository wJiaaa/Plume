/**
 * 排队条上，别的会话发来、等这一轮结束的一封请求。
 *
 * 和人排的那几条摆在同一张卡片里，因为它们是同一件事：这一轮结束后，接下来要做的。请求排在上面，
 * 因为它真的先走——core 在这一轮收尾时接着就开它的那一轮（`drainPending`），人排的话要等窗口看到
 * 收尾才发出去。
 *
 * 只读：它是别人的话，这边删了、改了，那边还在等回答。轮到它时整行当帧消失，转录里同时多出那一封，
 * 和人排的话送出去时一样（见 `QueuedMessages` 文件头）。
 */

import type { PeerLetter } from "@plume/core";
import { useI18n } from "../../i18n/index.ts";
import { MessagesSquare } from "../../ui/icons/index.ts";
import { peerName } from "../../store/peer-name.ts";

export function QueuedLetter({ letter }: { letter: PeerLetter }) {
	const { t } = useI18n();
	const summary = letter.text.split("\n").find((line) => line.trim()) ?? "";
	return (
		<div role="listitem" className="ly-queue-row" data-queue-letter="">
			{/* 折叠的那一层，和人排的那几行同一套结构，行高、内衬才对得齐。 */}
			<div>
				<div className="flex h-8 items-center gap-2.5 px-2 text-label">
					{/* 占着拖动手柄那一格：图标和下面几行的手柄竖着对齐。 */}
					<span className="flex h-6 w-4 shrink-0 items-center justify-center text-ink-faint">
						<MessagesSquare size={13} strokeWidth={1.8} />
					</span>
					<span className="min-w-0 flex-1 truncate text-ink-muted" data-ly-tip={`${letter.from}\n\n${letter.text}\n\n${t("composer.queueLetterWaiting")}`}>
						<span className="text-ink">{t("peers.from", { name: peerName(letter.from) })}</span>
						{summary && <span className="text-ink-faint"> · </span>}
						{summary}
					</span>
					<span className="shrink-0 text-ink-faint">{t("composer.queueLetterStatus")}</span>
				</div>
			</div>
		</div>
	);
}
