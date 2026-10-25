/**
 * 钩子表单在哪些事件上让人填匹配器，要和 core 实际拿什么去比对得上。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { matcherSubject } from "../src/features/settings/hook-matcher.ts";

test("不传匹配值的两个事件不看匹配器", () => {
	assert.equal(matcherSubject("UserPromptSubmit"), null);
	assert.equal(matcherSubject("Stop"), null);
});

test("工具类事件按工具名比，结束类按原因比", () => {
	for (const event of ["PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"] as const) assert.equal(matcherSubject(event), "tool");
	assert.equal(matcherSubject("SessionStart"), "start");
	assert.equal(matcherSubject("StopFailure"), "turnEnd");
	assert.equal(matcherSubject("SessionEnd"), "sessionEnd");
});
