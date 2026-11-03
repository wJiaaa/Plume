/**
 * A ref whose name starts with `-` is still a ref, not an option.
 *
 * Against real git, because the failure is git's own parser: a clone that carries
 * `refs/tags/--output=pwned` made `git describe` answer `--output=pwned`, and the release panel
 * then ran `git log --output=pwned..HEAD` — which wrote a file into the repository. Every check
 * below is that the file is not there and the answer is the one the ref asked for.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { createBranch, deleteBranch, diffRefs, gitLog, pushBranch } from "../electron/git/git-history.ts";
import { getReleaseInfo } from "../electron/git/git-release.ts";

const exec = promisify(execFile);
const sh = (cwd: string, ...args: string[]) => exec("git", args, { cwd }).then((out) => out.stdout.trim());

let base: string;
let repo: string;

before(async () => {
	base = mkdtempSync(join(tmpdir(), "plume-r3-git-"));
	repo = join(base, "repo");
	await exec("git", ["init", "-q", "-b", "main", repo]);
	await sh(repo, "config", "user.email", "t@example.com");
	await sh(repo, "config", "user.name", "t");
	await sh(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "a.txt"), "one\n");
	await sh(repo, "add", "a.txt");
	await sh(repo, "commit", "-q", "-m", "first");
	/*
	 * Written with `update-ref`, which is how a fetch writes them too: `git tag` and `git branch`
	 * refuse such names, a clone does not.
	 */
	await sh(repo, "update-ref", "refs/tags/--output=pwned-tag", "HEAD");
	await sh(repo, "update-ref", "refs/heads/--output=pwned-branch", "HEAD");
	writeFileSync(join(repo, "a.txt"), "two\n");
	await sh(repo, "commit", "-q", "-am", "second");
});

after(() => {
	rmSync(base, { recursive: true, force: true });
});

/** Anything git was talked into writing would land beside `.git`, named after the option's value. */
function stray(): string[] {
	return readdirSync(repo).filter((name) => name.startsWith("pwned"));
}

test("release info reads the commits since a tag named like an option", async () => {
	const info = await getReleaseInfo(repo);
	assert.equal(info.latestTag, "--output=pwned-tag");
	assert.deepEqual(
		info.commitsSinceTag.map((commit) => commit.subject),
		["second"],
	);
	assert.deepEqual(stray(), []);
});

test("the log of a branch named like an option is that branch's log", async () => {
	const commits = await gitLog(repo, 60, "--output=pwned-branch");
	assert.deepEqual(
		commits.map((commit) => commit.subject),
		["first"],
	);
	assert.deepEqual(stray(), []);
});

test("a diff from a ref named like an option compares against that ref", async () => {
	const diff = await diffRefs(repo, "--output=pwned-branch", "HEAD");
	assert.deepEqual(
		diff.files.map((file) => file.path),
		["a.txt"],
	);
	assert.deepEqual(stray(), []);
});

test("a branch can be cut from, and deleted by, a name that starts with a dash", async () => {
	const made = await createBranch(repo, "from-odd", "--output=pwned-branch");
	assert.equal(made.ok, true, made.error);
	assert.equal(await sh(repo, "rev-parse", "from-odd"), await sh(repo, "rev-parse", "refs/heads/--output=pwned-branch"));
	await sh(repo, "switch", "-q", "main");

	await sh(repo, "update-ref", "refs/heads/--force", "HEAD");
	const dropped = await deleteBranch(repo, "--force");
	assert.equal(dropped.ok, true, dropped.error);
	assert.equal(existsSync(join(repo, ".git", "refs", "heads", "--force")), false);
	assert.deepEqual(stray(), []);
});

test("pushing a branch named like an option pushes that branch", async () => {
	const remote = join(base, "remote.git");
	await exec("git", ["init", "-q", "--bare", remote]);
	await sh(repo, "remote", "add", "origin", remote);
	// Checked out, so `pushBranch` takes it for the current branch. Bare, `push -u origin --dry-run`
	// would have pretended to push and sent nothing.
	await sh(repo, "update-ref", "refs/heads/--dry-run", "HEAD");
	await sh(repo, "symbolic-ref", "HEAD", "refs/heads/--dry-run");
	try {
		const pushed = await pushBranch(repo);
		assert.equal(pushed.ok, true, pushed.error);
		assert.equal(await sh(remote, "rev-parse", "refs/heads/--dry-run"), await sh(repo, "rev-parse", "HEAD"));
	} finally {
		await sh(repo, "symbolic-ref", "HEAD", "refs/heads/main");
	}
});
