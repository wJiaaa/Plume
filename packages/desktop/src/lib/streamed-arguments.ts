/**
 * 一次还在写的调用，参数写到哪儿了。
 *
 * 写着的时候 `arguments` 还是空的，只有 `argumentsText` 在长（见各家 provider）。而转录只在形状变了时
 * 重画那一行，不是每来一段参数都重画，所以从行上拿到的 `block` 停在它刚出现的那一刻——要看此刻写到
 * 哪儿，得从消息里直接读。
 */

import type { Message } from "@plume/core";

/**
 * 这次调用此刻的参数原文。只看最后几条：还在写的调用就在还在写的那条回复里。传给
 * `useScoped…` 的选择器用，选出的是字符串，只有它变了才重画。
 */
export function argumentsSoFar(messages: Message[], id: string): string | null {
	for (let at = messages.length - 1; at >= Math.max(0, messages.length - 4); at--) {
		const message = messages[at]!;
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall" && block.id === id) return block.argumentsText ?? null;
	}
	return null;
}

/** 前面不是 `\` 的 `"key"` 只可能是键：字符串里的引号都转义过。 */
function valueStart(raw: string, key: string): number {
	const match = new RegExp(`(?<!\\\\)"${key}"\\s*:\\s*"`).exec(raw);
	return match ? match.index + match[0].length : -1;
}

/** 已经写完的一个字符串值；还没写完的不算。路径一类不含转义的短值用它。 */
export function streamedString(raw: string, key: string): string | undefined {
	const start = valueStart(raw, key);
	if (start < 0) return undefined;
	const end = raw.indexOf('"', start);
	const value = end < 0 ? "" : raw.slice(start, end);
	return end < 0 || value.includes("\\") ? undefined : value;
}

/**
 * `key` 那个字符串值写完了几行：数转义过的换行，不整段解析——一个文件上万行，每来一段参数都要过一遍。
 * 还没写到这个键时是 `undefined`。
 */
export function streamedLines(raw: string, key: string): number | undefined {
	const start = valueStart(raw, key);
	if (start < 0) return undefined;
	let lines = 0;
	for (let at = start; at < raw.length; at++) {
		const char = raw[at];
		if (char === '"') break;
		if (char !== "\\") continue;
		// 一个转义占两个字符：`\\n` 是反斜杠加字母 n，不是换行。
		if (raw[at + 1] === "n") lines++;
		at++;
	}
	return lines;
}
