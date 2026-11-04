/**
 * Which conversations go with a project when it is removed.
 *
 * The report was that a project deleted from disk could not be removed from Plume. Archiving only
 * the chats whose `cwd` matched exactly was half of why: the sidebar builds a group per distinct
 * `cwd`, so anything started one directory down came back as its own group the moment the entry
 * was dropped.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionScratchDirs, sessionUnderProject } from "../src/lib/project-scope.ts";

test("a project owns the chats started inside it, at any depth", () => {
	assert.ok(sessionUnderProject("/Users/x/proj", "/Users/x/proj"));
	assert.ok(sessionUnderProject("/Users/x/proj", "/Users/x/proj/packages/core"));
	assert.ok(sessionUnderProject("/Users/x/proj", "/Users/x/proj/a/b/c/d"));
});

test("a sibling whose name merely starts the same is not inside it", () => {
	// The separator is the whole guard: without it `proj-old` reads as living in `proj`.
	assert.ok(!sessionUnderProject("/Users/x/proj", "/Users/x/proj-old"));
	assert.ok(!sessionUnderProject("/Users/x/proj", "/Users/x/project"));
	assert.ok(!sessionUnderProject("/Users/x/proj", "/Users/x"));
	assert.ok(!sessionUnderProject("/Users/x/proj", "/elsewhere"));
});

test("a trailing slash on the configured path does not lose the project's own chats", () => {
	// A configured project path and a session's `cwd` arrive from different places, and only one
	// of them tends to carry a trailing separator.
	assert.ok(sessionUnderProject("/Users/x/proj/", "/Users/x/proj"));
	assert.ok(sessionUnderProject("/Users/x/proj/", "/Users/x/proj/packages/core"));
	assert.ok(!sessionUnderProject("/Users/x/proj/", "/Users/x/proj-old"));
});

test("Windows paths are matched on their own separator", () => {
	assert.ok(sessionUnderProject("C:\\Users\\x\\proj", "C:\\Users\\x\\proj\\packages"));
	assert.ok(sessionUnderProject("C:\\Users\\x\\proj\\", "C:\\Users\\x\\proj"));
	assert.ok(!sessionUnderProject("C:\\Users\\x\\proj", "C:\\Users\\x\\proj-old"));
});

test("a root path is not eaten by the trailing-slash trim", () => {
	// `"/".replace(/[/\\]+$/, "")` is the empty string, which would match everything.
	assert.ok(sessionUnderProject("/", "/Users/x/proj"));
	assert.ok(sessionUnderProject("/", "/"));
});

/*
 * A project can be several folders, and the chats in any of them are its chats.
 *
 * This is what archiving and removing read. A project whose second source folder kept its
 * conversations behind would archive to a half-empty row — and dropping the entry would bring that
 * folder straight back as a group of its own, which is 「删不掉」 wearing another path.
 */
test("a project made of several folders owns the chats in all of them", () => {
	const folders = ["/Users/x/app", "/Users/x/api"];
	assert.ok(sessionUnderProject(folders, "/Users/x/app"));
	assert.ok(sessionUnderProject(folders, "/Users/x/api"));
	assert.ok(sessionUnderProject(folders, "/Users/x/api/src/routes"));
	assert.ok(!sessionUnderProject(folders, "/Users/x/other"));
	assert.ok(!sessionUnderProject(folders, "/Users/x/api-old"));
});

test("one folder given as a list means what it means given as a string", () => {
	assert.ok(sessionUnderProject(["/Users/x/proj"], "/Users/x/proj/packages"));
	assert.ok(!sessionUnderProject(["/Users/x/proj"], "/Users/x/proj-old"));
	assert.ok(!sessionUnderProject([], "/Users/x/proj"));
});

test("a conversation's scratch directories sit under the scratch root, whichever order the roots come in", () => {
	const roots = ["/h/.plume/workspaces", "/h/.plume/scratch"];
	assert.deepEqual(sessionScratchDirs(roots, ["side", "main"]), ["/h/.plume/scratch/side", "/h/.plume/scratch/main"]);
	assert.deepEqual(sessionScratchDirs([...roots].reverse(), ["side", null]), ["/h/.plume/scratch/side"]);
	assert.deepEqual(sessionScratchDirs(["C:\\Users\\x\\.plume\\scratch"], ["s"]), ["C:\\Users\\x\\.plume\\scratch\\s"]);
	// 根还没读回来：没有地方可找，不是拼一个猜的路径。
	assert.deepEqual(sessionScratchDirs([], ["s"]), []);
});
