/**
 * 关掉一格终端之前，先看它是不是正跑着东西。
 *
 * 关一格就是结束它的 shell（见 `closeTerminal`），连同里面的 dev server、跑到一半的构建。标签上的
 * ✕ 和别的 ✕ 长得一样，顺手一点就没了，而且拿不回来。所以只在前台不是 shell 本身时问一句；
 * 停在提示符上的终端照旧一点就关，问多了人就习惯性点「确定」，那这句话就白问了。
 *
 * 怎么问、谁来答，见 `store/close-question.ts`。
 */

import { panelInstance } from "../../lib/panel-instance.ts";
import { savedTerminal, useTerminals } from "../../store/terminals.ts";
import { closeQuestion } from "../../store/close-question.ts";
import { terminalSlot } from "./scope.ts";

/** 问题里点名关掉会结束的那个进程。`key` 是 shell 的 id：显示着它的那一格来问。 */
const guard = closeQuestion<{ process: string }>();

export const useCloseQuestion = guard.useQuestion;
export const showing = guard.showing;

/** Resolves `true` to go ahead with closing, `false` to keep the terminal. */
export function confirmCloseTerminal(scope: string, kind: string): Promise<boolean> {
	const slot = terminalSlot(scope, panelInstance(kind))!;
	const id = useTerminals.getState().activeByScope[slot] || savedTerminal(slot);
	const process = id ? useTerminals.getState().tabs.find((tab) => tab.id === id)?.process : null;
	if (!id || !process) return Promise.resolve(true);
	return guard.ask(id, { process });
}
