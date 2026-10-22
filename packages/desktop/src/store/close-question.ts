/**
 * 关掉一样拿不回来的东西之前问一句——终端里跑着的进程、侧边聊天里的对话。
 *
 * 问题由正显示着它的那一格画出来：确认框要长在组件树里，而关闭是从 store 函数发起的。所以每一格
 * 挂上时登记自己（`showing`），关闭时只问有人显示着的那一个；没有哪一格显示它——比如它在另一个
 * 窗口——就不问，照旧关。否则没人回答，这次关闭就永远停在半路。
 *
 * 一次只有一个问题。上一个还没答又来一个：上一个算「不关」，免得它的 await 永远停在那儿。
 */

import { create } from "zustand";

export type Asking<Detail> = Detail & {
	/** 问的是哪一个：显示着它的那一格按这个认出该由自己来答。 */
	key: string;
	answer(close: boolean, dontAskAgain?: boolean): void;
};

export function closeQuestion<Detail extends object = object>() {
	const useQuestion = create<{ asking: Asking<Detail> | null }>(() => ({ asking: null }));
	/** 这个窗口里正显示着的，计数：分屏时同一个可能显示在两格里。 */
	const shown = new Map<string, number>();

	return {
		useQuestion,
		showing(key: string): () => void {
			shown.set(key, (shown.get(key) ?? 0) + 1);
			return () => {
				const left = (shown.get(key) ?? 1) - 1;
				if (left > 0) shown.set(key, left);
				else shown.delete(key);
			};
		},
		/** `true` 就关，`false` 留着。`onAnswer` 在答了之后、关闭继续之前调用。 */
		ask(key: string, detail: Detail, onAnswer?: (close: boolean, dontAskAgain: boolean) => void): Promise<boolean> {
			if (!shown.has(key)) return Promise.resolve(true);
			return new Promise((resolve) => {
				useQuestion.getState().asking?.answer(false);
				useQuestion.setState({
					asking: {
						...detail,
						key,
						answer: (close, dontAskAgain = false) => {
							if (useQuestion.getState().asking?.key === key) useQuestion.setState({ asking: null });
							onAnswer?.(close, dontAskAgain);
							resolve(close);
						},
					},
				});
			});
		},
	};
}
