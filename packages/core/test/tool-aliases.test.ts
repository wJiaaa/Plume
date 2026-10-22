import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { grepTool } from "../src/tools/grep.ts";
import { globTool } from "../src/tools/glob.ts";
import { readTool } from "../src/tools/read.ts";
import { symbolTool } from "../src/tools/symbol.ts";

const currentFile = fileURLToPath(import.meta.url);
const testDir = dirname(currentFile);

test("grepTool accepts alias parameters such as query and search", async () => {
	const res = await grepTool.execute({ query: "grepTool", path: testDir } as any, { cwd: testDir, sessionId: "s", state: new Map() });
	assert.equal(res.isError, undefined);
	assert.match(res.content[0].text, /grepTool/);
});

test("globTool accepts query and search aliases", async () => {
	const res = await globTool.execute({ query: "*.ts", path: testDir } as any, { cwd: testDir, sessionId: "s", state: new Map() });
	assert.equal(res.isError, undefined);
	assert.match(res.content[0].text, /tool-aliases\.test\.ts/);
});

test("readTool accepts file and filePath aliases", async () => {
	const res = await readTool.execute({ file: currentFile, limit: 5 } as any, { cwd: testDir, sessionId: "s", state: new Map() });
	assert.equal(res.isError, undefined);
	assert.match(res.content[0].text, /1→import/);
});

test("symbolTool accepts query and symbol aliases", async (t) => {
	// The index it builds is saved under the app's home; without this every test run left one in the real one.
	const home = await mkdtemp(join(tmpdir(), "ly-symbol-"));
	const previous = process.env.PLUME_HOME;
	process.env.PLUME_HOME = home;
	t.after(async () => {
		if (previous === undefined) delete process.env.PLUME_HOME;
		else process.env.PLUME_HOME = previous;
		await rm(home, { recursive: true, force: true });
	});
	const res = await symbolTool.execute({ query: "grepTool", path: testDir } as any, { cwd: testDir, sessionId: "s", state: new Map() });
	assert.equal(res.isError, undefined);
});

test("globTool and grepTool never search their description: a missing pattern is an error the model can act on", async () => {
	// The description is the plain-words line shown to the user. Searching it found nothing and said so silently.
	const glob = await globTool.execute({ description: "Find all *.ts files in directory", path: testDir } as any, { cwd: testDir, sessionId: "s", state: new Map() });
	assert.equal(glob.isError, true);
	assert.match(glob.content[0].text, /`pattern` is required/);
	const grep = await grepTool.execute({ description: "grepTool|globTool|readTool", path: testDir } as any, { cwd: testDir, sessionId: "s", state: new Map() });
	assert.equal(grep.isError, true);
	assert.match(grep.content[0].text, /`pattern` is required/);
	assert.equal(grepTool.summarize?.({ description: "find the config" } as any), "Search");
});

test("summarize and execute read the same alias: an empty pattern falls through to query", async () => {
	assert.equal(grepTool.summarize?.({ pattern: "", query: "grepTool" } as any), 'Search "grepTool"');
	const res = await grepTool.execute({ pattern: "", query: "grepTool", path: testDir } as any, { cwd: testDir, sessionId: "s", state: new Map() });
	assert.equal(res.isError, undefined);
	assert.match(res.content[0].text, /grepTool/);
});

test("grep schema does not require pattern so query-only calls are not rejected upstream", () => {
	const required = (grepTool.parameters as { required?: string[] }).required ?? [];
	assert.equal(required.includes("pattern"), false);
	const globRequired = (globTool.parameters as { required?: string[] }).required ?? [];
	assert.equal(globRequired.includes("pattern"), false);
});

test("grepTool provides self-healing error message when pattern and description are missing", async () => {
	const res = await grepTool.execute({ path: testDir } as any, { cwd: testDir, sessionId: "s", state: new Map() });
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /`pattern` is required/);
	assert.match(res.content[0].text, /e\.g\. \{"pattern": "your_regex"\}/);
});
