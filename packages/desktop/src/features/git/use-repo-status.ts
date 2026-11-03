/**
 * The selected repository's `git status`, read on demand and never shown under another repository.
 */

import { useCallback, useRef, useState } from "react";
import type { GitStatus } from "@plume/contract";
import { bridge } from "../../services/index.ts";
import { sameStatus } from "./sameStatus.ts";
import { noteUpstream } from "./upstream-distance.ts";

export function useRepoStatus(cwd: string | null): {
	status: GitStatus | null;
	/** A fresh read — what an operation that just changed the tree waits on. */
	read: () => Promise<void>;
	/** A read shared with whoever else asks for this repository at the same moment. */
	refresh: () => Promise<void>;
} {
	/*
	 * The status together with the repository it describes, so it cannot be shown under another one.
	 *
	 * Switching repositories used to leave A's files on screen under B until B's read came back — and
	 * a read of A still in flight could land after the switch and put them back. The pairing makes the
	 * first impossible to draw (`status` is null until B answers, the same trade the panel makes on a
	 * branch switch: loading rather than wrong); the check in `read` stops the second.
	 */
	const [held, setHeld] = useState<{ cwd: string; status: GitStatus } | null>(null);
	const status = held && held.cwd === cwd ? held.status : null;
	const currentCwd = useRef(cwd);
	currentCwd.current = cwd;

	/*
	 * Go and read it, and keep the object we already had when nothing moved.
	 *
	 * A poll that returns an equal-but-new object is a change as far as React is concerned, so every
	 * 1.5s tick re-ran `ChangesView`'s effect — which fetches the whole working-tree diff. That read
	 * is slower than the interval it is started on, so the panel spent every turn queued behind
	 * itself, which is what "the git panel stutters and takes ages" was. See `sameStatus`.
	 */
	const read = useCallback(async () => {
		if (!cwd) {
			setHeld(null);
			return;
		}
		const next = await bridge.git.status(cwd);
		// The composer's branch chip shows the same distance; after a push or fetch here it is this read that knows first.
		noteUpstream(cwd, next.branch, next.upstream ? { upstream: next.upstream, ahead: next.ahead, behind: next.behind } : null);
		// The panel moved to another repository while this was out: the answer is true, but not about what is on screen.
		if (currentCwd.current !== cwd) return;
		setHeld((current) => (current?.cwd === cwd && sameStatus(current.status, next) ? current : { cwd, status: next }));
	}, [cwd]);

	/*
	 * The same read, shared by whoever asks for it at the same moment.
	 *
	 * Two effects want a status the instant the panel mounts — the branch watcher and
	 * `useLiveRefresh` — so opening the panel spawned two identical `git status` processes and raced
	 * their answers.
	 *
	 * Shared per repository only: B's refresh handed A's read in flight is how A's files appeared
	 * under B.
	 *
	 * Deliberately *not* what an operation uses. Sharing is only correct for callers that want "a
	 * status", and an operation that has just staged a file wants "the status *after* that" — handing
	 * it a read already in flight when the click landed would show the list from before its own change.
	 */
	const inflight = useRef<{ cwd: string | null; promise: Promise<void> } | null>(null);
	const refresh = useCallback(() => {
		if (inflight.current?.cwd === cwd) return inflight.current.promise;
		const flight = read().finally(() => {
			if (inflight.current?.promise === flight) inflight.current = null;
		});
		inflight.current = { cwd, promise: flight };
		return flight;
	}, [cwd, read]);

	return { status, read, refresh };
}
