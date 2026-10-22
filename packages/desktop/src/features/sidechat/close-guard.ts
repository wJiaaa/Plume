/**
 * 关掉一个侧边聊天之前，先看里面有没有东西。
 *
 * 关掉就是删掉（`closeSideChat`）：会话、记录、框里没发出去的字一起没了，拿不回来。空的那一格照旧
 * 一点就关——没有可丢的东西还要问，人就习惯性点「确定」，那这句话就白问了。
 *
 * 问题由正挂着这个侧边聊天的那一格画出来（`SideChat`），怎么问、谁来答见 `store/close-question.ts`，
 * 和终端的那一份是同一套。
 */

import type { SessionMeta } from "@plume/core";
import { closeQuestion } from "../../store/close-question.ts";
import type { AppState } from "../../store/index.ts";

/** 勾过「不再询问」并且关掉了一次之后，记在这里。 */
const SKIP_KEY = "plume.sideChat.closeWithoutAsking";

/** `key` 是 `sideKey(会话, 侧边聊天)`：哪一格来回答。 */
const guard = closeQuestion();

export const useSideCloseQuestion = guard.useQuestion;
export const showingSide = guard.showing;

/** 有话可画：说过话、或者正在回答。还没读进来的看记录里的条数。 */
export function sideHasTranscript(app: Pick<AppState, "sessionCache">, side: SessionMeta | null): boolean {
	if (!side) return false;
	const cached = app.sessionCache[side.id];
	return cached ? cached.messages.length > 0 || cached.state?.running === true : side.messageCount > 0;
}

/**
 * `true` 就关，`false` 留着。`key` 是 `sideKey(会话, 侧边聊天)`。
 *
 * 里面有没有东西由调用方量好传进来，见 `confirmCloseSideChat`。
 */
export function askBeforeClosing(key: string, hasContent: boolean): Promise<boolean> {
	if (!hasContent || localStorage.getItem(SKIP_KEY) === "1") return Promise.resolve(true);
	return guard.ask(key, {}, (close, dontAskAgain) => {
		// 只在真关了的时候记：勾上又点了取消，等于这次没答应。
		if (close && dontAskAgain) localStorage.setItem(SKIP_KEY, "1");
	});
}
