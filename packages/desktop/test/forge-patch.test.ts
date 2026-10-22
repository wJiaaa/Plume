/**
 * Rebuilding a unified diff from a host's per-file change list.
 *
 * GitLab and Gitee return fragments with no `diff --git`, no `---`/`+++`, and — for a rename with
 * no edits — no content at all. The whole point of reassembling them is that the app keeps one
 * diff parser and one diff viewer, so what this suite actually asserts is that the output goes
 * back through `parseUnifiedDiff` and comes out as the same shapes GitHub's own patch produces.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnifiedDiff } from "../electron/forge/diff-parse.ts";
import { toPatchFiles } from "../electron/forge/gitee.ts";
import { assembleDiff, countLines } from "../electron/forge/patch.ts";

const HUNK = ["@@ -1,3 +1,4 @@", " context", "-gone", "+added", "+also added"].join("\n");

test("an edited file round-trips through the app's own parser", () => {
	const [file] = parseUnifiedDiff(assembleDiff([{ oldPath: "src/a.ts", newPath: "src/a.ts", patch: HUNK }]));

	assert.equal(file.path, "src/a.ts");
	assert.equal(file.status, "modified");
	assert.equal(file.added, 2);
	assert.equal(file.removed, 1);
	assert.equal(file.hunks.length, 1);
});

test("a new file says so, and its old side is /dev/null", () => {
	const patch = assembleDiff([{ oldPath: "", newPath: "src/new.ts", patch: "@@ -0,0 +1,1 @@\n+hello", added: true }]);

	// Not decoration: a diff naming a real path on the side that does not exist is one `git apply`
	// rejects, and somebody will eventually copy one of these out of the app.
	assert.match(patch, /^--- \/dev\/null$/m);
	assert.match(patch, /new file mode/);
	assert.equal(parseUnifiedDiff(patch)[0].status, "added");
});

test("a deleted file is not an edit that happens to remove every line", () => {
	const patch = assembleDiff([{ oldPath: "src/old.ts", newPath: "", patch: "@@ -1,1 +0,0 @@\n-gone", deleted: true }]);

	assert.match(patch, /deleted file mode/);
	assert.match(patch, /^\+\+\+ \/dev\/null$/m);
	assert.equal(parseUnifiedDiff(patch)[0].status, "deleted");
});

test("a rename with no edits still appears, and under its new name", () => {
	// The case with nothing to draw: no hunks at all, so a parser that only ever learned about
	// hunks would drop the file entirely and the review would not mention that it moved.
	const [file] = parseUnifiedDiff(
		assembleDiff([{ oldPath: "src/old.ts", newPath: "src/new.ts", patch: "", renamed: true }]),
	);

	assert.equal(file.status, "renamed");
	assert.equal(file.path, "src/new.ts");
});

test("a renamed and edited file reports both", () => {
	const [file] = parseUnifiedDiff(
		assembleDiff([{ oldPath: "a.ts", newPath: "b.ts", patch: HUNK, renamed: true }]),
	);

	assert.equal(file.status, "renamed");
	assert.equal(file.path, "b.ts");
	assert.equal(file.added, 2, "the hunks are still read after the rename header");
});

test("a binary file is listed rather than drawn", () => {
	const [file] = parseUnifiedDiff(assembleDiff([{ oldPath: "logo.png", newPath: "logo.png", patch: "", binary: true }]));

	assert.equal(file.path, "logo.png");
	assert.deepEqual(file.hunks, []);
});

test("several files come back as several files", () => {
	const files = parseUnifiedDiff(
		assembleDiff([
			{ oldPath: "a.ts", newPath: "a.ts", patch: HUNK },
			{ oldPath: "b.ts", newPath: "b.ts", patch: HUNK },
		]),
	);
	assert.deepEqual(files.map((f) => f.path), ["a.ts", "b.ts"]);
});

test("a file with no paths at all is skipped rather than emitted headerless", () => {
	assert.equal(assembleDiff([{ oldPath: "", newPath: "", patch: HUNK }]), "");
	assert.equal(assembleDiff([]), "");
});

test("counting lines ignores the file headers, which start with the same characters", () => {
	// `+++ b/x` and `--- a/x` would otherwise be one added and one removed line in every file.
	assert.deepEqual(countLines(["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-old", "+new", "+extra"].join("\n")), {
		added: 2,
		removed: 1,
	});
});

/*
 * Gitee's file list, whose shape is not the one Gitee publishes.
 *
 * Its Swagger declares `patch` and `status` as strings. Against the live API `patch` is an object
 * — GitLab's change, field for field — and `status` is `null`. That was found by pointing the
 * driver at a real pull request and watching it throw, which is exactly the class of thing a unit
 * test cannot find on its own but can stop coming back.
 */

test("Gitee's object-shaped patch is read, not assumed to be a string", () => {
	const [file] = toPatchFiles([
		{
			filename: "readme.md",
			status: null,
			patch: { diff: "@@ -1 +1 @@\n-a\n+b", old_path: "readme.md", new_path: "readme.md" },
		},
	]);

	assert.equal(file.patch, "@@ -1 +1 @@\n-a\n+b");
	assert.equal(file.newPath, "readme.md");
	assert.equal(file.binary, false, "a file with a diff is not binary");
});

test("the flags come off the patch, since `status` arrives null", () => {
	const [added] = toPatchFiles([{ filename: "n.ts", status: null, patch: { diff: "@@ -0,0 +1 @@\n+x", new_file: true } }]);
	assert.equal(added.added, true);

	const [renamed] = toPatchFiles([
		{ filename: "b.ts", status: null, patch: { diff: "", old_path: "a.ts", new_path: "b.ts", renamed_file: true } },
	]);
	assert.equal(renamed.renamed, true);
	assert.equal(renamed.oldPath, "a.ts");
	assert.equal(renamed.binary, false, "a rename with no edits still has something to say");
});

test("a diff Gitee refused to send is listed rather than dropped", () => {
	// The file did change. Omitting it silently is worse than saying there is nothing to show.
	const [file] = toPatchFiles([{ filename: "big.bin", status: null, patch: { diff: "", too_large: true } }]);
	assert.equal(file.binary, true);
	assert.equal(file.newPath, "big.bin");
});

test("a string patch still works, for whichever version returns one", () => {
	const [file] = toPatchFiles([{ filename: "a.ts", status: "added", patch: "@@ -0,0 +1 @@\n+x" }]);
	assert.equal(file.patch, "@@ -0,0 +1 @@\n+x");
	assert.equal(file.added, true);
});
