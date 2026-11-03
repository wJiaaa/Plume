/**
 * 分屏时另一格的会话不是 `activeSessionId`，它的 `tasks` 事件照样要记到它名下。
 *
 * 从前 `tasks` 落在只给屏上那个会话走的 switch 里，非焦点会话在那之前提前 return，事件被丢掉，
 * 那一格的任务栏停在旧的样子。
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { AgentEvent, QueuedTask } from "@plume/core";
import { sideTasksOf, useSide } from "../src/features/dock/sideStore.ts";
import { applyAgentEvent } from "../src/store/apply-event.ts";

(globalThis as { plume?: unknown }).plume = { sessions: { list: async () => [] } };

function fold(state: Record<string, unknown>, sessionId: string, event: AgentEvent) {
	applyAgentEvent(sessionId, event, (partial) => Object.assign(state, typeof partial === "function" ? partial(state as never) : partial), () => state as never);
}

const task = (id: string, status: QueuedTask["status"]): QueuedTask => ({ id, text: id, origin: "side-chat", status, createdAt: 1 });

beforeEach(() => useSide.setState({ tasks: {} }));

test("tasks of a conversation that is on screen but not focused are recorded under it", () => {
	const state: Record<string, unknown> = { activity: {}, turns: {}, carried: {}, sessions: [], activeSessionId: "left", messages: [], toolRuns: {}, sessionCache: {}, queued: {} };
	fold(state, "right", { type: "tasks", tasks: [task("t1", "queued")] });
	assert.deepEqual(sideTasksOf(useSide.getState(), "right").map((one) => one.status), ["queued"]);
	fold(state, "right", { type: "tasks", tasks: [task("t1", "running")] });
	assert.deepEqual(sideTasksOf(useSide.getState(), "right").map((one) => one.status), ["running"]);
	assert.deepEqual(sideTasksOf(useSide.getState(), "left"), [], "屏上那个会话的队列不受影响");
});

test("tasks of the focused conversation still land", () => {
	const state: Record<string, unknown> = { activity: {}, turns: {}, carried: {}, sessions: [], activeSessionId: "left", messages: [], toolRuns: {}, sessionCache: {}, queued: {} };
	fold(state, "left", { type: "tasks", tasks: [task("t2", "done")] });
	assert.deepEqual(sideTasksOf(useSide.getState(), "left").map((one) => one.id), ["t2"]);
});
