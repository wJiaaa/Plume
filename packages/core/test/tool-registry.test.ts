/**
 * That every tool written is a tool the model is told about.
 *
 * The defect this exists for: the kernel's tools plugin registered four groups, `tools/index.ts`
 * kept a flat list beside them, and `rule`, `recall`, `learn`, `lsp` and `web_search` were only in
 * the flat one. The desktop bound the kernel registry, so on the desktop those five did not exist.
 * They type-checked, they had tests, they were shipped — and 23,000 tool calls of real session logs
 * contain not one of them. Nothing compared the two lists.
 *
 * So the assertion is not "the two lists agree" (there is only one list now — the kernel registry is
 * gone, ADR-0054). It is against the source tree: every `*Tool`
 * exported under `src/tools/` has to reach the registry. Forgetting to register the next one fails
 * here rather than in a year of nobody noticing.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { builtinTools, staticTools, useToolRegistry } from "../src/tools/index.ts";

const srcDir = join(fileURLToPath(new URL("../src", import.meta.url)));

/**
 * The tool names declared in the source, found by reading it rather than by importing it.
 *
 * Reading keeps the check honest: an import list is the very thing that went stale, so a test that
 * imports what it checks would have passed throughout. Files are walked with `node:fs` rather than
 * a shell so this behaves the same on Windows.
 */
function declaredToolNames(): Map<string, string> {
	const found = new Map<string, string>();
	// `skills/tool.ts` is a tool that happens not to live in `tools/`; it is in the registry too.
	const files = [
		...readdirSync(join(srcDir, "tools"))
			.filter((name) => name.endsWith(".ts"))
			.map((name) => join(srcDir, "tools", name)),
		join(srcDir, "skills", "tool.ts"),
	];
	for (const path of files) {
		const text = readFileSync(path, "utf8");
		for (const match of text.matchAll(/export const (\w+Tool)\s*:\s*Tool</g)) {
			const declaration = text.slice(match.index);
			const name = /\bname:\s*"([^"]+)"/.exec(declaration);
			assert.ok(name, `${match[1]} in ${path} has no name literal`);
			found.set(name[1], match[1]);
		}
	}
	return found;
}

test("every tool in the source reaches the static list", () => {
	const declared = declaredToolNames();
	// A guard on the guard: if the scan stops finding tools, it must fail rather than pass empty.
	assert.ok(declared.size >= 19, `expected at least 19 declared tools, found ${declared.size}`);

	const listed = new Set(staticTools().map((tool) => tool.name));
	const missing = [...declared.keys()].filter((name) => !listed.has(name));
	assert.deepEqual(missing, [], `written but never advertised: ${missing.map((n) => declared.get(n)).join(", ")}`);
});

test("unbound, the session's tool list is the static list", () => {
	assert.deepEqual(builtinTools().map((tool) => tool.name), staticTools().map((tool) => tool.name));
});

test("the tools the desktop used to be missing are in the list", () => {
	/*
	 * Named individually on purpose. A set comparison passes the moment both sides are wrong the
	 * same way, and these are the ones that were actually lost — `recall` is how compacted
	 * history is retrieved, `learn` is where project memory comes from, and the settings pages for
	 * both were drawn and reachable the whole time.
	 */
	const names = new Set(builtinTools().map((tool) => tool.name));
	for (const name of ["recall", "learn", "lsp", "web_search"]) {
		assert.ok(names.has(name), `${name} is not in the list`);
	}
});

test("a bound registry is what builtinTools reads, and unbinding restores the static list", () => {
	const replacement = { name: "bash", description: "not the real one", parameters: {}, execute: async () => ({ content: [] }) };
	useToolRegistry({ all: () => [replacement as never] });
	try {
		assert.deepEqual(builtinTools().map((tool) => tool.description), ["not the real one"]);
	} finally {
		useToolRegistry(null);
	}
	assert.equal(builtinTools().length, staticTools().length);
});
