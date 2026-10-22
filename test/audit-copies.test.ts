import assert from "node:assert/strict";
import { test } from "node:test";
import { isFork, withoutCopies } from "../scripts/audit-copies.ts";

const CREATED = 1_000_000;
const line = (record: Record<string, unknown>) => JSON.stringify(record);
const reply = (timestamp: number, extra: Record<string, unknown> = {}) => line({ type: "message", message: { role: "assistant", timestamp, usage: { cost: { total: 1 } } }, ...extra });

test("an old fork without the copy flag: the head up to the last earlier-stamped message goes, boundary included", () => {
	const lines = [
		line({ type: "meta" }),
		reply(CREATED - 5000),
		line({ type: "event", event: { type: "compacted", kept: 1 } }),
		reply(CREATED - 1000),
		reply(CREATED + 10),
	];
	assert.deepEqual(withoutCopies(lines, CREATED, true), [reply(CREATED + 10)]);
});

test("a flagged copy is dropped wherever it sits, and a session that is not a fork is left alone", () => {
	const trailing = line({ type: "event", event: { type: "compacted", kept: 2 }, copy: true });
	const lines = [reply(CREATED + 1, { copy: true }), trailing, reply(CREATED + 50)];
	assert.deepEqual(withoutCopies(lines, CREATED, true), [reply(CREATED + 50)]);
	assert.deepEqual(withoutCopies(lines, CREATED, false), lines);
});

test("only a meta with forkedFrom is a fork", () => {
	assert.equal(isFork(JSON.stringify({ forkedFrom: { sessionId: "a" } })), true);
	assert.equal(isFork(JSON.stringify({ title: "x" })), false);
	assert.equal(isFork("not json"), false);
});
