import test from "node:test";
import assert from "node:assert/strict";
import { resolveSaveDirectory } from "../electron/screenshot/screenshot-path.ts";
import { homedir } from "node:os";
import { join } from "node:path";

test("resolveSaveDirectory expands home dir when ~ prefix is used", () => {
	const res = resolveSaveDirectory("~/Pictures/Screenshots");
	assert.equal(res, join(homedir(), "Pictures/Screenshots"));
});

test("resolveSaveDirectory keeps absolute paths", () => {
	const res = resolveSaveDirectory("/tmp/screenshots");
	assert.equal(res, "/tmp/screenshots");
});
