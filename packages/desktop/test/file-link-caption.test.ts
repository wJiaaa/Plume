import assert from "node:assert/strict";
import { test } from "node:test";
import { fileLinkCaption, splitLineSuffix } from "../src/lib/markdown/file-link.ts";

test("path-like labels keep the filename and put the path on the tooltip", () => {
	const long = "docs/issue/2026-09-16-2220-01-tasklist-false-paused-on-unfinished-plan.md";
	assert.deepEqual(fileLinkCaption(long, `/tmp/${long}`), {
		text: "2026-09-16-2220-01-tasklist-false-paused-on-unfinished-plan.md",
		tip: long,
		lines: null,
		line: null,
	});
});

test("a human label stays on the chip", () => {
	assert.deepEqual(fileLinkCaption("实现说明", "/project/docs/result.md"), {
		text: "实现说明",
		tip: "/project/docs/result.md",
		lines: null,
		line: null,
	});
});

test("a bare filename is left alone", () => {
	assert.deepEqual(fileLinkCaption("README.md", "/project/README.md"), {
		text: "README.md",
		tip: "README.md",
		lines: null,
		line: null,
	});
});

test("the line from the link's path is drawn after the filename and kept for opening", () => {
	assert.deepEqual(fileLinkCaption("SopEventHandler.java", "/p/SopEventHandler.java", { from: 88, to: 88 }), {
		text: "SopEventHandler.java",
		tip: "SopEventHandler.java:88",
		lines: { from: 88, to: 88 },
		line: "88",
	});
	// 行内代码 `src/a.ts:3-9`：文字和地址是同一串，行号只画一次。
	assert.deepEqual(fileLinkCaption("src/a.ts:3-9", "/p/src/a.ts", { from: 3, to: 9 }), {
		text: "a.ts",
		tip: "src/a.ts:3-9",
		lines: { from: 3, to: 9 },
		line: "3-9",
	});
});

test("a line written only on the label still counts, but only when the label is a path", () => {
	assert.deepEqual(fileLinkCaption("a.ts:42", "/p/a.ts").lines, { from: 42, to: 42 });
	assert.deepEqual(fileLinkCaption("端口 8080:3000", "/p/a.ts"), { text: "端口 8080", tip: "/p/a.ts", lines: null, line: null });
});

test("a human label keeps its text; the line goes to the tooltip only", () => {
	assert.deepEqual(fileLinkCaption("入口逻辑", "/p/a.ts", { from: 42, to: 42 }), {
		text: "入口逻辑",
		tip: "/p/a.ts:42",
		lines: { from: 42, to: 42 },
		line: null,
	});
});

test("line suffixes split off the path; :0 is no line, a reversed range reads forwards", () => {
	assert.deepEqual(splitLineSuffix("src/a.ts:42"), { path: "src/a.ts", lines: { from: 42, to: 42 } });
	assert.deepEqual(splitLineSuffix("/abs/a.ts:50-42"), { path: "/abs/a.ts", lines: { from: 42, to: 50 } });
	assert.deepEqual(splitLineSuffix("a.ts:0"), { path: "a.ts", lines: null });
	assert.deepEqual(splitLineSuffix("C:\\repo\\a.ts"), { path: "C:\\repo\\a.ts", lines: null });
});

test("inline code that names a file is recognised, with its line suffix kept", async () => {
	const { filePathInCode } = await import("../src/lib/markdown/file-link.ts");
	for (const path of ["src/runBatch.js", "test/runBatch.test.js", "README.md", "packages/core/src/prompt/system.ts:148", "/Users/me/app/index.ts:3-9"]) {
		assert.equal(filePathInCode(path), path);
	}
	for (const code of ["runBatch", "node:test", "npm test", '"type": "module"', "console.log", "process.env", "foo.bar()", "src/", "/Users/me/app/", "origin/main", "feature/v1.2", "https://example.com/a.js"]) {
		assert.equal(filePathInCode(code), null, code);
	}
});
