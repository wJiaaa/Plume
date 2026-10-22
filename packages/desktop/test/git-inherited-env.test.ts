/**
 * Every git call ignores a `GIT_DIR` it inherited — including the two that start git themselves.
 *
 * `git-exec` drops the redirecting variables for everything that goes through it. The batch blob
 * reader spawns git directly (it writes to stdin) and the checkout matcher used its own `execFile`,
 * so a Plume started from a git hook read blobs and remotes from whichever repository the hook was
 * running in. The variable is set before the modules load, because that is when the environment is
 * built.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

const exec = promisify(execFile);
const roots: string[] = [];
after(async () => {
	await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function repo(origin: string, body: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-env-"));
	roots.push(dir);
	const git = (...args: string[]) => exec("git", args, { cwd: dir, env: { ...process.env, GIT_DIR: undefined } });
	await git("init", "-q", "-b", "main");
	await git("config", "user.email", "t@example.com");
	await git("config", "user.name", "T");
	await git("remote", "add", "origin", `https://github.com/${origin}.git`);
	await writeFile(join(dir, "file.txt"), body);
	await git("add", "-A");
	await git("commit", "-qm", "init");
	return dir;
}

let wanted = "";
let elsewhere = "";
let modules: { findLocalCheckout: typeof import("../electron/git-remote.ts").findLocalCheckout; readBlobs: typeof import("../electron/git-blobs.ts").readBlobs };

before(async () => {
	wanted = await repo("owner/wanted", "wanted\n");
	elsewhere = await repo("owner/elsewhere", "elsewhere\n");
	process.env.GIT_DIR = join(elsewhere, ".git");
	const [{ findLocalCheckout }, { readBlobs }] = await Promise.all([import("../electron/git-remote.ts"), import("../electron/git-blobs.ts")]);
	modules = { findLocalCheckout, readBlobs };
});

test("a checkout is matched by its own origin, not the inherited repository's", async () => {
	assert.equal(await modules.findLocalCheckout("owner/wanted", [wanted]), wanted);
});

test("blobs are read from the directory asked about", async () => {
	const [blob] = await modules.readBlobs(wanted, ["HEAD:file.txt"]);
	assert.equal(blob?.content?.toString("utf8"), "wanted\n");
});
