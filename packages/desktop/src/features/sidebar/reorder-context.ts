/**
 * Context and helpers for reordering projects and sessions via pointer drag.
 */

import { createContext, useContext, useSyncExternalStore } from "react";

type DragKind = "project" | "session";

export interface DraggingItem {
	kind: DragKind;
	id: string; // project id or session id
	title: string;
	project?: string; // only for session: the project id it is filed under
}

export interface DropTarget {
	kind: DragKind;
	id: string;
	placement: "before" | "after";
}

export interface ReorderState {
	dragging: DraggingItem | null;
	dropTarget: DropTarget | null;
	pointer: { x: number; y: number };
}

/*
 * 上下文本身从不换：拖拽状态放在它带着的一个小 store 里，每一行只选自己那一位。
 *
 * 从前上下文的值就是 `{ dragging, dropTarget, … }`，每次渲染新建一个——侧栏父组件同样的 props
 * 重渲染一次，两百行全部重画；拖着走，每一次 pointermove 都让整列重画一遍。
 */
export interface SidebarReorderContextValue {
	startDrag: (item: DraggingItem, event: React.PointerEvent) => void;
	registerTarget: (kind: DragKind, id: string, rect: DOMRect, clientY: number, project?: string) => void;
	clearTarget: (id: string) => void;
	getState: () => ReorderState;
	subscribe: (listener: () => void) => () => void;
}

export const SidebarReorderContext = createContext<SidebarReorderContextValue | null>(null);

export function useSidebarReorderContext(): SidebarReorderContextValue | null {
	return useContext(SidebarReorderContext);
}

const IDLE: ReorderState = { dragging: null, dropTarget: null, pointer: { x: 0, y: 0 } };
const NO_SUBSCRIPTION = () => () => {};

/**
 * One value derived from the drag, re-rendering only when that value changes.
 *
 * The selector must return something stable between calls — a boolean, a placement, or an object
 * the store itself holds — or every store change counts as a change.
 */
export function useReorderState<T>(select: (state: ReorderState) => T): T {
	const context = useContext(SidebarReorderContext);
	return useSyncExternalStore(
		context?.subscribe ?? NO_SUBSCRIPTION,
		() => select(context ? context.getState() : IDLE),
	);
}
