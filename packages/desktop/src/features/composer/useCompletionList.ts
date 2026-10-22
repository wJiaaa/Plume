/**
 * 输入框里 `/` 和 `@` 两张补全菜单共有的那半截：光标在哪、菜单开没开、挑到第几行、方向键和 Esc。
 *
 * 两张菜单从前各写一份，逐行相同；各自不同的只有「光标前那一段算不算在补全」（`parse`）和「挑中以后
 * 换成什么」，那两件由调用方给。
 */

import { useEffect, useId, useState } from "react";

export interface CompletionRange {
	term: string;
	start: number;
	end: number;
}

export function useCompletionList<C extends CompletionRange>(
	text: string,
	field: React.RefObject<HTMLTextAreaElement | null>,
	setText: (text: string) => void,
	parse: (text: string, start: number, end: number) => C | null,
	/** 换了它，高亮回到第一行——同一个词在另一个目录下列出来的是另一份名单。 */
	resetKey: string,
) {
	const [active, setActive] = useState(0);
	const [keyboardSelection, setKeyboardSelection] = useState(true);
	const [dismissed, setDismissed] = useState(false);
	const [selection, setSelection] = useState({ text, start: text.length, end: text.length });
	const [focused, setFocused] = useState(false);
	const id = useId();
	// 记下的选区属于另一份字时不作数：那是改字之前的光标，按字尾算。
	const caret = selection.text === text;
	const completion = parse(text, caret ? selection.start : text.length, caret ? selection.end : text.length);
	const term = completion?.term ?? null;

	useEffect(() => {
		setActive(0);
		setKeyboardSelection(true);
	}, [term, resetKey]);

	function select() {
		const el = field.current;
		if (el) setSelection({ text: el.value, start: el.selectionStart, end: el.selectionEnd });
	}

	/** 把正在补全的那一段换成 `insert`。走原生插入：撤销栈留着，光标后面的字也不动。 */
	function replace(insert: string) {
		const el = field.current;
		if (!completion || !el) return;
		el.focus();
		el.setSelectionRange(completion.start, completion.end);
		const trailingSpace = !insert || /\s/.test(text[completion.end] ?? "") ? "" : " ";
		document.execCommand("insertText", false, `${insert}${trailingSpace}`);
		setText(el.value);
		select();
		setDismissed(true);
	}

	return {
		id,
		completion,
		term,
		/** 词有了、没被 Esc 收起、框也有焦点：该去算名单了。 */
		listening: term !== null && !dismissed && focused,
		keyboardSelection,
		/** 名单变短时高亮不能落到外面去。 */
		activeIn: (count: number) => Math.min(active, Math.max(0, count - 1)),
		replace,
		dismiss: () => setDismissed(true),
		hover(index: number) {
			setKeyboardSelection(false);
			setActive(index);
		},
		change(next: string) {
			setText(next);
			setDismissed(false);
		},
		select,
		focus() {
			setFocused(true);
			select();
		},
		blur() {
			setFocused(false);
		},
		/**
		 * 上下翻、回车和 Tab 交给 `choose`、Esc 收起。接下了就 `preventDefault` 并返回 true——输入框
		 * 那边的其他处理靠它知道这个键已经有人管了。
		 */
		keyDown(event: React.KeyboardEvent<HTMLTextAreaElement>, count: number, choose: (index: number, key: "Enter" | "Tab") => void): boolean {
			if (!count || event.nativeEvent.isComposing || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
			const current = Math.min(active, count - 1);
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setKeyboardSelection(true);
				setActive((current + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
				return true;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				choose(current, event.key);
				return true;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setDismissed(true);
				return true;
			}
			return false;
		},
	};
}
