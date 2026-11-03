import { textResult } from "../../agent/tool-run.ts";
import type { Message, ModelConfig, Tool, ToolResult } from "../../types.ts";
import type { MainSession } from "./side-main.ts";

/** Lossless readable content, excluding opaque provider reasoning handles. */
export function mainMessageText(message: Message): string {
	const who = message.role === "toolResult" ? `tool result ${message.toolName}` : message.role === "assistant" ? "assistant" : message.synthetic ? "system note" : "user";
	return `[${who}]\n` + message.content.map((block, index) => {
		switch (block.type) {
			case "text": return block.text;
			case "image": return `[image content[${index}], readable with imageBlock]`;
			case "thinking": return block.thinking ? `[thinking]\n${block.thinking}` : "[no visible thinking]";
			case "toolCall": return `[tool call ${block.name}]\n${JSON.stringify(block.arguments)}`;
		}
	}).join("\n");
}

/** How much of the main chat rides along with one question; the tool below reaches the rest. */
function mainChatBudget(model: ModelConfig): number {
	return Math.max(256, Math.min(12000, Math.floor(model.contextWindow * 0.08)));
}

/**
 * The main chat from message `from` on, newest kept when it does not fit.
 *
 * Indexes are the main chat's own, so a later `read_main_chat` call can start from what this left out.
 */
export function mainChatExcerpt(messages: Message[], from: number, model: ModelConfig): string {
	const parts: string[] = [];
	let remaining = mainChatBudget(model);
	let start = messages.length;
	let clipped = false;
	while (start > from && remaining > 0) {
		start--;
		const text = `message ${start}\n${mainMessageText(messages[start])}`;
		parts.unshift(text.slice(-remaining));
		clipped ||= text.length > remaining;
		remaining -= text.length;
	}
	const partial = start > from || clipped;
	return (partial ? `Only the most recent part is shown (from around message ${start}); use read_main_chat for messages ${from}–${start} and anything cut off.\n\n` : "") + parts.join("\n\n");
}

/** Paging and search over one conversation's record, shared by `read_main_chat` and the desktop's `read_session`. */
export interface HistoryArgs {
	start?: number;
	offset?: number;
	limit?: number;
	maxChars?: number;
	query?: string;
}
interface ReadMainArgs extends HistoryArgs {
	imageBlock?: number;
}
interface Cursor { start: number; offset?: number; query?: string }

/** The JSON schema properties for `HistoryArgs`; a tool adds what only it offers. */
export const HISTORY_PROPERTIES = {
	start: { type: "integer", minimum: 0 }, offset: { type: "integer", minimum: 0 },
	limit: { type: "integer", minimum: 1, maximum: 30 }, maxChars: { type: "integer", minimum: 1, maximum: 12000 },
	query: { type: "string" },
} as const;

/**
 * One page of a conversation's record as it is when the call runs: from message `start`, or the
 * messages matching `query`, at most `charLimit` characters; `next` says where to go on.
 */
export function readHistory(source: { id: string; messages: Message[] }, args: HistoryArgs, charLimit: number): ToolResult {
	const { messages } = source;
	const invalid = invalidArgs(args);
	if (invalid) return invalid;
	const start = args.start ?? 0;
	const query = args.query?.trim().toLowerCase();
	const entries: { index: number; role: Message["role"]; offset: number; totalChars: number; text: string }[] = [];
	let remaining = Math.min(args.maxChars ?? charLimit, charLimit);
	let next: Cursor | null = null;
	for (let index = start; index < messages.length; index++) {
		const text = mainMessageText(messages[index]);
		const match = query ? text.toLowerCase().indexOf(query) : 0;
		if (match < 0) continue;
		const offset = index === start && args.offset !== undefined ? args.offset : Math.max(0, match - 160);
		const excerpt = text.slice(offset, offset + remaining);
		entries.push({ index, role: messages[index].role, offset, totalChars: text.length, text: excerpt });
		remaining -= excerpt.length;
		if (offset + excerpt.length < text.length) {
			next = { start: index, offset: offset + excerpt.length, ...(query ? { query } : {}) };
			break;
		}
		if (remaining === 0 || entries.length >= Math.min(args.limit ?? 10, 30)) {
			if (index + 1 < messages.length) next = { start: index + 1, ...(query ? { query } : {}) };
			break;
		}
	}
	return textResult(JSON.stringify({ sessionId: source.id, totalMessages: messages.length, messages: entries, next }));
}

function invalidArgs(args: ReadMainArgs): ToolResult | undefined {
	for (const key of ["start", "offset", "limit", "maxChars", "imageBlock"] as const) {
		const value = args[key];
		if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === "limit" || key === "maxChars" ? 1 : 0))) {
			return { ...textResult(`${key} 必须是有效的非负整数（limit / maxChars 至少为 1）。`), isError: true };
		}
	}
	if (args.query !== undefined && typeof args.query !== "string") return { ...textResult("query 必须是文字。"), isError: true };
	return undefined;
}

/**
 * Bound to the main chat, never to a caller-supplied session id or filesystem path.
 *
 * Reads it as it is when the call runs: the main session keeps working while this one is asked about
 * it, and "what is it doing now" is the question most often put to a side chat.
 */
export function readMainChatTool(main: MainSession, model: () => ModelConfig): Tool<ReadMainArgs> {
	return {
		name: "read_main_chat",
		description: "只读查询主会话此刻的完整原始历史，包括压缩前内容、工具调用和工具结果。start 为消息索引，offset 为该消息文字偏移；next 非空则按其参数继续。query 为不区分大小写的字面关键词；搜索命中会给出附近文字。读取图片时指定 start 和 imageBlock（content 中的索引）。不会读取其他会话或工作区文件。",
		parameters: { type: "object", properties: { ...HISTORY_PROPERTIES, imageBlock: { type: "integer", minimum: 0 } }, additionalProperties: false },
		summarize: (args) => args.query ? `查主会话：${args.query}` : `读取主会话消息 ${args.start ?? 0}`,
		async execute(args) {
			const messages = main.messages;
			if (args.imageBlock !== undefined) {
				const invalid = invalidArgs(args);
				if (invalid) return invalid;
				const start = args.start ?? 0;
				const block = messages[start]?.content[args.imageBlock];
				if (!block || block.type !== "image") return { ...textResult("指定位置没有图片。"), isError: true };
				if (!model().supportsImages) return { ...textResult("当前主会话模型不支持图片，请切换到支持图片的模型后再提问。"), isError: true };
				return { content: [{ type: "text", text: `主会话消息 ${start} 的图片 ${args.imageBlock}` }, block] };
			}
			return readHistory({ id: main.meta.id, messages }, args, mainChatBudget(model()));
		},
	};
}
