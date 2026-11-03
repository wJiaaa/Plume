/**
 * 一轮改过代码之后有没有验证、过没过。见 `verification.ts`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isCheckCommand, turnVerification } from "../src/verification.ts";
import type { Message } from "../src/types.ts";

function result(details: Record<string, unknown>, isError = false, toolName = "bash"): Message {
	return { role: "toolResult", toolCallId: "c", toolName, content: [], details, isError, timestamp: 0 };
}
const edit = result({ changeId: "e" }, false, "edit");
const run = (command: string, exitCode: number, isError = exitCode !== 0) => result({ kind: "bash", command, exitCode, changeIds: [] }, isError);

test("认得出常见的检查命令，普通命令不算", () => {
	for (const command of ["pnpm test", "npm run typecheck", "cd packages/core && pnpm lint", "pytest -q", "cargo test", "node_modules/.bin/vitest run"]) assert.ok(isCheckCommand(command), command);
	for (const command of ["ls src", "git status", "pnpm install", "cat latest.txt"]) assert.ok(!isCheckCommand(command), command);
});

test("没改文件的轮次没有验证状态", () => {
	assert.equal(turnVerification([run("pnpm test", 0)]), null);
	assert.equal(turnVerification([result({ changeId: "e" }, true, "edit")]), null, "改失败的那次不算改过");
});

test("改完没跑检查是未验证；改动之前跑的不算", () => {
	assert.deepEqual(turnVerification([edit]), { state: "unverified" });
	assert.deepEqual(turnVerification([run("pnpm test", 0), edit]), { state: "unverified" });
	assert.deepEqual(turnVerification([edit, run("pnpm test", 0), edit]), { state: "unverified" }, "检查之后又改了");
});

test("改完之后最后那条检查决定过没过", () => {
	assert.deepEqual(turnVerification([edit, run("pnpm test", 0)]), { state: "passed", command: "pnpm test" });
	assert.deepEqual(turnVerification([edit, run("pnpm test", 1)]), { state: "failed", command: "pnpm test" });
	assert.deepEqual(turnVerification([edit, run("pnpm test", 1), run("pnpm test", 0)]), { state: "passed", command: "pnpm test" });
});

test("只改文档不算改代码，也不让之前的检查作废", () => {
	const doc = result({ kind: "edit", changeId: "d", path: "docs/guide.md" }, false, "edit");
	assert.equal(turnVerification([doc]), null);
	assert.deepEqual(turnVerification([edit, run("pnpm test", 0), doc]), { state: "passed", command: "pnpm test" });
	assert.deepEqual(turnVerification([doc, result({ kind: "edit", changeId: "e", path: "src/a.ts" }, false, "edit")]), { state: "unverified" });
});

test("命令改了文件也算改动；检查命令自己写出的文件不算", () => {
	const generate = result({ kind: "bash", command: "node gen.js", exitCode: 0, changeIds: ["g"] });
	assert.deepEqual(turnVerification([generate]), { state: "unverified" });
	const snapshot = result({ kind: "bash", command: "pnpm test", exitCode: 0, changeIds: ["s"] });
	assert.deepEqual(turnVerification([edit, snapshot]), { state: "passed", command: "pnpm test" });
});

test("后台读回来的非零退出是失败：bash_output 不置 isError", () => {
	const background = result({ kind: "bash_background", id: "j", command: "pnpm test" });
	assert.deepEqual(turnVerification([edit, background]), { state: "pending", command: "pnpm test" });
	const read = result({ kind: "bash_output", id: "j", command: "pnpm test", exitCode: 1 });
	assert.deepEqual(turnVerification([edit, background, read]), { state: "failed", command: "pnpm test" });
	assert.deepEqual(turnVerification([edit, result({ kind: "bash_output", id: "j", command: "pnpm test", exitCode: null })]), { state: "pending", command: "pnpm test" });
});

test("被中断的检查是没通过；交给 verify 子代理的是结果未回", () => {
	assert.deepEqual(turnVerification([edit, result({ kind: "bash", command: "pnpm test", cancelled: true }, true)]), { state: "failed", command: "pnpm test" });
	const dispatch = result({ kind: "task", agentType: "verify", subAgentId: "s" }, false, "task");
	assert.deepEqual(turnVerification([edit, dispatch]), { state: "pending", command: "verify" });
	assert.deepEqual(turnVerification([edit, result({ kind: "task", agentType: "explore" }, false, "task")]), { state: "unverified" });
});
