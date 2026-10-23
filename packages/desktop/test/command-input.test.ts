import assert from "node:assert/strict";
import { test } from "node:test";
import { commandCompletion, commandDecoration, commandEntries } from "../src/features/composer/command-catalog.ts";

test("only resolved invocations decorate; partial names, paths and prose stay editable plain text", () => {
	const entries = commandEntries([], []);
	assert.deepEqual(commandDecoration(" /COMPACT 保留任务", entries), { start: 1, end: 9, hint: undefined });
	assert.match(commandDecoration("/compact", entries)?.hint ?? "", /可选/);
	for (const value of ["/comp", "提到 /compact", "`/compact`", "/tmp/file.ts", "/unknown"]) assert.equal(commandDecoration(value, entries), undefined);
});

test("completion uses the caret and leaves a selected range, inline code and path alone", () => {
	const text = "中文 👩‍💻 /rev 后续要求";
	const end = text.indexOf(" 后续");
	assert.deepEqual(commandCompletion(text, end, end), { term: "rev", start: text.indexOf("/"), end });
	assert.equal(commandCompletion(text, end - 1, end), null);
	assert.equal(commandCompletion("`/rev", 5, 5), null);
	assert.equal(commandCompletion("src/foo", 7, 7), null);
});

test("/review is a built-in command: listed with the others, with its own usage, and sent as text", () => {
	const review = commandEntries([], []).find((entry) => entry.name === "review");
	assert.equal(review?.kind, "builtin");
	assert.equal(review?.action, undefined, "没有宿主动作：发出去，由 resolveInvocation 展开");
	assert.ok(review?.argumentHint?.includes("--effort"));
	assert.equal(commandDecoration("/review", commandEntries([], []))?.hint, review?.argumentHint);
});
