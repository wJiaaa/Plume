/**
 * Which scheduler the session drains its queue with.
 *
 * Bound by the host at boot, as with the other seams; unbound, the queue runs in the order it was
 * filled, which is what a person sitting in front of it expects.
 */

import type { QueuedTask } from "../agent/events.ts";
import type { TaskScheduler } from "../kernel/services.ts";

/**
 * First in, first out: the built-in scheduler, and what runs when none is bound.
 *
 * The order the user asked for things is the order they expect them back, and any cleverness here
 * shows up as work being done in an order nobody chose. A scheduler that knows about priority or
 * cost replaces this one; it should not be a flag on it.
 */
export const fifoScheduler: TaskScheduler = {
	next: (queued) => queued.find((task) => task.status === "queued"),
};

let bound: TaskScheduler | null = null;

export function useScheduler(next: TaskScheduler | null): void {
	bound = next;
}

export function nextTask(queued: QueuedTask[]): QueuedTask | undefined {
	return (bound ?? fifoScheduler).next(queued);
}
