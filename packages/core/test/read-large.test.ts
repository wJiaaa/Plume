/**
 * `read` on a file too big to load whole.
 *
 * Above `STREAM_ABOVE_BYTES` the file is streamed rather than `readFile`-d and split, and the answer
 * has to be the one the small path would give: the same lines, the same line count in the footer,
 * the same `offset` to continue from. The equivalence is checked against `split` directly, across
 * the stream's chunk boundaries, and then end to end through the tool.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LINE_KEEP_BYTES, readLineWindow, STREAM_ABOVE_BYTES } from "../src/tools/large-text.ts";
import { readTool } from "../src/tools/read.ts";
import { decodeText } from "../src/tools/text-layout.ts";
import type { ToolContext } from "../src/types.ts";

async function scratch(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-read-large-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** What the small path makes of the same text. */
function splitLines(text: string): string[] {
	const lines = decodeText(text).text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

const ctx = (cwd: string): ToolContext => ({ cwd, sessionId: "s", state: new Map() });
const textOf = (res: Awaited<ReturnType<typeof readTool.execute>>) => res.content.map((part) => ("text" in part ? part.text : "")).join("");

test("the streamed window is the window split would give", async (t) => {
	const dir = await scratch(t);
	const cases: Record<string, string> = {
		trailing: "a\nb\nc\n",
		bare: "a\nb\nc",
		empty: "",
		newline: "\n",
		blank: "a\n\n\nb\n",
		crlf: "one\r\ntwo\r\nthree\r\n",
		bom: "\uFEFFfirst\nsecond\n",
		unicode: "日本語\n😀 emoji\n",
	};
	for (const [name, text] of Object.entries(cases)) {
		const file = join(dir, `${name}.txt`);
		await writeFile(file, text);
		const expected = splitLines(text);
		const got = await readLineWindow(file, 1, 2000, 0, Number.MAX_SAFE_INTEGER);
		assert.equal(got.totalLines, expected.length, `${name}: line count`);
		assert.deepEqual(got.lines, expected, `${name}: lines`);
	}
});

test("lines that straddle the stream's chunks come out whole", async (t) => {
	const dir = await scratch(t);
	// About 3 MB of lines whose lengths do not divide the 1 MB chunk, multi-byte characters included.
	const text = Array.from({ length: 30_000 }, (_, i) => `${i}:${"é".repeat(i % 97)}${"x".repeat(i % 13)}`).join("\n");
	const file = join(dir, "straddle.txt");
	await writeFile(file, text);
	const expected = splitLines(text);
	for (const offset of [1, 5_000, 11_111, 29_990]) {
		const got = await readLineWindow(file, offset, 50, 0, Number.MAX_SAFE_INTEGER);
		assert.equal(got.totalLines, expected.length);
		assert.deepEqual(got.lines, expected.slice(offset - 1, offset - 1 + 50), `offset ${offset}`);
	}
});

test("a file past the streaming threshold reads like any other, without being loaded whole", async (t) => {
	const dir = await scratch(t);
	const file = join(dir, "big.log");
	const count = 120_000;
	await writeFile(file, Array.from({ length: count }, (_, i) => `entry ${i + 1} ${"z".repeat(70)}`).join("\n") + "\n");

	const bare = await readTool.execute({ path: file }, ctx(dir));
	const shown = Number(new RegExp(`showing lines 1-(\\d+) of ${count} \\(output capped`).exec(textOf(bare))?.[1]);
	assert.ok(shown > 100 && shown < 2000, `a bare read is cut by the output budget and says where to continue: ${shown}`);
	assert.match(textOf(bare), new RegExp(`offset=${shown + 1}`));

	const deep = await readTool.execute({ path: file, offset: 100_000, limit: 3 }, ctx(dir));
	const deepText = textOf(deep);
	assert.match(deepText, /100000→entry 100000 z+\n100001→entry 100001 z+\n100002→entry 100002 z+/);
	assert.match(deepText, new RegExp(`showing lines 100000-100002 of ${count};`));
	assert.deepEqual((deep.details as { totalLines: number }).totalLines, count);

	const past = await readTool.execute({ path: file, offset: count + 1 }, ctx(dir));
	assert.equal(past.isError, true);
	assert.match(textOf(past), new RegExp(`past the end of the file \\(${count} lines\\)`));
	assert.ok(STREAM_ABOVE_BYTES < 120_000 * 80, "the fixture is large enough to take the streaming path");
});

test("a huge binary is still refused, and a line too long to keep says so", async (t) => {
	const dir = await scratch(t);
	const binary = join(dir, "blob.bin");
	await writeFile(binary, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.alloc(STREAM_ABOVE_BYTES + 1, 65)]));
	const refused = await readTool.execute({ path: binary }, ctx(dir));
	assert.equal(refused.isError, true);
	assert.match(textOf(refused), /looks like a binary file/);

	// One line of the whole file: the minified-bundle shape.
	const minified = join(dir, "bundle.min.js");
	await writeFile(minified, `${"q".repeat(5000)}NEEDLE${"w".repeat(STREAM_ABOVE_BYTES)}`);
	const head = textOf(await readTool.execute({ path: minified }, ctx(dir)));
	assert.match(head, /line 1 is longer than 1 MB; only the first 1 MB can be read/);
	const further = textOf(await readTool.execute({ path: minified, char_offset: 5001 }, ctx(dir)));
	assert.match(further, /1→… \[5000 characters omitted\] NEEDLE/, "char_offset still reaches into the kept part of the line");
	assert.ok(LINE_KEEP_BYTES < STREAM_ABOVE_BYTES);
});
