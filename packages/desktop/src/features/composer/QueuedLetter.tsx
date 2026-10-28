/**
 * 排队条上，别的会话发来、这一轮还没读到的一封请求。
 *
 * 请求插进正在跑的这一轮，下一步之前读到（core 的 `takeLetters`），这一行只在那之前的一步之内出现。
 * 和人排的那几条摆在同一张卡片里，是因为它们都是「到了、还没被读」；请求排在上面，因为它先被读到——
 * 人排的话要等这一轮收尾。
 *
 * 只读：它是别人的话，这边删了、改了，那边还在等回答。读到时整行当帧消失，转录里同时多出那一封，
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
