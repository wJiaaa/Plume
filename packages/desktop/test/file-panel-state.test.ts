import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeFilePanelChanges, readFilePanelState, requestFilePanel, type FilePanelState } from "../shared/file-panel-state.ts";

const a = { path: "/project/alpha.ts", name: "alpha.ts" };
const b = { path: "/project/beta.ts", name: "beta.ts" };
const c = { path: "/other/gamma.ts", name: "gamma.ts" };
const initial: FilePanelState = { path: b.path, tabs: [a, b], wrap: true, showSource: true };

test("the IPC snapshot accepts tabs and view options but rejects malformed or dangling state", () => {
	assert.deepEqual(readFilePanelState(initial), initial);
	for (const input of [null, [], {}, { ...initial, path: 4 }, { ...initial, path: c.path }, { ...initial, tabs: [a, a] }, { ...initial, tabs: [{ ...a, path: "bad\0path" }] }, { ...initial, wrap: "true" }]) {
		assert.equal(readFilePanelState(input), null, JSON.stringify(input));
	}
});

test("opening another source file adds its tab and keeps the detached pane's own view options", () => {
	const detached = { ...initial, wrap: false };
	const requested = { ...initial, path: c.path, tabs: [...initial.tabs, c] };
	const next = requestFilePanel(detached, requested);
	assert.equal(next.path, c.path);
	assert.deepEqual(next.tabs, [a, b, c]);
	assert.equal(next.wrap, false);
});

test("returned changes preserve another project's active tab", () => {
	const source = { ...initial, path: c.path, tabs: [...initial.tabs, c] };
	const edited = { ...initial, wrap: false };
	const returned = mergeFilePanelChanges(initial, edited, source);
	assert.equal(returned.path, c.path);
	assert.deepEqual(returned.tabs, [a, b, c]);
	assert.equal(returned.wrap, false);
});

test("a detached tab close removes only its own tabs", () => {
	const source = { ...initial, tabs: [...initial.tabs, c] };
	const edited = { ...initial, tabs: [b] };
	const returned = mergeFilePanelChanges(initial, edited, source);
	assert.deepEqual(returned.tabs, [b, c]);
	assert.equal(returned.path, b.path);
});

test("a stale acknowledgement rebases onto the new file requested meanwhile", () => {
	const remote = requestFilePanel(initial, { ...initial, path: c.path, tabs: [...initial.tabs, c] });
	const local = { ...initial, wrap: false };
	const rebased = mergeFilePanelChanges(initial, local, remote);
	assert.equal(rebased.path, c.path);
	assert.deepEqual(rebased.tabs, [a, b, c]);
	assert.equal(rebased.wrap, false);
});

test("a jump to lines crosses windows only when well-formed, and only with the request that carried it", () => {
	const reveal = { from: 88, to: 90, at: 7 };
	assert.deepEqual(readFilePanelState({ ...initial, reveal }), { ...initial, reveal });
	for (const bad of [{ from: 0, to: 3, at: 1 }, { from: 5, to: 4, at: 1 }, { from: 1.5, to: 2, at: 1 }, { from: 1, to: 2 }, "88"]) {
		assert.equal(readFilePanelState({ ...initial, reveal: bad }), null, JSON.stringify(bad));
	}
	// 带行号打开：换到那个文件、以源码看、跳行；下一次不带行号的请求不沿用这一次。
	const jumped = requestFilePanel({ ...initial, showSource: false }, { ...initial, path: c.path, tabs: [c], showSource: false, reveal });
	assert.equal(jumped.path, c.path);
	assert.equal(jumped.showSource, true);
	assert.deepEqual(jumped.reveal, reveal);
	assert.equal("reveal" in requestFilePanel(jumped, { ...initial, path: a.path, tabs: [a] }), false);
});

test("a jump requested while a detached change was pending survives the rebase", () => {
	const reveal = { from: 150, to: 150, at: 9 };
	const remote = requestFilePanel(initial, { ...initial, reveal });
	const local = { ...initial, wrap: false };
	const rebased = mergeFilePanelChanges(initial, local, remote);
	assert.deepEqual(rebased.reveal, reveal);
	assert.equal(rebased.wrap, false);
});
