/**
 * Which situation a checkout is in, decided on plain data.
 *
 * The bug this exists to prevent: `git status` only reports `ahead` when the branch has an upstream,
 * so a branch that has never been pushed answered `ahead: 0` and the panel said 「已同步」 about a
 * repository whose every commit was still local. That is not a rendering mistake — it is the panel
 * asking a question that only has an answer in one of the seven cases it can be in.
 *
 * The order of the tests below is the order of the checks, because for two pairs the order *is* the
 * rule: a rebase detaches HEAD, and a fresh repository has both a branch and possibly a remote.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { GitOperation } from "@plume/contract";
import {
	classifyRemote,
	defaultRemote,
	hasNoCommits,
	remoteOfUpstream,
} from "../electron/git/git-remote-state.ts";

const base = {
	header: "main...origin/main",
	branch: "main" as string | null,
	upstream: "origin/main" as string | null,
	operation: null as GitOperation | null,
	remotes: ["origin"],
};

const classify = (over: Partial<typeof base> = {}) => classifyRemote({ ...base, ...over });

// ---------------------------------------------------------------------------
// The ordinary case
// ---------------------------------------------------------------------------

test("a branch with an upstream is tracking it, and names the remote it belongs to", () => {
	assert.deepEqual(classify(), { state: "tracking", remote: "origin" });
});

// ---------------------------------------------------------------------------
// The case the whole thing was written for
// ---------------------------------------------------------------------------

test("a branch with no upstream is not 「已同步」", () => {
	/*
	 * The report. `git status` gives `## main` with no ahead field, so `ahead` parses to 0 — and
	 * read as a number that is indistinguishable from a branch that is genuinely up to date.
	 */
	assert.deepEqual(classify({ header: "main", upstream: null }), { state: "no-upstream", remote: "origin" });
});

test("a repository with no remotes is left alone", () => {
	// Nothing to be behind, nothing to publish to. A local-only repository is a normal way to work
	// and the panel has no business nagging about it.
	assert.deepEqual(classify({ header: "main", upstream: null, remotes: [] }), { state: "none", remote: null });
});

// ---------------------------------------------------------------------------
// Order-dependent pairs
// ---------------------------------------------------------------------------

test("a rebase in progress is a rebase, not a detached HEAD", () => {
	/*
	 * Both are true at once — git detaches HEAD for the whole of a rebase — and only one of them is
	 * worth telling someone. Asked in the other order every stopped rebase reads as 「当前不在任何
	 * 分支上」, which is accurate and useless.
	 */
	assert.deepEqual(classify({ branch: null, header: "HEAD (no branch)", upstream: null, operation: "rebase" }), {
		state: "in-progress",
		remote: null,
	});
});

test("a merge in progress is caught even though the branch is intact", () => {
	// A conflicted merge does not detach, so nothing else in the status would give it away.
	assert.deepEqual(classify({ operation: "merge" }), { state: "in-progress", remote: null });
});

test("a fresh repository has nothing to push, remote or not", () => {
	/*
	 * `## No commits yet on main` — a branch name, possibly a configured remote, and no commit. If
	 * the remote questions were asked first this would be offered 「发布分支」, and pushing a branch
	 * with no commits fails.
	 */
	assert.deepEqual(classify({ header: "No commits yet on main", upstream: null }), {
		state: "no-commits",
		remote: null,
	});
	assert.deepEqual(classify({ header: "No commits yet on main", upstream: null, remotes: [] }), {
		state: "no-commits",
		remote: null,
	});
});

test("a detached HEAD with no operation is simply detached", () => {
	assert.deepEqual(classify({ branch: null, header: "HEAD (no branch)", upstream: null }), {
		state: "detached",
		remote: null,
	});
});

test("every operation suspends the buttons", () => {
	const operations: GitOperation[] = ["rebase", "merge", "cherry-pick", "revert", "bisect"];
	for (const operation of operations) {
		assert.equal(classify({ operation }).state, "in-progress", operation);
	}
});

// ---------------------------------------------------------------------------
// Which remote
// ---------------------------------------------------------------------------

test("the remote is read off the upstream, not assumed to be origin", () => {
	assert.deepEqual(classify({ upstream: "upstream/main", remotes: ["upstream"] }), {
		state: "tracking",
		remote: "upstream",
	});
});

test("an upstream is split against the configured remotes, longest match first", () => {
	/*
	 * `origin/feature/x` is genuinely ambiguous as a string: it is branch `feature/x` on `origin`,
	 * or branch `x` on a remote called `origin/feature`. Remote names may contain slashes, so only
	 * the configured list can decide, and the longer name is the one that was actually configured.
	 */
	assert.equal(remoteOfUpstream("origin/feature/x", ["origin"]), "origin");
	assert.equal(remoteOfUpstream("origin/feature/x", ["origin", "origin/feature"]), "origin/feature");
	assert.equal(remoteOfUpstream("elsewhere/main", ["origin"]), null);
});

test("one remote is used whatever it is called", () => {
	assert.equal(defaultRemote(["fork"]), "fork");
});

test("several remotes fall back to origin, and decline when there is none", () => {
	assert.equal(defaultRemote(["upstream", "origin"]), "origin");
	/*
	 * Declining is the point. Picking the first of two remotes would push someone's work to whoever
	 * happened to be listed first in the config, and a push to the wrong remote is not a mistake
	 * anyone notices quickly.
	 */
	assert.equal(defaultRemote(["upstream", "fork"]), null);
	assert.equal(defaultRemote([]), null);
});

test("with several remotes and no origin, an untracked branch offers nothing to press", () => {
	assert.deepEqual(classify({ header: "main", upstream: null, remotes: ["upstream", "fork"] }), {
		state: "no-upstream",
		remote: null,
	});
});

// ---------------------------------------------------------------------------
// The header reading
// ---------------------------------------------------------------------------

test("「no commits yet」 is recognised, and an ordinary branch is not mistaken for it", () => {
	assert.equal(hasNoCommits("No commits yet on main"), true);
	assert.equal(hasNoCommits("main...origin/main [ahead 1]"), false);
	assert.equal(hasNoCommits("HEAD (no branch)"), false);
	assert.equal(hasNoCommits(""), false);
});
