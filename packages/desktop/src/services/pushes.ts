/**
 * What the main process pushes, applied once per frame rather than once per message.
 *
 * Each push used to be its own store update and so its own full render. Starting a turn sends a
 * burst of them — the session list twice, the prompt's `message_start`/`message_end`, anything the
 * runtime injects after it, `agent_start`, `turn_start` — a few milliseconds apart and each in its
 * own task, so React could not batch them. In a long conversation every one of those renders costs
 * 5–14ms, and six of them back to back left no room to paint: the first send after opening a
 * conversation of a thousand messages held one frame for 100ms, right as the bubble appeared.
 *
 * The batch is the shared tick (`ui/motion/ticker.ts`, about thirty a second), not every frame. On a
 * 120Hz screen a frame per push was still up to 120 commits a second while tools ran in parallel —
 * each start, phase, result and session change its own — and every commit is a style, layout and
 * paint pass whose cost grows with the transcript. The reply's text is let out per tick anyway, and a
 * push after a quiet spell still lands on the next frame: the first tick after an idle stretch is
 * immediate. See `docs/architecture/smoothness-checklist.md` §15.
 *
 * Two rules keep this from changing what the window believes, only when it redraws:
 *
 * - **Order against replies.** A push that arrived before a reply is applied before the caller sees
 *   the reply (`bridge.ts` flushes here). A transcript read back after an event must not have that
 *   event applied on top of it again — a user `message_start` appends, it does not merge.
 * - **Nothing waits on a frame that will not come.** A hidden window gets no animation frames, and the
 *   queue cannot sit there while a turn finishes behind it: hidden, pushes apply at once. A person's
 *   key or pointer press flushes too, so what they act on is what the main process last said.
 */

import { cancelTick, requestTick } from "../ui/motion/ticker.ts";

const queue: Array<() => void> = [];
const settles: Array<() => void> = [];
let tick = 0;

/**
 * Run `settle` after every batch of pushes. The store's held streaming updates (`coalesce.ts`) land
 * here: the batch is already one per tick, and waiting for a tick of their own put every update a
 * tick behind — requested from inside this tick, it could only be the next one.
 */
export function afterPushes(settle: () => void): void {
	settles.push(settle);
}

/** Apply `push` with the others that arrive before the next tick, in arrival order. */
export function inFrame(push: () => void): void {
	if (typeof requestAnimationFrame !== "function" || typeof document === "undefined" || document.visibilityState === "hidden") {
		flushPushes();
		apply(push);
		return;
	}
	queue.push(push);
	if (!tick) tick = requestTick(() => {
		tick = 0;
		flushPushes();
	});
}

/** Apply everything queued now. Called before a reply resolves and before a person's input. */
export function flushPushes(): void {
	if (tick) {
		cancelTick(tick);
		tick = 0;
	}
	if (queue.length === 0) return;
	for (const push of queue.splice(0)) apply(push);
	for (const settle of settles) apply(settle);
}

// One push failing must not drop the ones queued behind it; each was its own listener before.
function apply(push: () => void): void {
	try {
		push();
	} catch (error) {
		reportError(error);
	}
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
	document.addEventListener("visibilitychange", flushPushes);
	window.addEventListener("keydown", flushPushes, true);
	window.addEventListener("pointerdown", flushPushes, true);
}
