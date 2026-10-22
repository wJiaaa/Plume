/**
 * Which scheduler the session drains its queue with.
 *
 * Unbound — which is both hosts — the queue runs in the order it was filled, which is what a
 * person sitting in front of it expects. `useScheduler` is the seam a test swaps.
 */

import type { QueuedTask } from "../agent/events.ts";

/**
 * Choose the next task to run.
 *
 * A seam because "the oldest one" is only obviously right when everything in the queue is the same
 * kind of thing. A queue mixing a user's question with an overnight batch wants the question first;
 * one feeding a build farm may want the cheapest first. Returning `undefined` means nothing is
 * ready — which is also how a scheduler holds work back until some condition is met.
 */
export interface TaskScheduler {
	next(queued: QueuedTask[]): QueuedTask | undefined;
}

/**
 * First in, first out: the built-in scheduler, and what runs when none is bound.
 *
 * The order the user asked for things is the order they expect them back, and any cleverness here
 * shows up as work being done in an order nobody chose. A scheduler that knows about priority or
 * cost replaces this one; it should not be a flag on it.
 */
const fifoScheduler: TaskScheduler = {
	next: (queued) => queued.find((task) => task.status === "queued"),
};

let bound: TaskScheduler | null = null;

export function useScheduler(next: TaskScheduler | null): void {
	bound = next;
}

export function nextTask(queued: QueuedTask[]): QueuedTask | undefined {
	return (bound ?? fifoScheduler).next(queued);
}
