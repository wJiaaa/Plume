/**
 * The errors appended to `edit` and `write` results, against a fake language server.
 *
 * What must hold: a clean file adds nothing, only errors are shown and only so many, a server that
 * needs a handshake is started but not waited for, and a slow one cannot hold the edit past the limit.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CODE_INTEL_KEY, CodeIntelManager } from "../src/lsp/manager.ts";
import type { CodeIntelBackend, Diagnostic } from "../src/lsp/types.ts";
import { editTool } from "../src/tools/edit.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import type { ToolContext, ToolResult } from "../src/types.ts";

function fakeServer(options: { ready?: boolean; handshake?: boolean; diagnostics?: () => Promise<Diagnostic[]> } = {}) {
	let ready = options.ready ?? true;
	const calls = { start: 0, diagnostics: 0 };
	const backend: CodeIntelBackend = {
		name: "fake",
		extensions: [".ts"],
		available: async () => true,
		start: async () => {
			calls.start++;
			if (options.handshake) await new Promise((resolve) => setTimeout(resolve, 50));
			ready = true;
		},
		ready: () => ready,
		references: async () => [],
		definition: async () => [],
		diagnostics: async () => {
			calls.diagnostics++;
			return (await options.diagnostics?.()) ?? [];
		},
		rename: async () => [],
		dispose: async () => {},
	};
	return { backend, calls };
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, backend: CodeIntelBackend, name = "a.ts") {
	const dir = await mkdtemp(join(tmpdir(), "plume-edit-diag-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, name);
	await writeFile(file, "export const a = 1;\n");
	const ctx = { cwd: dir, sessionId: "t", state: new Map<string, unknown>([[CODE_INTEL_KEY, new CodeIntelManager([backend])]]) } as ToolContext;
	await readTool.execute({ path: file } as never, ctx);
	return { file, ctx };
}

const error = (line: number, message: string): Diagnostic => ({ path: "", line, column: 1, severity: "error", message, code: 2322 });
const textOf = (res: ToolResult) => (res.content[0].type === "text" ? res.content[0].text : "");
const diagnosticsOf = (res: ToolResult) => (res.details as { diagnostics?: Record<string, unknown> }).diagnostics;

test("errors in the edited file are appended, warnings are not", async (t) => {
	const { backend } = fakeServer({
		diagnostics: async () => [error(1, "Type 'string' is not assignable to type 'number'."), { ...error(2, "unused"), severity: "warning" }],
	});
	const { file, ctx } = await fixture(t, backend);
	const res = await editTool.execute({ path: file, old_string: "1", new_string: '"x"' }, ctx);
	const text = textOf(res);
	assert.match(text, /^Edited .*\+1 -1\./, "the edit's own report comes first");
	assert.match(text, /The language server now reports 1 error in this file:\n1:1 Type 'string' is not assignable to type 'number'\. \(2322\)$/);
	assert.doesNotMatch(text, /unused/);
	assert.equal(diagnosticsOf(res)?.errors, 1);
});

test("a clean file adds nothing to the text", async (t) => {
	const { backend, calls } = fakeServer();
	const { file, ctx } = await fixture(t, backend);
	const res = await editTool.execute({ path: file, old_string: "1", new_string: "2" }, ctx);
	assert.equal(calls.diagnostics, 1);
	assert.doesNotMatch(textOf(res), /language server/);
	assert.equal(diagnosticsOf(res)?.errors, 0);
});

test("at most ten errors are listed, with a count of the rest", async (t) => {
	const { backend } = fakeServer({ diagnostics: async () => Array.from({ length: 12 }, (_, i) => error(i + 1, `multi\n  line ${i}`)) });
	const { file, ctx } = await fixture(t, backend);
	const text = textOf(await editTool.execute({ path: file, old_string: "1", new_string: "2" }, ctx));
	assert.match(text, /reports 12 errors/);
	assert.match(text, /10:1 multi line 9 \(2322\)\n… 2 more$/, "a chained message is put on one line");
	assert.doesNotMatch(text, /11:1/);
});

test("a server that answers once spawned is asked on the first edit", async (t) => {
	const { backend, calls } = fakeServer({ ready: false, diagnostics: async () => [error(1, "boom")] });
	const { file, ctx } = await fixture(t, backend);
	const res = await editTool.execute({ path: file, old_string: "1", new_string: "2" }, ctx);
	assert.equal(calls.start, 1);
	assert.equal(diagnosticsOf(res)?.errors, 1);
});

test("a server that needs a handshake is started, not waited for", async (t) => {
	const { backend, calls } = fakeServer({ ready: false, handshake: true });
	const { file, ctx } = await fixture(t, backend);
	const res = await editTool.execute({ path: file, old_string: "1", new_string: "2" }, ctx);
	assert.equal(calls.start, 1);
	assert.equal(calls.diagnostics, 0);
	assert.equal(diagnosticsOf(res), undefined);
});

test("a server that does not answer cannot hold the edit past the limit", async (t) => {
	const { backend } = fakeServer({ diagnostics: () => new Promise(() => {}) });
	const { file, ctx } = await fixture(t, backend);
	const started = Date.now();
	const res = await editTool.execute({ path: file, old_string: "1", new_string: "2" }, ctx);
	assert.ok(Date.now() - started < 3000);
	assert.equal(res.isError, undefined);
	assert.equal(diagnosticsOf(res)?.timedOut, true);
});

test("a file no server handles is not asked about", async (t) => {
	const { backend, calls } = fakeServer();
	const { file, ctx } = await fixture(t, backend, "notes.txt");
	const res = await editTool.execute({ path: file, old_string: "1", new_string: "2" }, ctx);
	assert.equal(calls.diagnostics + calls.start, 0);
	assert.equal(diagnosticsOf(res), undefined);
});

test("write reports errors the same way", async (t) => {
	const { backend } = fakeServer({ diagnostics: async () => [error(1, "'}' expected.")] });
	const { file, ctx } = await fixture(t, backend);
	const res = await writeTool.execute({ path: file, content: "export function f() {\n" }, ctx);
	assert.match(textOf(res), /^Updated .*\n\nThe language server now reports 1 error in this file:\n1:1 '\}' expected\. \(2322\)$/);
});

test("an edit that was refused asks nothing", async (t) => {
	const { backend, calls } = fakeServer();
	const { file, ctx } = await fixture(t, backend);
	const res = await editTool.execute({ path: file, old_string: "missing", new_string: "2" }, ctx);
	assert.equal(res.isError, true);
	assert.equal(calls.diagnostics, 0);
});
