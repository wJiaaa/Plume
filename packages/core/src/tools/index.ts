import type { Tool } from "../types.ts";
import { builtinToolGroups } from "./groups.ts";

/**
 * Where the built-in tool list comes from.
 *
 * `ctx.tools` is the real registry — it is what lets a plugin add a tool, or displace one with
 * its own implementation. This binding is how the session reaches it without every caller having
 * to be handed a context; unbound, the groups in `groups.ts` are used, which is what tests and
 * small tools see.
 *
 * Both paths read the same groups. They did not always: this function kept a flat list of its own
 * and the kernel plugin registered another, and five tools existed in only one of them. See
 * `groups.ts`.
 */
let registry: { all(): Tool[] } | null = null;

export function useToolRegistry(next: { all(): Tool[] } | null): void {
	registry = next;
}

export function builtinTools(): Tool[] {
	if (registry) return registry.all();
	return staticTools();
}

export function staticTools(): Tool[] {
	return builtinToolGroups().flat();
}

export { formatDiff, type DiffHunk } from "./diff.ts";
export { globTool } from "./glob.ts";
export { grepTool } from "./grep.ts";
export { invalidateIndex } from "./symbol.ts";
export { lsTool } from "./ls.ts";
export { readTool } from "./read.ts";
export { BUILTIN_AGENTS } from "./task.ts";
export { readLocalPage, readLocalPageFor, usePreviewInspector, type PreviewInspection } from "./preview.ts";
