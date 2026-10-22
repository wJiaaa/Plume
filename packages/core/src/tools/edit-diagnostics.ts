/**
 * After `edit` or `write`: the errors the language server now reports in that file, appended to the
 * result.
 *
 * Without it a type error just written stays unknown until something runs a check. In the session
 * history `lsp diagnostics` was called 0 times across 417 code edits, and 10 of 29 sessions that
 * edited code ended without running any check after the last edit. Telling the model in the result
 * it is already reading costs nothing when the file is clean — nothing is added — and is how
 * opencode does it.
 *
 * Errors only, this file only. Warnings mid-refactor are noise to chase, and other files broken by a
 * changed signature need a whole-program check, which is `lsp references`' job. The wording reports
 * rather than asks for a fix: the first of three planned edits often leaves an error the third
 * removes, and "please fix" pulls the model into fixing it early.
 */

import { codeIntelFor } from "../lsp/manager.ts";
import type { Diagnostic } from "../lsp/types.ts";
import type { ToolContext, ToolResult } from "../types.ts";

/**
 * How long a successful edit may wait for diagnostics before it returns without them.
 *
 * Measured on this repository with tsserver: 13–46ms p50–p95 once warm, about 1s for the first
 * question while it loads the project. Past this the edit returns as it would have.
 */
const WAIT_MS = 2000;
const MAX_SHOWN = 10;

export async function withDiagnostics(ctx: ToolContext, file: string, result: ToolResult): Promise<ToolResult> {
	const manager = codeIntelFor(ctx.state);
	const backend = manager.backendFor(file);
	if (!backend || !(await backend.available().catch(() => false))) return result;
	if (!backend.ready()) {
		// A server that needs a handshake is not waited for: it starts now, and the next edit has it.
		void manager.acquire(file, ctx.cwd).catch(() => {});
		return result;
	}

	const started = Date.now();
	// Caught on the request itself: after a timeout it still settles, and a rejection then would be unhandled.
	const request = manager
		.acquire(file, ctx.cwd)
		.then((ready) => (ready ? ready.diagnostics(file) : null))
		.catch(() => null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), WAIT_MS);
	});
	const found = await Promise.race([request, timeout]);
	clearTimeout(timer);
	const ms = Date.now() - started;
	// Recorded with the result, so the session audit can see how long this costs and how often it times out.
	const base = result.details as Record<string, unknown> | undefined;

	if (found === "timeout") return { ...result, details: { ...base, diagnostics: { timedOut: true, ms } } };
	if (found === null) return result;
	const errors = found.filter((d) => d.severity === "error");
	const details = { ...base, diagnostics: { errors: errors.length, ms } };
	if (errors.length === 0) return { ...result, details };

	const [first, ...rest] = result.content;
	const note = render(errors);
	const content = first?.type === "text" ? [{ ...first, text: `${first.text}${note}` }, ...rest] : [...result.content, { type: "text" as const, text: note.trimStart() }];
	return { ...result, content, details };
}

function render(errors: Diagnostic[]): string {
	const lines = errors
		.slice(0, MAX_SHOWN)
		// tsserver chains a message over several lines; one line each keeps the list readable.
		.map((d) => `${d.line}:${d.column} ${d.message.replace(/\s*\n\s*/g, " ")}${d.code === undefined ? "" : ` (${d.code})`}`);
	const more = errors.length > MAX_SHOWN ? `\n… ${errors.length - MAX_SHOWN} more` : "";
	return `\n\nThe language server now reports ${errors.length} error${errors.length === 1 ? "" : "s"} in this file:\n${lines.join("\n")}${more}`;
}
