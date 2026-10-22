/**
 * Reading a patch nobody generated for us.
 *
 * The workspace panel diffs two strings it holds; a pull request's diff arrives as text from
 * `gh`, carrying everything git puts in a patch — binaries, renames, mode changes, missing
 * trailing newlines. The parser has to survive all of it, because one PNG in a forty-file review
 * must not be the reason the reviewer sees nothing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnifiedDiff } from "../electron/forge/diff-parse.ts";

test("an ordinary edit keeps both sides' line numbers", () => {
	const [file] = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,3 +10,4 @@ function boot() {
   const x = 1;
-  return x;
+  const y = 2;
+  return x + y;
 }`);

	assert.equal(file.path, "src/app.ts");
	assert.equal(file.status, "modified");
	assert.equal(file.added, 2);
	assert.equal(file.removed, 1);

	const [hunk] = file.hunks;
	assert.equal(hunk.oldStart, 10);
	assert.equal(hunk.newStart, 10);
	assert.deepEqual(
		hunk.lines.map((l) => l.type),
		["context", "remove", "add", "add", "context"],
	);
	// The removed line was old #11; the first added line is new #11.
	assert.equal(hunk.lines[1].oldLine, 11);
	assert.equal(hunk.lines[2].newLine, 11);
	// Context after the change advanced both sides independently.
	assert.equal(hunk.lines[4].oldLine, 12);
	assert.equal(hunk.lines[4].newLine, 13);
});

test("a new file is marked as added rather than modified", () => {
	const [file] = parseUnifiedDiff(`diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;`);

	assert.equal(file.status, "added");
	assert.equal(file.added, 2);
	assert.equal(file.removed, 0);
});

test("a deleted file is marked as deleted", () => {
	const [file] = parseUnifiedDiff(`diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const gone = true;`);

	assert.equal(file.status, "deleted");
	assert.equal(file.removed, 1);
});

test("a rename reports the new path", () => {
	const [file] = parseUnifiedDiff(`diff --git a/old/name.ts b/new/name.ts
similarity index 96%
rename from old/name.ts
rename to new/name.ts`);

	assert.equal(file.status, "renamed");
	assert.equal(file.path, "new/name.ts");
	assert.deepEqual(file.hunks, [], "a pure rename has nothing to show");
});

test("a binary file is listed but has no lines", () => {
	const files = parseUnifiedDiff(`diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/after.ts b/after.ts
--- a/after.ts
+++ b/after.ts
@@ -1,1 +1,1 @@
-a
+b`);

	assert.equal(files.length, 2, "the binary is still a changed file");
	assert.deepEqual(files[0].hunks, []);
	// And the file after it parses normally — the binary did not derail the stream.
	assert.equal(files[1].path, "after.ts");
	assert.equal(files[1].added, 1);
});

test("a path with a space survives the header", () => {
	const [file] = parseUnifiedDiff(`diff --git "a/src/my file.ts" "b/src/my file.ts"
--- "a/src/my file.ts"
+++ "b/src/my file.ts"
@@ -1,1 +1,1 @@
-a
+b`);
	assert.equal(file.path, "src/my file.ts");
});

test('"\\ No newline at end of file" is not counted as a line', () => {
	const [file] = parseUnifiedDiff(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,1 +1,1 @@
-a
\\ No newline at end of file
+b`);
	assert.equal(file.added, 1);
	assert.equal(file.removed, 1);
	assert.equal(file.hunks[0].lines.length, 2);
});

test("several files come back in order, each with its own counts", () => {
	const files = parseUnifiedDiff(`diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -1,0 +1,1 @@
+one
diff --git a/two.ts b/two.ts
--- a/two.ts
+++ b/two.ts
@@ -1,1 +1,0 @@
-two`);

	assert.deepEqual(
		files.map((f) => [f.path, f.added, f.removed]),
		[
			["one.ts", 1, 0],
			["two.ts", 0, 1],
		],
	);
});

test("an empty patch is an empty list, not a crash", () => {
	assert.deepEqual(parseUnifiedDiff(""), []);
	assert.deepEqual(parseUnifiedDiff("\n\n"), []);
});
