import { INLINE_IMAGE_CHARS, persistSessionImage, type AgentEvent, type AssistantContent, type ImageContent, type Message, type UserContent } from "@plume/core";
import { noteTranscriptFiles } from "../files/index.ts";

/**
 * How much of one block the window is allowed to hold.
 *
 * The session log keeps the original. This is only the copy that crosses IPC and
 * becomes React props. A 25 MB grep dump or a 12 MB text block freezes the renderer
 * during structured clone and first layout; 24k characters is enough to read and
 * to know the rest is in the log.
 */
export const DISPLAY_TEXT_CHARS = 24_000;
/** Inline icons stay. Anything bigger becomes a file pointer before it crosses IPC. */
const DISPLAY_IMAGE_CHARS = INLINE_IMAGE_CHARS;

const parked = new WeakMap<ImageContent, string>();

export function slimSnapshot<T extends { messages: Message[] }>(snapshot: T): T {
	/*
	 * 窗口看得见的附件和回复里的文件链接，它的文件面板也打得开——见 `attachment-reads.ts`。
	 *
	 * 挂在这里，因为这是转录交给窗口的共同出口：冷读和活会话的快照都经过它。挂在任何一个调用方里，
	 * 另一条路上的附件点「预览」就只剩一句「无法读取」。
	 */
	noteTranscriptFiles(snapshot.messages);
	const messages = slimMessagesForDisplay(snapshot.messages);
	return messages === snapshot.messages ? snapshot : { ...snapshot, messages };
}

export function slimMessagesForDisplay(messages: Message[]): Message[] {
	let changed = false;
	const next = messages.map((message) => {
		const slimmed = slimMessage(message);
		if (slimmed !== message) changed = true;
		return slimmed;
	});
	return changed ? next : messages;
}

function slimMessage(message: Message): Message {
	if (message.role === "toolResult") {
		const content = slimUserContent(message.content);
		const details = slimDetails(message.details);
		if (content === message.content && details === message.details) return message;
		return { ...message, content, ...(details === message.details ? {} : { details }) };
	}
	if (message.role === "assistant") {
		const content = slimAssistantContent(message.content);
		return content === message.content ? message : { ...message, content };
	}
	if (message.role === "user") {
		const content = slimUserContent(message.content);
		if (content === message.content) return message;
		return { ...message, content };
	}
	return message;
}

function slimUserContent(content: UserContent[]): UserContent[] {
	let changed = false;
	const next = content.map((part) => {
		if (part.type === "image") {
			const next = parkImage(part);
			if (next !== part) changed = true;
			return next;
		}
		if (part.type !== "text") return part;
		const text = slimText(part.text);
		if (text === null) return part;
		changed = true;
		return { ...part, text };
	});
	return changed ? next : content;
}

/** 按内容起名（`persistSessionImage`），同一张图不论走冷读、实时事件还是落盘，都指着同一个文件。 */
function parkImage(part: ImageContent): ImageContent {
	if (part.data.length <= DISPLAY_IMAGE_CHARS) return part;
	const media = part.media ?? parked.get(part) ?? persistSessionImage(part.data, part.mimeType);
	parked.set(part, media);
	return { ...part, data: "", media };
}

function parkContent(content: UserContent[]): UserContent[] {
	let changed = false;
	const next = content.map((part) => {
		if (part.type !== "image") return part;
		const parkedPart = parkImage(part);
		if (parkedPart !== part) changed = true;
		return parkedPart;
	});
	return changed ? next : content;
}

function parkMessage(message: Message): Message {
	if (message.role === "assistant") return message;
	const content = parkContent(message.content);
	return content === message.content ? message : { ...message, content };
}

type ToolEnd = Extract<AgentEvent, { type: "tool_end" }>;

function parkToolEnd(event: ToolEnd): ToolEnd {
	const content = parkContent(event.result.content);
	return content === event.result.content ? event : { ...event, result: { ...event.result, content } };
}

/**
 * 实时事件过 IPC 之前的那一份：大图换成文件引用。
 *
 * 浏览器截图、读进来的图片，从前只在落盘和冷读时停放成文件，实时事件里整张 base64 跟着 `tool_end`、
 * 跟着那条工具结果的 `message_end` 各过一遍 IPC，进了 store 又一直挂在内存里。停放和冷读同一套，
 * 窗口两条路拿到的是同一种形状。
 *
 * 只换图，不截正文：截正文是冷读给超大转录的保护，实时的这一份照旧给全文，免得一条长回复流完的那一刻
 * 被从中间截掉。
 */
export function parkEventImages(event: AgentEvent): AgentEvent {
	switch (event.type) {
		case "message_start":
		case "message_end":
		case "subagent_message": {
			const message = parkMessage(event.message);
			return message === event.message ? event : ({ ...event, message } as AgentEvent);
		}
		case "tool_end":
			return parkToolEnd(event);
		case "subagent_event": {
			if (event.event.type !== "tool_end") return event;
			const inner = parkToolEnd(event.event);
			return inner === event.event ? event : { ...event, event: inner };
		}
		default:
			return event;
	}
}

function slimAssistantContent(content: AssistantContent[]): AssistantContent[] {
	let changed = false;
	const next = content.map((part) => {
		if (part.type === "text") {
			const text = slimText(part.text);
			if (text === null) return part;
			changed = true;
			return { ...part, text };
		}
		if (part.type === "thinking") {
			const thinking = slimText(part.thinking);
			if (thinking === null) return part;
			changed = true;
			return { ...part, thinking };
		}
		return part;
	});
	return changed ? next : content;
}

function slimDetails(details: unknown): unknown {
	if (typeof details !== "string") return details;
	return slimText(details) ?? details;
}

function slimText(text: string): string | null {
	/*
	 * Length, not `[...text]`. Spreading a 12 MB grep dump allocated one string
	 * per code point on the main process and stalled the IPC that the skeleton
	 * was waiting on. Display truncation can follow UTF-16 units.
	 */
	if (text.length <= DISPLAY_TEXT_CHARS) return null;
	const keep = Math.floor(DISPLAY_TEXT_CHARS / 2);
	const omitted = text.length - keep * 2;
	return (
		`${text.slice(0, keep)}\n\n` +
		`… [${omitted.toLocaleString("en-US")} characters omitted for display; the full result stays in the session log.] …\n\n` +
		text.slice(-keep)
	);
}
