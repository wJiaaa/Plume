/**
 * 同一个目录的会话、子代理共用一套语言服务器（`lsp/manager.ts` 的 `codeIntelFor`）。
 *
 * 一套 tsserver 几百兆：三个会话开在同一个项目里，原来是三套。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CODE_INTEL_KEY, CodeIntelManager, codeIntelFor, releaseCodeIntel } from "../src/lsp/manager.ts";

async function project(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-lsp-shared-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** 数这一套被停了几次：最后一个人还回去时才该停。 */
function countDisposals(manager: CodeIntelManager): () => number {
	let n = 0;
	const dispose = manager.dispose.bind(manager);
	manager.dispose = async () => {
		n += 1;
		await dispose();
	};
	return () => n;
}

test("同一个目录：两个会话拿到同一套，最后一个还回去才停", async (t) => {
	const root = await project(t);
	const a = new Map<string, unknown>();
	const b = new Map<string, unknown>();
	const manager = codeIntelFor(a, root);
	assert.equal(codeIntelFor(b, `${root}/.`), manager, "同一个目录换个写法也是同一套");
	assert.equal(codeIntelFor(a, root), manager, "同一个会话再问一次不多借");
	const disposed = countDisposals(manager);

	await releaseCodeIntel(a);
	assert.equal(disposed(), 0, "还有会话在用");
	assert.equal(a.has(CODE_INTEL_KEY), false);
	await releaseCodeIntel(b);
	assert.equal(disposed(), 1);
	assert.notEqual(codeIntelFor(a, root), manager, "停了以后再要，是新起的一套");
	await releaseCodeIntel(a);
});

test("不同目录各用各的：worktree 里是另一批文件", async (t) => {
	const one = await project(t);
	const two = await project(t);
	const a = new Map<string, unknown>();
	const b = new Map<string, unknown>();
	t.after(() => Promise.all([releaseCodeIntel(a), releaseCodeIntel(b)]).then(() => {}));
	assert.notEqual(codeIntelFor(a, one), codeIntelFor(b, two));
});

test("state 里自己装着管理器的，用它、停它，不进共用的那份", async (t) => {
	const root = await project(t);
	const own = new CodeIntelManager([]);
	const disposed = countDisposals(own);
	const state = new Map<string, unknown>([[CODE_INTEL_KEY, own]]);
	assert.equal(codeIntelFor(state, root), own);
	const other = new Map<string, unknown>();
	assert.notEqual(codeIntelFor(other, root), own);
	await releaseCodeIntel(state);
	assert.equal(disposed(), 1);
	await releaseCodeIntel(other);
});
