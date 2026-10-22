/**
 * Painting a streamed reply at the screen's pace, not the network's.
 *
 * A reply arrives as a `message_update` per token — several hundred a second on a fast model. Each
 * one used to be a store write and therefore a render of the whole transcript, so the app spent all
 * of its time redrawing four hundred rows to show one more word. Nobody can read at that rate: the
 * screen refreshes sixty times a second, and every update between two frames is work whose result
 * is overwritten before it is seen.
 *
 * So updates are held and applied once per tick — the shared clock in `ui/motion/ticker.ts`, about
 * thirty times a second, which is also when the reply's text is let out. What lands on screen is
 * identical — the same final text, arriving at the same moment — because only the newest update
 * matters and it is the one that gets applied.
 *
 * Everything else flushes first. An update that has not landed yet, followed by the `message_end`
 * that settles it or a `tool_start` that comes after it, would otherwise be applied out of order —
 * and out-of-order is how a transcript ends up showing a card above the sentence introducing it.
 *
 * Keyed, because a conversation in the background streams too: its updates go into its cached
 * transcript, and each of those used to be a store write of its own — every token of a reply nobody
 * was looking at re-ran every selector in the window. Each background conversation holds its own
 * newest update under its own key; the one on screen uses the default key.
 */

import { cancelTick, requestTick } from "../ui/motion/ticker.ts";

type Flush = () => void;

const pending = new Map<string, Flush>();
let frame: number | null = null;

function runPending(): void {
	const works = [...pending.values()];
	pending.clear();
	for (const work of works) work();
}

/**
 * Do this on the next frame, replacing anything else that was waiting under the same key.
 *
 * Replacing rather than queueing is the point: two updates to the same message are not two things
 * to do, they are one thing whose newer version won.
 */
export function coalesce(work: Flush, key = ""): void {
	pending.set(key, work);
	if (frame !== null) return;
	// A tick rather than a frame: the text is let out per tick anyway, so a write every frame only
	// redraws each subscriber more often. Several replies streaming at once also land together, as one commit.
	frame = requestTick(() => {
		frame = null;
		runPending();
	});
}

/** Apply whatever is waiting, now, under every key. Call before anything that must land after it. */
export function flushCoalesced(): void {
	if (frame !== null) {
		cancelTick(frame);
		frame = null;
	}
	runPending();
}

/**
 * Apply only what is waiting under keys that start with `prefix`. A background conversation's event
 * has to land after its own held updates, not after everyone's: flushing all of them there put the
 * conversation on screen back to a store write per event whenever another one ran a chatty command.
 */
export function flushCoalescedUnder(prefix: string): void {
	for (const [key, work] of pending) {
		if (!key.startsWith(prefix)) continue;
		pending.delete(key);
		work();
	}
}
