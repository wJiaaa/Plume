/**
 * 输入框上方那张补全菜单的外壳——`/` 命令和 `@` 提及共用。
 *
 * 量高度、收起时留着上一帧、键盘翻页只滚这一张、指针不动不算悬停、分组标题，两张菜单从前各写一份：
 * 「不压到窗格标题栏下」那次修复只落在了命令菜单上，`@` 菜单的头几行照旧钻到标题栏底下。各自不同的
 * 只有每一行画什么，由 `row` 给。
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Scroller } from "../../ui/scroll/Scroller.tsx";

/** 菜单最高这么高；上面空间不够时让给窗格标题栏。 */
const MAX_HEIGHT = 340;
const GAP = 12;

export interface CompletionRow {
	/** 读屏念的那一句。 */
	label: string;
	/** 挂在这一行上的 `data-*`，给样式和测试认。 */
	data: Record<string, string>;
	content: ReactNode;
}

export function CompletionPopup<T>({ id, items, term, active, keyboardSelection, label, className, optionClassName, keyOf, groupOf, heading, row, onPick, onHover }: {
	id: string;
	items: T[];
	term: string;
	active: number;
	keyboardSelection: boolean;
	label: string;
	/** 菜单自己的类名（`ly-command-menu` / `ly-mention-menu`）。 */
	className: string;
	optionClassName: string;
	keyOf: (item: T) => string;
	/** 同一组的挨在一起；没打字时组和组之间写一行标题。 */
	groupOf: (item: T) => string;
	heading: (item: T) => string;
	row: (item: T, index: number, selected: boolean) => CompletionRow;
	onPick: (item: T) => void;
	onHover: (index: number) => void;
}) {
	const panel = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const pointer = useRef<{ x: number; y: number } | null>(null);
	// 收起的那一段动画里还画着刚才那一份，不是空的一张。
	const previous = useRef<{ items: T[]; term: string; active: number }>({ items: [], term, active });
	const [height, setHeight] = useState(MAX_HEIGHT);
	const open = items.length > 0;
	const shown = open ? items : previous.current.items;
	const shownTerm = open ? term : previous.current.term;
	const shownActive = open ? active : previous.current.active;
	useLayoutEffect(() => { if (open) previous.current = { items, term, active }; }, [items, term, active, open]);
	useLayoutEffect(() => {
		const anchor = panel.current?.parentElement;
		if (!anchor) return;
		// Up to the pane's top, not the window's: the window toolbar sits above the pane and over this menu,
		// and with the composer mid-window in an empty conversation the first rows went under it.
		// Since 485cc847 dropped the window's top bar, the pane draws its own title bar *inside* its top 44px
		// (`.ly-dock-chrome`, absolute, above the content) — so the ceiling is that bar's bottom edge, not the pane's top.
		const pane = anchor.closest("[data-dock-pane]");
		const ceiling = () => {
			if (!pane) return 0;
			const chrome = pane.querySelector(".ly-dock-chrome");
			return chrome ? chrome.getBoundingClientRect().bottom : pane.getBoundingClientRect().top;
		};
		const measure = () => setHeight(Math.max(0, Math.min(MAX_HEIGHT, anchor.getBoundingClientRect().top - ceiling() - GAP)));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(anchor);
		window.addEventListener("resize", measure);
		return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
	}, [open]);
	useLayoutEffect(() => {
		if (!open || !keyboardSelection) return;
		const viewport = list.current;
		const selected = viewport?.querySelector<HTMLElement>(`[data-index="${active}"]`);
		if (!viewport || !selected) return;
		// Scroll only this list, never the transcript behind its absolutely positioned popup.
		const box = selected.getBoundingClientRect();
		const view = viewport.getBoundingClientRect();
		if (box.top < view.top + 36) viewport.scrollTop -= view.top + 36 - box.top;
		else if (box.bottom > view.bottom - 48) viewport.scrollTop += box.bottom - view.bottom + 48;
	}, [active, items, open, keyboardSelection]);
	return <div ref={panel} id={id} role={open ? "listbox" : undefined} aria-label={label} aria-hidden={!open} inert={!open}
		data-open={open} className={`${className} ly-glass-solid absolute bottom-full left-0 right-0 z-40 mb-2 overflow-hidden rounded-2xl border border-line-soft`}>
		<div style={{ maxHeight: height }} className="flex flex-col">
			<Scroller scrollRef={list} className="ly-menu-scroll min-h-0" contentClassName="p-1.5">
				{shown.map((item, index) => {
					const selected = index === shownActive;
					const { label: spoken, data, content } = row(item, index, selected);
					const firstOfGroup = !shownTerm && (index === 0 || groupOf(item) !== groupOf(shown[index - 1]));
					return <div key={keyOf(item)}>
						{firstOfGroup && <div className="px-3 pb-1 pt-2 text-detail text-ink-faint">{heading(item)}</div>}
						<button id={`${id}-${index}`} type="button" role={open ? "option" : undefined} tabIndex={-1}
							aria-label={spoken} aria-selected={selected} data-index={index} {...data}
							onMouseDown={(event) => event.preventDefault()} onClick={() => onPick(item)} onMouseMove={(event) => {
								// Scrolling can move a new row under a stationary pointer without a new selection intent.
								if (pointer.current?.x === event.clientX && pointer.current.y === event.clientY) return;
								pointer.current = { x: event.clientX, y: event.clientY };
								onHover(index);
							}}
							className={`ly-scroll ${optionClassName} flex h-9 w-full items-center gap-2 rounded-xl px-3 text-left text-label transition-colors duration-[var(--ly-t-quick)] ${selected ? "bg-card-hover" : ""}`}>
							{content}
						</button>
					</div>;
				})}
			</Scroller>
		</div>
	</div>;
}
