import { useState } from "react";
import { useScopedSessionId } from "../../app/session-scope.tsx";

interface TranscriptView {
	windowSize?: number;
	windowEnd?: number;
	expanded: Set<string>;
}

// Keep presentation state without retaining the transcript's DOM or message payloads.
const views = new Map<string, TranscriptView>();
const LIMIT = 12;

function viewFor(id: string): TranscriptView {
	const view = views.get(id) ?? { expanded: new Set<string>() };
	views.delete(id);
	views.set(id, view);
	while (views.size > LIMIT) {
		const oldest = views.keys().next();
		if (!oldest.done) views.delete(oldest.value);
	}
	return view;
}

export function useTranscriptWindow(id: string | null, step: number, total: number) {
	const view = id ? viewFor(id) : undefined;
	const [local, setLocal] = useState({ id, size: view?.windowSize ?? step, end: view?.windowEnd });
	const current = local.id === id ? local : { size: view?.windowSize ?? step, end: view?.windowEnd };
	const end = Math.min(total, current.end ?? total);
	const start = Math.max(0, end - current.size);
	const update = (size: number, end?: number) => {
		if (id) Object.assign(viewFor(id), { windowSize: size, windowEnd: end });
		setLocal({ id, size, end });
	};
	return {
		start, end,
		earlier: () => update(current.size + step, current.end),
		later: () => update(current.size + step, end + step >= total ? undefined : end + step),
		// Jump to the tail without throwing away turns the reader already mounted. Resetting
		// `size` to `step` is what made sending a message unmount the top of a long transcript
		// and drop the viewport by a few hundred pixels before the glide back down.
		latest: () => update(Math.max(step, current.size), undefined),
		reveal: (index: number) => {
			if (index >= start && index < end) return;
			// Jumping to an old question must not mount every message between it and the tail.
			const nextEnd = Math.min(total, Math.max(step, index + step - 5));
			update(step, nextEnd === total ? undefined : nextEnd);
		},
	};
}

export function useTranscriptDisclosure(key?: string): [boolean, (update: (open: boolean) => boolean) => void] {
	/*
	 * Kept under the conversation this transcript belongs to — its screen's, not the focused one's.
	 *
	 * Keyed by the live slot, a split kept every screen's open blocks under whichever conversation had
	 * focus, so moving focus changed the key under all of them at once: everything opened in every
	 * screen folded, and came back only when focus did.
	 */
	const scoped = useScopedSessionId();
	const id = key ? scoped : null;
	const [local, setLocal] = useState({ id, key, open: Boolean(id && key && views.get(id)?.expanded.has(key)) });
	const open =
		local.id === id && local.key === key ? local.open : Boolean(id && key && views.get(id)?.expanded.has(key));
	return [
		open,
		(update) => {
			const next = update(open);
			if (id && key) {
				const view = viewFor(id);
				if (next) view.expanded.add(key);
				else view.expanded.delete(key);
			}
			setLocal({ id, key, open: next });
		},
	];
}/**
 * How much of a long transcript is mounted at once, and how much each "show more" adds — **in turns**.
 *
 * Counted in turns rather than in rows, and that unit is the whole point. The window used to step by
 * 60 `Run`s while the transcript draws in `TurnBlock`s (`turn-blocks.ts`), and a turn can hold hundreds
 * of runs: one session had 400 tool calls between two things the user typed. Paging by row into a
 * turn like that loads 60 rows straight into an already-collapsed block, so the only thing that
 * changes on screen is the number in 「调用工具 N 个」 — four clicks in a row, and the transcript does
 * not move. Now one click always brings whole turns, so it always brings something you can see.
 *
 * Twenty rather than sixty because a turn is worth several rows: its question, its answer, and the
 * lines its work folded into.
 */
export const WINDOW_TURNS = 20;
