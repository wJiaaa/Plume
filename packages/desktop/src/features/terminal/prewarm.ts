/**
 * A shell already at its prompt by the time the terminal is opened.
 *
 * Opening the pane used to be what started the shell, and a shell takes about a third of a second
 * to reach a prompt — spawn is immediate, the rest is the login files and whatever the prompt
 * shells out to. So the pane opened as an empty rectangle and filled in a moment later, every
 * time. Started at launch instead, the prompt is already recorded in the main process and the
 * first attach replays it in a single frame.
 *
 * Only the first shell of the directory in front of you, and only when the main thread has nothing
 * better to do — see `prewarm` in `terminal-registry.ts` for what is deliberately *not* predicted.
 */

import { useEffect } from "react";
import { useApp } from "../../store/index.ts";
import { bridge } from "../../services/index.ts";
import { preloadTerminalPane } from "./LazyTerminalPane.tsx";
import { lastTerminalSize } from "./terminal-size.ts";

/**
 * Have one shell ready, once.
 *
 * Mounted at the root rather than in the pane, because the whole point is to have run before the
 * pane exists. Not re-run when the project changes: the strip shows every shell wherever it was
 * started, so one already running is one the pane opens onto instantly — predicting a second per
 * project would spawn shells for a gain that has already been had.
 *
 * On idle, and never during boot. Spawning a shell competes for the main thread with the first
 * paint, and a terminal nobody has asked for yet has no business making the window slower to
 * appear — the whole gain is a third of a second, which is not worth taking from somewhere it
 * would be seen.
 */
export function useTerminalPrewarm(): void {
	const ready = useApp((s) => s.ready);

	useEffect(() => {
		if (!ready) return;
		/*
		 * 和面板开新终端时用的是同一个口径（`startingCwd`，见 `TerminalPane`）。
		 *
		 * 这里原本只看 `workspace.path`。面板那边先看会话的目录、再看工作区——两者在跑 worktree 的会话
		 * 里是不一样的。口径不同的后果不是「预热白费了」，是**多一个终端**：面板按自己的目录找不到匹配
		 * 的，于是又开一个，第一次打开面板就是两个标签。
		 */
		const cwd = useApp.getState().meta?.cwd ?? useApp.getState().workspace?.path ?? "";
		const { cols, rows } = lastTerminalSize();
		/*
		 * `requestIdleCallback` where it exists, with a timeout so a permanently busy app still gets
		 * its shell — the deadline is what turns "when convenient" into "soon, and out of the way".
		 */
		// The pane's code too, on the same terms: kept out of startup, but here before anyone opens it.
		const warm = () => {
			bridge.terminal.prewarm(cwd, cols, rows);
			preloadTerminalPane();
		};
		const idle = window.requestIdleCallback?.bind(window);
		if (!idle) {
			const timer = window.setTimeout(warm, 400);
			return () => window.clearTimeout(timer);
		}
		const handle = idle(warm, { timeout: 2000 });
		return () => window.cancelIdleCallback?.(handle);
	}, [ready]);
}
