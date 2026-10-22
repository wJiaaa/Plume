import type { Tool } from "../types.ts";
import { builtinToolGroups } from "./groups.ts";

/**
 * Where the built-in tool list comes from.
 *
 * Unbound — which is both hosts — it is the groups in `groups.ts`. Binding a registry replaces the
 * whole list: `test/market-verify-probe.ts` narrows it to the read-only tools this way. A host's own
 * tools do not come through here; they arrive per session as `AgentSessionOptions.extraTools`
 * (ADR-0054).
 */
export interface ToolRegistry {
	all(): Tool[];
}

let registry: ToolRegistry | null = null;

export function useToolRegistry(next: ToolRegistry | null): void {
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
