import { translate } from "../../i18n/translate.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../store/index.ts";
import { dropSessionDrag, paneAtPoint } from "../split/index.ts";
import type { SortKey } from "./ListMenu.tsx";
import type { Grouped } from "../../lib/sidebar-grouping.ts";
import type { DraggingItem, DropTarget, ReorderState, SidebarReorderContextValue } from "./reorder-context.ts";

const DRAG_THRESHOLD = 5;

export function useSidebarReorder(groups: Grouped, sort: SortKey, onReordered?: () => void): {
	contextValue: SidebarReorderContextValue;
	dragging: DraggingItem | null;
} {
	/*
	 * `dragging` is also state, for the list itself — it draws the carried pill only while a project
	 * is in the hand, and that changes twice per drag. The drop target and the pointer change far
	 * more often and live only in the store, where each row selects the one bit it draws.
	 */
	const [dragging, setDragging] = useState<DraggingItem | null>(null);
	const store = useRef<ReorderState>({ dragging: null, dropTarget: null, pointer: { x: 0, y: 0 } });
	const listeners = useRef(new Set<() => void>());
	const update = useCallback((patch: Partial<ReorderState>) => {
		store.current = { ...store.current, ...patch };
		for (const listener of listeners.current) listener();
	}, []);
	const candidateRef = useRef<{ item: DraggingItem; originX: number; originY: number; pointerId: number } | null>(null);
	const suppressClick = useRef(false);
	const saving = useRef(false);
	/*
	 * Read through refs, not by the listeners' effect.
	 *
	 * `onReordered` arrives as a fresh function on every render of the sidebar. As an effect
	 * dependency it tore the window listeners down and put them back on each of those renders —
	 * including the render a drop onto the workspace causes *during* the pointerup that caused it.
	 * A listener removed mid-dispatch is not called and one added mid-dispatch is not either, so
	 * this hook never heard that release: the row stayed faded and the pill stayed in the air until
	 * the pointer moved again.
	 */
	const reordered = useRef(onReordered);
	reordered.current = onReordered;
	const sorting = useRef(sort);
	sorting.current = sort;
	// The same for the list: as a dependency it made `startDrag` and `registerTarget` new functions
	// on every list change, and the context with them.
	const grouping = useRef(groups);
	grouping.current = groups;

	const eligible = useCallback((kind: "project" | "session", id: string, project?: string) => {
		if (!reordered.current) return false;
		const groups = grouping.current;
		if (kind === "session") return groups.projects.some((group) => group.id === project && group.sessions.some((session) => session.id === id));
		return groups.projects.some((group) => group.id === id) && Boolean(useApp.getState().settings?.projects.some((project) => project.id === id));
	}, []);

	const reset = useCallback(() => {
		candidateRef.current = null;
		if (store.current.dragging || store.current.dropTarget) update({ dragging: null, dropTarget: null });
		setDragging(null);
	}, [update]);

	const startDrag = useCallback((item: DraggingItem, event: React.PointerEvent) => {
		// Touch keeps native scrolling; only a row's primary button starts a mouse drag.
		if (event.button !== 0 || event.pointerType !== "mouse" || saving.current || !eligible(item.kind, item.id, item.project)) return;
		candidateRef.current = { item, originX: event.clientX, originY: event.clientY, pointerId: event.pointerId };
		update({ pointer: { x: event.clientX, y: event.clientY } });
	}, [eligible, update]);

	const registerTarget = useCallback((kind: "project" | "session", id: string, rect: DOMRect, clientY: number, project?: string) => {
		const active = store.current.dragging;
		if (!active || active.kind !== kind || active.id === id || !eligible(kind, id, project)) return;
		if (kind === "session" && active.project !== project) return;
		const placement = clientY < rect.top + rect.height / 2 ? "before" : "after";
		const current = store.current.dropTarget;
		if (!current || current.id !== id || current.placement !== placement) {
			const next: DropTarget = { kind, id, placement };
			update({ dropTarget: next });
		}
	}, [eligible, update]);

	const clearTarget = useCallback((id: string) => {
		if (store.current.dropTarget?.id === id) update({ dropTarget: null });
	}, [update]);

	useEffect(() => {
		const handlePointerDown = () => { suppressClick.current = false; };
		const handlePointerMove = (event: PointerEvent) => {
			const candidate = candidateRef.current;
			if (!candidate || event.pointerId !== candidate.pointerId) return;
			if (!(event.buttons & 1)) { reset(); return; }
			if (!store.current.dragging && Math.hypot(event.clientX - candidate.originX, event.clientY - candidate.originY) >= DRAG_THRESHOLD) {
				suppressClick.current = true;
				update({ dragging: candidate.item });
				setDragging(candidate.item);
			}
			if (store.current.dragging) {
				event.preventDefault();
				update({ pointer: { x: event.clientX, y: event.clientY } });
			}
		};
		const commit = async (active: DraggingItem, target: DropTarget) => {
			saving.current = true;
			try {
				const store = useApp.getState();
				const changed = active.kind === "project"
					? await store.reorderProjects(active.id, target.id, target.placement)
					: active.project && await store.reorderProjectSessions(active.project, active.id, target.id, target.placement, sorting.current);
				if (changed && active.kind === "session") reordered.current?.();
			} catch (cause) {
				useApp.getState().notify(translate("reorder.saveFailed", { reason: cause instanceof Error ? cause.message : String(cause) }), "error");
			} finally { saving.current = false; }
		};
		const handlePointerUp = (event: PointerEvent) => {
			if (event.pointerId !== candidateRef.current?.pointerId) return;
			const { dragging: active, dropTarget: target } = store.current;
			const overSplit = active?.kind === "session" && paneAtPoint(event.clientX, event.clientY);
			if (overSplit) dropSessionDrag(event);
			reset();
			if (overSplit) return;
			if (active && target) void commit(active, target);
		};
		const cancelPointer = (event: PointerEvent) => {
			if (event.pointerId === candidateRef.current?.pointerId) reset();
		};
		const handleKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && candidateRef.current) { event.preventDefault(); reset(); }
		};
		const handleClick = (event: MouseEvent) => {
			if (suppressClick.current && event.detail > 0) {
				suppressClick.current = false;
				event.preventDefault();
				event.stopPropagation();
			}
		};
		const preventSelection = (event: Event) => { if (candidateRef.current) event.preventDefault(); };
		const clearScrolledTarget = () => { if (store.current.dropTarget) update({ dropTarget: null }); };
		window.addEventListener("pointerdown", handlePointerDown, true);
		window.addEventListener("pointermove", handlePointerMove, true);
		window.addEventListener("pointerup", handlePointerUp);
		window.addEventListener("pointercancel", cancelPointer);
		window.addEventListener("keydown", handleKey, true);
		window.addEventListener("click", handleClick, true);
		window.addEventListener("selectstart", preventSelection);
		window.addEventListener("blur", reset);
		window.addEventListener("scroll", clearScrolledTarget, true);
		return () => {
			window.removeEventListener("pointerdown", handlePointerDown, true);
			window.removeEventListener("pointermove", handlePointerMove, true);
			window.removeEventListener("pointerup", handlePointerUp);
			window.removeEventListener("pointercancel", cancelPointer);
			window.removeEventListener("keydown", handleKey, true);
			window.removeEventListener("click", handleClick, true);
			window.removeEventListener("selectstart", preventSelection);
			window.removeEventListener("blur", reset);
			window.removeEventListener("scroll", clearScrolledTarget, true);
		};
	}, [reset, update]);

	const contextValue = useMemo<SidebarReorderContextValue>(() => ({
		startDrag,
		registerTarget,
		clearTarget,
		getState: () => store.current,
		subscribe: (listener) => {
			listeners.current.add(listener);
			return () => { listeners.current.delete(listener); };
		},
	}), [startDrag, registerTarget, clearTarget]);
	return { contextValue, dragging };
}
