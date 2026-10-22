import assert from "node:assert/strict";
import { test } from "node:test";
import { groupActivity } from "../src/features/sidebar/group-activity.ts";

const counts = (running: number, waiting: number, failed: number, done: number) => ({ running, waiting, failed, done });

test("group activity follows IDs, counting a session listed twice once", () => {
	const result = groupActivity(["a", "b", "a", "c"], { a: "running", b: "waiting", c: "done", other: "failed" }, "c");
	assert.deepEqual(result.counts, counts(1, 1, 0, 0));
});

test("finishing or removing the last running session clears the running count", () => {
	assert.equal(groupActivity(["a"], { a: "running" }, "a").counts.running, 1);
	assert.equal(groupActivity(["a"], { a: "done" }, "a").counts.running, 0);
	assert.equal(groupActivity([], { a: "running" }, null).counts.running, 0);
	assert.deepEqual(groupActivity(["a"], { a: "failed" }, null).counts, counts(0, 0, 1, 0));
});

test("a side chat on an idle session counts as running without double-counting the main turn", () => {
	assert.deepEqual(groupActivity(["a"], {}, null, new Set(["a"])).counts, counts(1, 0, 0, 0));
	assert.deepEqual(groupActivity(["a"], { a: "running" }, null, new Set(["a"])).counts, counts(1, 0, 0, 0));
	assert.deepEqual(groupActivity(["a"], { a: "waiting" }, null, new Set(["a"])).counts, counts(0, 1, 0, 0));
});
