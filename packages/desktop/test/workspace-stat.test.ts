/**
 * 输入框底下那条改动统计：一次 `status --branch` 顶替了「是不是仓库、哪个分支、有没有第一个提交」
 * 三次 git 调用，这里守着那三个答案没跟着变。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";

import { workspaceStat } from "../electron/git/git-status.ts";
import { statusBranch } from "../electron/git/git-parse.ts";
import { gitBranch } from "../electron/git/git-probe.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
after(async () => {
	await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execFileAsync("git", args, { cwd });
}

async function repo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-stat-"));
	roots.push(dir);
	await git(dir, "init", "-q", "-b", "trunk");
	await git(dir, "config", "user.email", "t@example.com");
	await git(dir, "config", "user.name", "T");
	return dir;
}

test("the header names the branch the way `gitBranch` does, in every form git writes it", () => {
	assert.deepEqual(statusBranch("main...origin/main [ahead 1, behind 2]"), { branch: "main", born: true });
	assert.deepEqual(statusBranch("feature/x"), { branch: "feature/x", born: true });
	assert.deepEqual(statusBranch("main...origin/main [gone]"), { branch: "main", born: true });
	assert.deepEqual(statusBranch("No commits yet on trunk"), { branch: "trunk", born: false });
	assert.deepEqual(statusBranch("Initial commit on trunk"), { branch: "trunk", born: false });
	assert.deepEqual(statusBranch("HEAD (no branch)"), { branch: null, born: true });
});

test("a repository with no commits counts its new files and names the branch they will land on", async () => {
	const dir = await repo();
	await writeFile(join(dir, "a.ts"), "one\ntwo\n");
	const stat = await workspaceStat(dir);
	assert.deepEqual(stat, { branch: "trunk", added: 2, removed: 0, files: 1 });
	assert.equal(stat.branch, await gitBranch(dir));
});

test("an edit on a branch and on a detached HEAD count the same, and only the branch has a name", async () => {
	const dir = await repo();
	await writeFile(join(dir, "a.ts"), "one\ntwo\n");
	await git(dir, "add", "-A");
	await git(dir, "commit", "-qm", "init");
	await writeFile(join(dir, "a.ts"), "one\nthree\n");
	assert.deepEqual(await workspaceStat(dir), { branch: "trunk", added: 1, removed: 1, files: 1 });
	await git(dir, "checkout", "-q", "--detach");
	assert.deepEqual(await workspaceStat(dir), { branch: null, added: 1, removed: 1, files: 1 });
	assert.equal(await gitBranch(dir), null);
});

test("a directory that is not a repository has nothing uncommitted", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-stat-plain-"));
	roots.push(dir);
	await writeFile(join(dir, "a.ts"), "one\n");
	assert.deepEqual(await workspaceStat(dir), { branch: null, added: 0, removed: 0, files: 0 });
});
