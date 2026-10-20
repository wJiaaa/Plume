import type { ToolResult } from "../types.ts";

/**
 * Lives beside the tools, not in `agent/tool-run.ts`: the tools sit below the loop, and importing
 * this from the executor closed a cycle through `skills/tool.ts`.
 */
export function errorResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

export const DECLINED = "Do not retry it unchanged or get the same effect another way — another tool, a shell command, a script. Change your approach; if the task cannot go on without it, say so.";

export function declinedResult(text: string): ToolResult {
	return errorResult(`${text} ${DECLINED}`);
}
