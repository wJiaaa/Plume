import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { recordFileChange } from "../../core/src/tools/file-changes.ts";
import { restoreRevertedFiles, revertPlan } from "../electron/session/revert-files.ts";
import type { AgentSession, Message, ToolContext } from "@plume/core";

let home: string, ctx: ToolContext, prior: string | undefined;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "plume-revert-files-"));
	prior = process.env.PLUME_HOME;
	process.env.PLUME_HOME = home;
	const cwd = join(home, "project");
	await mkdir(cwd);
	ctx = { cwd, sessionId: "qa", state: new Map(), scratchDir: join(home, "scratch") };
});
afterEach(async () => {
	if (prior === undefined) delete process.env.PLUME_HOME;
	else process.env.PLUME_HOME = prior;
	await rm(home, { recursive: true, force: true });
});

const ask = (timestamp: number): Message => ({ role: "user", content: [{ type: "text", text: "q" }], timestamp });
const wrote = (details: unknown): Message => ({ role: "toolResult", toolName: "write", toolCallId: "tool", content: [], details, isError: false, timestamp: 1 });
const session = (messages: Message[]) => ({ meta: { id: ctx.sessionId, cwd: ctx.cwd }, messages }) as unknown as AgentSession;

/** Turn one writes `kept.ts`; turns two and three, the ones a revert to index 2 cuts, write `a.ts` twice and `b.ts`. */
async function threeTurns() {
	const kept = join(ctx.cwd, "kept.ts"), a = join(ctx.cwd, "a.ts"), b = join(ctx.cwd, "b.ts");
	const one = await recordFileChange(ctx, kept, null, "kept\n");
	const two = await recordFileChange(ctx, a, "a0\n", "a1\n");
	const three = await recordFileChange(ctx, a, "a1\n", "a2\nmore\n");
	const four = await recordFileChange(ctx, b, null, "new\n");
	await writeFile(kept, "kept\n");
	await writeFile(a, "a2\nmore\n");
	await writeFile(b, "new\n");
	const messages = [ask(1), wrote({ changeId: one }), ask(2), wrote({ changeId: two }), ask(3), wrote({ changeId: three }), wrote({ changeId: four })];
	return { kept, a, b, messages };
}

test("a revert puts back every file the cut turns changed, and only those", async () => {
	const { kept, a, b, messages } = await threeTurns();
	const plan = await revertPlan(session(messages), 2);
	assert.deepEqual(plan.files.map((file) => [file.path, file.added, file.removed, file.problem]), [[a, 2, 1, null], [b, 1, 0, null]]);
	assert.equal(plan.unrecorded, false);
	await restoreRevertedFiles(session(messages), 2);
	assert.equal(await readFile(a, "utf8"), "a0\n");
	await assert.rejects(readFile(b), { code: "ENOENT" });
	assert.equal(await readFile(kept, "utf8"), "kept\n");
});

test("one file edited since by another session or by hand: the plan says which, and no file is written", async () => {
	const { a, b, messages } = await threeTurns();
	await writeFile(b, "another session\n");
	const plan = await revertPlan(session(messages), 2);
	assert.deepEqual(plan.files.map((file) => file.problem), [null, "modified"]);
	await assert.rejects(restoreRevertedFiles(session(messages), 2), /后续修改/);
	assert.equal(await readFile(a, "utf8"), "a2\nmore\n", "the file that could go back stays as it is");
	assert.equal(await readFile(b, "utf8"), "another session\n");
});

test("a change the record missed blocks the files part, since what goes back would be incomplete", async () => {
	const { a, messages } = await threeTurns();
	const missed = [...messages, wrote({ command: "codegen", changeWarning: "命令影响超过 200 个文件" })];
	assert.equal((await revertPlan(session(missed), 2)).unrecorded, true);
	await assert.rejects(restoreRevertedFiles(session(missed), 2));
	assert.equal(await readFile(a, "utf8"), "a2\nmore\n");
});

test("a file changed and changed back in the cut turns is not offered", async () => {
	const path = join(ctx.cwd, "same.ts");
	const there = await recordFileChange(ctx, path, "x\n", "y\n"), back = await recordFileChange(ctx, path, "y\n", "x\n");
	await writeFile(path, "edited by someone\n");
	const plan = await revertPlan(session([ask(1), wrote({ changeId: there }), wrote({ changeId: back })]), 0);
	assert.deepEqual(plan.files, []);
});
