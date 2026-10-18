import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { byDirectory, globTool } from "../src/tools/glob.ts";

test("glob walks the whole tree, so newest-first and the remaining count are real", async (t) => {
	// 以前找到 2000 个就停止遍历：最新的文件在后面的目录里就排不进来，「还有 N 个」也偏小。
	const dir = await mkdtemp(join(tmpdir(), "plume-glob-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const old = new Date("2020-01-01");
	for (const group of ["a", "b"]) {
		await mkdir(join(dir, group));
		for (let i = 0; i < 1500; i++) {
			const file = join(dir, group, `f${i}.ts`);
			await writeFile(file, "");
			await utimes(file, old, old);
		}
	}
	await writeFile(join(dir, "b", "newest.ts"), "");
	const res = await globTool.execute({ pattern: "**/*.ts", limit: 10 }, { cwd: dir, sessionId: "s", state: new Map() });
	const text = res.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	assert.equal(text.split("\n")[0], "b/newest.ts");
	assert.match(text, /\[2991 more matches not shown\]/);
	assert.equal((res.details as { count: number }).count, 3001);
});

test("files sharing a directory are listed under it once, newest-first kept", () => {
	assert.equal(
		byDirectory(["a/x.ts", "b/y.ts", "a/z.ts", "README.md", "c/d/one.ts", "a/w.ts"]),
		["a/", "  x.ts", "  z.ts", "  w.ts", "b/y.ts", "README.md", "c/d/one.ts"].join("\n"),
		"a directory sits where its newest file was; one with a single match keeps the full path",
	);
});

test("every path can be put back together from the grouped listing", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "plume-glob-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const files = ["src/a.ts", "src/b.ts", "src/deep/c.ts", "src/deep/d.ts", "lone/e.ts", "top.ts"];
	for (const [index, file] of files.entries()) {
		await mkdir(join(dir, file, ".."), { recursive: true });
		await writeFile(join(dir, file), "");
		const when = new Date(2020, 0, 1 + index);
		await utimes(join(dir, file), when, when);
	}
	const res = await globTool.execute({ pattern: "**/*.ts" }, { cwd: dir, sessionId: "s", state: new Map() });
	const text = res.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	assert.equal(text, ["top.ts", "lone/e.ts", "src/deep/", "  d.ts", "  c.ts", "src/", "  b.ts", "  a.ts"].join("\n"));
	// Read back the way the tool description tells the model to.
	let header = "";
	const rebuilt = text.split("\n").map((line) => {
		if (line.endsWith("/")) { header = line; return null; }
		return line.startsWith("  ") ? header + line.slice(2) : line;
	}).filter((path) => path !== null);
	assert.deepEqual(rebuilt, (res.details as { files: string[] }).files);
});
