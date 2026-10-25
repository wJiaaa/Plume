/**
 * Recognising a repository from the URL a checkout pushes to.
 *
 * This decides whether opening a review lands you in the code or in an empty scratch directory,
 * and it is entirely string handling over the several shapes git accepts. Worth pinning, because
 * the failure is silent in both directions: too strict and a checkout that is right there goes
 * unnoticed; too loose and questions about one repository get answered from another.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRemote, repoFromRemote } from "../electron/git/git-remote.ts";

test("the two forms git hands out", () => {
	assert.equal(repoFromRemote("git@github.com:kittors/plume.git"), "kittors/plume");
	assert.equal(repoFromRemote("https://github.com/kittors/plume.git"), "kittors/plume");
});

test("with and without the .git suffix, and with a trailing slash", () => {
	assert.equal(repoFromRemote("https://github.com/kittors/plume"), "kittors/plume");
	assert.equal(repoFromRemote("https://github.com/kittors/plume/"), "kittors/plume");
	assert.equal(repoFromRemote("  git@github.com:kittors/plume.git\n"), "kittors/plume");
});

test("ssh:// spelling, which is a URL rather than the scp-like form", () => {
	assert.equal(repoFromRemote("ssh://git@github.com/kittors/plume.git"), "kittors/plume");
});

test("a self-hosted instance is still owner/name", () => {
	assert.equal(repoFromRemote("https://git.example.com/kittors/plume.git"), "kittors/plume");
	assert.equal(repoFromRemote("git@git.example.com:kittors/plume.git"), "kittors/plume");
});

test("nested groups keep only the last two segments", () => {
	// GitLab subgroups: the repository is still identified by owner and name.
	assert.equal(repoFromRemote("https://gitlab.com/group/sub/plume.git"), "sub/plume");
});

test("things that are not remotes are not repositories", () => {
	for (const input of ["", "   ", "not a url", "https://github.com/", "https://github.com/onlyowner"]) {
		assert.equal(repoFromRemote(input), null, `${input!} should not parse`);
	}
});

test("a local path is not a remote we can match on", () => {
	// A `file:` or plain path remote has no owner, so there is nothing to compare against a
	// GitHub repository — and guessing from the directory name is exactly the wrong answer.
	assert.equal(repoFromRemote("/Users/me/code/plume"), null);
});

test("the host comes with it, from every spelling", () => {
	assert.deepEqual(parseRemote("git@github.com:kittors/plume.git"), { host: "github.com", owner: "kittors", name: "plume" });
	assert.deepEqual(parseRemote("github.com:kittors/plume"), { host: "github.com", owner: "kittors", name: "plume" });
	assert.deepEqual(parseRemote("ssh://git@git.example.com:2222/group/plume.git"), { host: "git.example.com", owner: "group", name: "plume" });
	assert.deepEqual(parseRemote("https://ghe.example.com/kittors/plume"), { host: "ghe.example.com", owner: "kittors", name: "plume" });
});

test("an http(s) remote keeps its port, an ssh one does not", () => {
	// The account on that server is found by the `host:port` of its base URL; the ssh port is not where the web side is.
	assert.deepEqual(parseRemote("https://ghe.example.com:8443/kittors/plume.git"), { host: "ghe.example.com:8443", owner: "kittors", name: "plume" });
	assert.deepEqual(parseRemote("http://127.0.0.1:63366/fixture/repo.git"), { host: "127.0.0.1:63366", owner: "fixture", name: "repo" });
	assert.deepEqual(parseRemote("ssh://git@git.example.com:2222/group/plume.git"), { host: "git.example.com", owner: "group", name: "plume" });
	// The default port is dropped, as `new URL(...).host` drops it from the account's base URL.
	assert.equal(parseRemote("https://ghe.example.com:443/kittors/plume")?.host, "ghe.example.com");
});

test("a Windows path is not an scp remote", () => {
	// `C:` looks like `host:` to a pattern that does not know a drive letter when it sees one.
	assert.equal(parseRemote("C:/Users/me/code/plume"), null);
	assert.equal(parseRemote("C:\\Users\\me\\code\\plume"), null);
});
