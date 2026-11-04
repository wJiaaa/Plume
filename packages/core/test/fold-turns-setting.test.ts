import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSettings } from "../src/config/settings.ts";

test("跑完收起过程：没表过态的人默认收，关掉过的读进来还是关着", () => {
	assert.equal(normalizeSettings({}).foldTurns, true);
	assert.equal(normalizeSettings({ foldTurns: true }).foldTurns, true);
	assert.equal(normalizeSettings({ foldTurns: false }).foldTurns, false);
});
