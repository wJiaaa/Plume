import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gatherMemory } from "../src/runtime/memory/memory-inject.ts";
import { forgetLesson, readLessons, recordLesson } from "../src/runtime/memory/project-memory.ts";
import { SessionLog } from "../src/runtime/record/session-log.ts";
import { SessionStore } from "../src/session/store.ts";

/** 项目记忆注入进提示词的全文：各文件的片段按顺序接起来。 */
const projectText = (memory: { projectMemoryFiles: { content: string }[] }) => memory.projectMemoryFiles.map((file) => file.content).join("");

let home: string;
let project: string;
before(async () => {
	home = await mkdtemp(join(tmpdir(), "ly-snap-home-"));
	project = await mkdtemp(join(tmpdir(), "ly-snap-proj-"));
	process.env.PLUME_HOME = home;
});
after(async () => {
	delete process.env.PLUME_HOME;
	await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	await rm(project, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

test("learning mid-session leaves the prompt's memory untouched until the session compacts", async () => {
	const store = new SessionStore(join(home, "sessions"));
	const log = new SessionLog(store, () => {}, await store.create(project, "m"));
	const scope = log.meta.id;
	await recordLesson(project, { text: "用 pnpm 不用 npm" });
	const first = await gatherMemory(project, true, 0, true, false, scope);
	assert.match(projectText(first), /pnpm/);

	// The learn call and its result are in the history; the system prompt keeps its bytes.
	await recordLesson(project, { text: "测试用 node:test" });
	assert.equal(projectText(await gatherMemory(project, true, 0, true, false, scope)), projectText(first));
	assert.match(projectText(await gatherMemory(project, true, 0, true, false)), /node:test/, "callers without a session read fresh");

	// A summary may have folded the learn call away; the refreshed memory carries it instead.
	await log.emit({ type: "compacted", before: 10, after: 4, kept: 2, summary: "s" });
	const refreshed = await gatherMemory(project, true, 0, true, false, scope);
	assert.match(projectText(refreshed), /node:test/);

	// A person deleting a wrong lesson wants it gone now, not after the next compaction.
	const [wrong] = await readLessons(project);
	await forgetLesson(project, wrong.at);
	assert.doesNotMatch(projectText(await gatherMemory(project, true, 0, true, false, scope)), /node:test/);
});
