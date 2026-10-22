/**
 * A staged rename, read the way the panel and the change bar read it.
 *
 * `status -z` writes a rename as two fields — the new path, then the old one on its own — and
 * `--numstat` without `-z` writes it as `src/{a => b}`. Both readers once took the second field for
 * another status row, which put a phantom `/old-name.ts` in the panel and a second file on the bar.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";

import { gitStatus, workspaceStat } from "../electron/git/git-status.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
after(async () => {
	await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execFileAsync("git", args, { cwd });
}

async function renamedRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-rename-"));
	roots.push(dir);
	await git(dir, "init", "-q", "-b", "main");
	await git(dir, "config", "user.email", "t@example.com");
	await git(dir, "config", "user.name", "T");
	await mkdir(join(dir, "src"));
	await writeFile(join(dir, "src", "old-name.ts"), "export const a = 1;\nexport const b = 2;\n");
	await git(dir, "add", "-A");
	await git(dir, "commit", "-qm", "init");
	await git(dir, "mv", "src/old-name.ts", "src/new-name.ts");
	return dir;
}

test("a staged rename is one staged file, and nothing unstaged", async () => {
	const status = await gitStatus(await renamedRepo());
	assert.deepEqual(
		status.staged.map((file) => ({ path: file.path, status: file.status, added: file.added, removed: file.removed })),
		[{ path: "src/new-name.ts", status: "renamed", added: 0, removed: 0 }],
	);
	assert.deepEqual(status.unstaged, []);
});

test("a rename counts as one file with no lines changed on the change bar", async () => {
	const stat = await workspaceStat(await renamedRepo());
	assert.deepEqual({ files: stat.files, added: stat.added, removed: stat.removed }, { files: 1, added: 0, removed: 0 });
});

test("a renamed and edited file counts its edit, not the whole file", async () => {
	const dir = await renamedRepo();
	await writeFile(join(dir, "src", "new-name.ts"), "export const a = 1;\nexport const b = 3;\n");
	await git(dir, "add", "-A");
	const status = await gitStatus(dir);
	assert.equal(status.staged.length, 1);
	assert.deepEqual({ added: status.staged[0].added, removed: status.staged[0].removed }, { added: 1, removed: 1 });
	const stat = await workspaceStat(dir);
	assert.deepEqual({ files: stat.files, added: stat.added, removed: stat.removed }, { files: 1, added: 1, removed: 1 });
});
