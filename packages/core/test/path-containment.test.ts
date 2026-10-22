import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { test } from "node:test";
import { relativeInside, resolveInside, within, withinOrIs } from "../src/platform.ts";

test("the root itself is inside for withinOrIs and not for within", () => {
	assert.equal(relativeInside("/a/b", "/a/b", posix), "");
	assert.equal(relativeInside("/a/b", "/a/b/", posix), "", "a trailing separator is the same place");
	if (process.platform !== "win32") {
		assert.equal(withinOrIs("/a/b", "/a/b"), true);
		assert.equal(within("/a/b", "/a/b"), false);
		assert.equal(within("/a/b", "/a/b/c"), true);
	}
});

test("a folder whose name starts with two dots is under the root, not above it", () => {
	assert.equal(relativeInside("/a/b", "/a/b/..cache/x", posix), "..cache/x");
	assert.equal(relativeInside("C:\\a\\b", "C:\\a\\b\\..cache\\x", win32), "..cache\\x");
});

test("the parent and its other children are outside", () => {
	assert.equal(relativeInside("/a/b", "/a", posix), null);
	assert.equal(relativeInside("/a/b", "/a/bc", posix), null, "a shared string prefix is not containment");
	assert.equal(relativeInside("C:\\a\\b", "C:\\a", win32), null);
	assert.equal(relativeInside("C:\\a\\b", "C:\\a\\bc\\d", win32), null);
});

test("Windows paths are compared with their own separator, across case and drives", () => {
	assert.equal(relativeInside("C:\\Users\\me", "C:\\Users\\me\\src\\a.ts", win32), "src\\a.ts");
	assert.equal(relativeInside("C:\\Users\\me", "c:\\users\\ME\\src", win32), "src", "drive letters and names fold case");
	assert.equal(relativeInside("C:\\Users\\me", "D:\\Users\\me\\src", win32), null, "another drive is never inside");
});

test("relative paths are never inside anything", () => {
	assert.equal(relativeInside("a/b", "a/b/c", posix), null);
	assert.equal(relativeInside("/a/b", "c", posix), null);
});

test("resolveInside refuses absolute names and names that climb out", () => {
	if (process.platform === "win32") return;
	assert.equal(resolveInside("/a/b", "c/d"), "/a/b/c/d");
	assert.equal(resolveInside("/a/b", "."), "/a/b");
	assert.equal(resolveInside("/a/b", "..cache"), "/a/b/..cache");
	assert.equal(resolveInside("/a/b", "../x"), null);
	assert.equal(resolveInside("/a/b", "../bc/d"), null);
	assert.equal(resolveInside("/a/b", "/etc/passwd"), null);
});
