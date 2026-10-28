/**
 * 记忆文件读不出来时，不拿一个空列表去覆盖它。
 *
 * 从前解析失败和文件不存在一样返回空，于是设置页里随手加一条，就把 `[新条目]` 整份写回，旧记忆
 * 一声不响全没了。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { addMemoryEntry, loadMemory, memoryPath, removeMemoryEntry } from "../src/runtime/memory/memory.ts";

let home: string;

before(async () => {
	home = await mkdtemp(join(tmpdir(), "ly-memory-store-"));
	process.env.PLUME_HOME = home;
});
after(async () => {
	delete process.env.PLUME_HOME;
	await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

test("an unreadable memory file reads as empty but is never written over", async () => {
	const broken = '{"entries": [{"id": "mem_1", "content": "用 pnpm", "createdAt": 1, "updatedAt": 1}, {"id": "mem_2", "con';
	await writeFile(memoryPath(), broken);

	assert.deepEqual((await loadMemory()).entries, [], "注入照旧当成空，会话照常开");
	await assert.rejects(addMemoryEntry("新的一条"), /读不出来/);
	await assert.rejects(removeMemoryEntry("mem_1"), /读不出来/);
	assert.equal(await readFile(memoryPath(), "utf8"), broken, "原文件一个字节没动");
});

test("a missing file is a real empty, and writes go through", async () => {
	await rm(memoryPath(), { force: true });
	const entry = await addMemoryEntry("回答用中文");
	assert.deepEqual((await loadMemory()).entries.map((e) => e.id), [entry.id]);
});
