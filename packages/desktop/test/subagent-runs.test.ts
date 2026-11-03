/**
 * The records a sub-agent panel draws its tool cards from.
 *
 * These exist because of a regression worth naming. The panel was changed to reuse the main
 * conversation's `ToolRun`, whose cards look their record up in the app store — and a sub-agent's
 * tool events never reach that store, because `runSubAgent` emits only the messages it produced.
 * Every card therefore found nothing, and a card that finds nothing after its turn has ended calls
 * itself an error: a panel full of successful work, drawn entirely in red crosses, with the raw
 * tool name where the summary should be.
 *
 * Nothing about that is visible to a typecheck — the props all match — so it is pinned here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/core";
import { subAgentRuns, waitingSince } from "../src/features/subagents/runs.ts";

const call = (id: string, name: string, args: Record<string, unknown>, at = 1000): Message => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
	stopReason: "toolUse",
	timestamp: at,
});

const result = (id: string, text: string, opts?: { isError?: boolean; details?: unknown; at?: number }): Message => ({
	role: "toolResult",
	toolCallId: id,
	content: [{ type: "text", text }],
	isError: opts?.isError,
	details: opts?.details,
	timestamp: opts?.at ?? 2000,
});

test("a finished call is done, not an error", () => {
	const runs = subAgentRuns([call("t1", "read", { path: "src/app.ts" }), result("t1", "…file…")]);

	assert.equal(runs.t1.status, "done", "the whole point: a call with a result did not fail");
	assert.equal(runs.t1.result?.isError, undefined);
	assert.equal(runs.t1.finishedAt, 2000);
});

test("a call still waiting on its result is running", () => {
	const runs = subAgentRuns([call("t1", "bash", { command: "pnpm test" })]);

	assert.equal(runs.t1.status, "running");
	assert.equal(runs.t1.startedAt, 1000);
	assert.equal(runs.t1.finishedAt, undefined);
});

test("a call that really did fail is an error", () => {
	const runs = subAgentRuns([call("t1", "read", { path: "nope.ts" }), result("t1", "ENOENT", { isError: true })]);

	assert.equal(runs.t1.status, "error");
	assert.equal(runs.t1.result?.isError, true);
});

test("the card gets the summary the main transcript would show, not the bare tool name", () => {
	const runs = subAgentRuns([call("t1", "read", { path: "src/app.ts" })]);

	assert.notEqual(runs.t1.summary, "read", "a raw tool name is what the broken version showed");
	assert.ok(runs.t1.summary.length > 0);
});

test("results carry their details through, which is where the diff counts live", () => {
	const runs = subAgentRuns([
		call("t1", "edit", { path: "src/app.ts" }),
		result("t1", "ok", { details: { added: 12, removed: 3 } }),
	]);

	assert.deepEqual(runs.t1.result?.details, { added: 12, removed: 3 });
});

test("several calls in one reply each get their own record", () => {
	const runs = subAgentRuns([
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "a", name: "read", arguments: { path: "one.ts" } },
				{ type: "toolCall", id: "b", name: "read", arguments: { path: "two.ts" } },
			],
			stopReason: "toolUse",
			timestamp: 1000,
		},
		result("a", "…"),
		result("b", "…", { isError: true }),
	]);

	assert.equal(runs.a.status, "done");
	assert.equal(runs.b.status, "error");
});

test("a result with no call above it is ignored rather than invented", () => {
	const runs = subAgentRuns([result("ghost", "from a run that is not in this transcript")]);

	assert.deepEqual(Object.keys(runs), [], "a card with nothing to attach to is not a card");
});

test("the user's own message does not become a record", () => {
	const runs = subAgentRuns([
		{ role: "user", content: [{ type: "text", text: "去找一下" }], timestamp: 900 },
		call("t1", "grep", { pattern: "foo" }),
	]);

	assert.deepEqual(Object.keys(runs), ["t1"]);
});

/*
 * 子智能体的转录只收说完的消息，模型在想时面板上什么都没有：派出去以后任务卡下面一片空白，看着像没动。
 * 「此刻在等模型」由这条规则说，面板据此补一行「正在思考」。
 */
const brief = (at: number): Message => ({ role: "user", content: [{ type: "text", text: "do it" }], timestamp: at, origin: "parent" });
const reply = (text: string, at: number): Message => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: at });

test("waiting on the model right after the brief, counted from the brief", () => {
	assert.equal(waitingSince([brief(500)]), 500);
});

test("waiting again once every call of the last reply has come back", () => {
	const both: Message = {
		role: "assistant",
		content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }, { type: "toolCall", id: "t2", name: "read", arguments: {} }],
		stopReason: "toolUse",
		timestamp: 1000,
	};
	assert.equal(waitingSince([brief(500), both, result("t1", "a", { at: 1500 })]), undefined, "t2 is still running: the tool card says so");
	assert.equal(waitingSince([brief(500), both, result("t1", "a", { at: 1500 }), result("t2", "b", { at: 1800 })]), 1800);
});

test("not waiting while a call runs, even with a steered line after it", () => {
	assert.equal(waitingSince([brief(500), call("t1", "bash", {})]), undefined);
	const steered: Message = { role: "user", content: [{ type: "text", text: "also check tests" }], timestamp: 1200 };
	assert.equal(waitingSince([brief(500), call("t1", "bash", {}), steered]), undefined);
	assert.equal(waitingSince([brief(500), call("t1", "bash", {}), steered, result("t1", "ok", { at: 1600 })]), 1600);
});

test("not waiting once it has said its piece, nor with nothing yet", () => {
	assert.equal(waitingSince([brief(500), reply("done", 900)]), undefined);
	assert.equal(waitingSince([]), undefined);
});
