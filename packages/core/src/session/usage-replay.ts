/**
 * 用量页「Token 构成」「耗时构成」的原料：按顺序回放会话记录，合成按天、按模型的行。
 *
 * 为什么是回放而不是 SQL 聚合：Token 构成要回答「每次请求送进去的东西里，系统提示词、工具定义、
 * 工具结果各占多少」，这取决于发请求那一刻上下文里有哪些消息、当时的提示词长什么样——只有按顺序
 * 走一遍才知道。耗时和工具调用顺便在同一遍里数，免得把记录正文解析两次。
 *
 * 状态（`UsageReplayState`）可以存下来，下次从游标接着回放，见 desktop 的 `usage-activity.ts`。
 *
 * 构成里只有比例是估的：每次请求的输入按「它带了哪些内容」估出各部分的比例，再把那次回复 usage
 * 里实际计费的输入（含缓存读写）按比例分下去；输出按思考和正文分。所以各部分加起来就是账单上的数。
 */

import { FRESH_RESULT_MAX_CHARS } from "../agent/prune.ts";
import type { PromptSource } from "../prompt/context.ts";
import type { AssistantMessage, Message } from "../types.ts";
import type { SessionRecord } from "./types.ts";
import { INPUT_PARTS, OUTPUT_PARTS, type InputPart, type OutputPart } from "./usage-parts.ts";


/** 一个会话、一天、一个模型做的事。时长都是累计的：并行的工具和子智能体各算各的。 */
export interface UsageReplayRow extends Record<InputPart | OutputPart, number> {
	/** `YYYY-MM-DD`, local. */
	day: string;
	session: string;
	provider: string;
	model: string;
	/** 人发的消息，口径同 `SessionMeta.turns`。 */
	turns: number;
	replies: number;
	/** 带着 `durationMs` 的回复数，以及它们从发请求到写完的总毫秒。 */
	timedReplies: number;
	modelMs: number;
	/** 其中从第一个 token 到写完的那段；`modelMs` 减去它就是等首字的时间。 */
	streamMs: number;
	/** 生成那段里花在思考块上的，每条回复不超过它自己的 `streamMs`。 */
	thinkingMs: number;
	tools: number;
	toolErrors: number;
	toolMs: number;
}

export const REPLAY_NUMBERS = ["turns", "replies", "timedReplies", "modelMs", "streamMs", "thinkingMs", "tools", "toolErrors", "toolMs", ...INPUT_PARTS, ...OUTPUT_PARTS] as const;

/** 一条请求序列（主对话，或一个子智能体）回放到哪里了。 */
interface StreamState {
	provider: string | null;
	model: string | null;
	/** 还没碰到回复、不知道该记在哪个模型上的轮次，按天。 */
	pendingTurns: Record<string, number>;
	/** 当前提示词各部分的估计 token：系统提示词三类和工具定义。 */
	prompt: Record<"system" | "instructions" | "skills" | "toolDefs", number>;
	/** 序列里每条消息的 seq 与各类估计 token 的前缀和，取最后 N 条的合计是 O(1)。 */
	seqs: number[];
	prefix: Record<"user" | "injected" | "assistant" | "toolResults", number[]>;
	/** 最近一次请求带了几条消息；回复到了才结算，结算完清掉。 */
	pending: number | null;
}

export interface UsageReplayState {
	streams: Record<string, StreamState>;
}

export function newUsageReplayState(): UsageReplayState {
	return { streams: {} };
}

/** 图片按一个固定数算：各家的算法不同，而它在比例里只是一个量级。 */
const IMAGE_TOKENS = 1600;

/** 粗估：ASCII 四个字符一个 token，其余（中文等）一个字符一个。只拿来算比例。 */
function estimateTokens(text: string): number {
	let wide = 0;
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) > 0x7f) wide++;
	return (text.length - wide) / 4 + wide;
}

const INSTRUCTION_SOURCES = new Set<PromptSource>(["userInstructions", "projectInstructions", "userMemory", "projectMemory"]);
const SKILL_SOURCES = new Set<PromptSource>(["skills", "agents", "extension"]);

function promptOf(event: { systemPrompt: string; schemas?: unknown[]; sections?: { source: PromptSource; start: number; end: number }[] }): StreamState["prompt"] {
	const prompt = { system: 0, instructions: 0, skills: 0, toolDefs: event.schemas?.length ? estimateTokens(JSON.stringify(event.schemas)) : 0 };
	if (!event.sections?.length) {
		prompt.system = estimateTokens(event.systemPrompt);
		return prompt;
	}
	let covered = 0;
	for (const section of event.sections) {
		const size = estimateTokens(event.systemPrompt.slice(section.start, section.end));
		covered += section.end - section.start;
		if (INSTRUCTION_SOURCES.has(section.source)) prompt.instructions += size;
		else if (SKILL_SOURCES.has(section.source) || section.source.startsWith("deferred")) prompt.skills += size;
		else prompt.system += size;
	}
	// 段落之间没归到哪一段的文字（分隔、标题）算系统提示词。
	if (covered < event.systemPrompt.length) prompt.system += (event.systemPrompt.length - covered) / 4;
	return prompt;
}

function contentTokens(content: Message["content"] | string, cap = Infinity): number {
	// 旧日志里用户消息的正文可能是一整段字符串。
	if (typeof content === "string") return estimateTokens(content.slice(0, cap));
	let total = 0;
	for (const block of content) {
		if (block.type === "text") total += estimateTokens(block.text.slice(0, cap));
		else if (block.type === "image") total += IMAGE_TOKENS;
	}
	return total;
}

/** 这条消息在之后的请求里占多少、算哪一类。之前的思考块大多不回传给模型，不算。 */
function sizeOf(message: Message): { part: "user" | "injected" | "assistant" | "toolResults"; tokens: number } {
	if (message.role === "user") return { part: message.synthetic ? "injected" : "user", tokens: contentTokens(message.content) };
	if (message.role === "toolResult") return { part: "toolResults", tokens: message.uneventful ? 0 : contentTokens(message.content, FRESH_RESULT_MAX_CHARS) };
	let tokens = 0;
	for (const block of message.content) {
		if (block.type === "text") tokens += estimateTokens(block.text);
		else if (block.type === "toolCall") tokens += estimateTokens(block.name) + estimateTokens(JSON.stringify(block.arguments ?? {}));
	}
	return { part: "assistant", tokens };
}

function streamOf(state: UsageReplayState, id: string): StreamState {
	return (state.streams[id] ??= { provider: null, model: null, pendingTurns: {}, prompt: { system: 0, instructions: 0, skills: 0, toolDefs: 0 }, seqs: [], prefix: { user: [], injected: [], assistant: [], toolResults: [] }, pending: null });
}

function push(stream: StreamState, seq: number, message: Message): void {
	const { part, tokens } = sizeOf(message);
	stream.seqs.push(seq);
	for (const key of Object.keys(stream.prefix) as (keyof StreamState["prefix"])[]) {
		const list = stream.prefix[key];
		list.push((list.at(-1) ?? 0) + (key === part ? tokens : 0));
	}
}

/** 最后 `count` 条消息各类的合计；没有请求记录的旧会话按整条序列算。 */
function tail(stream: StreamState, count: number | null): Record<keyof StreamState["prefix"], number> {
	const length = stream.seqs.length;
	const from = count === null ? 0 : Math.max(0, length - count);
	const sum = (list: number[]) => (list.at(-1) ?? 0) - (from > 0 ? (list[from - 1] ?? 0) : 0);
	return { user: sum(stream.prefix.user), injected: sum(stream.prefix.injected), assistant: sum(stream.prefix.assistant), toolResults: sum(stream.prefix.toolResults) };
}

function dayKey(ms: number): string {
	const date = new Date(ms);
	return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

/** 把回放出来的数加到对应的行上。行在 `rows` 里按 `day/session/provider/model` 找。 */
export type RowSink = (key: { day: string; session: string; provider: string; model: string }) => UsageReplayRow;

export function emptyReplayRow(key: { day: string; session: string; provider: string; model: string }): UsageReplayRow {
	const row = { ...key } as UsageReplayRow;
	for (const field of REPLAY_NUMBERS) row[field] = 0;
	return row;
}

function settleReply(stream: StreamState, message: AssistantMessage, row: UsageReplayRow): void {
	const usage = message.usage;
	const billed = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
	if (billed > 0) {
		const parts = { ...stream.prompt, ...tail(stream, stream.pending) };
		const estimated = INPUT_PARTS.reduce((sum, part) => sum + parts[part], 0);
		if (estimated > 0) for (const part of INPUT_PARTS) row[part] += (parts[part] / estimated) * billed;
		else row.system += billed;
	}
	const output = usage?.output ?? 0;
	if (output > 0) {
		let thinking = usage?.reasoning ?? 0;
		if (!thinking) {
			const thought = message.content.reduce((sum, block) => sum + (block.type === "thinking" ? estimateTokens(block.thinking) : 0), 0);
			const said = sizeOf(message).tokens;
			thinking = thought + said > 0 ? (thought / (thought + said)) * output : 0;
		}
		thinking = Math.min(thinking, output);
		row.outputThinking += thinking;
		row.outputReply += output - thinking;
	}
	stream.pending = null;
}

function foldMessage(state: UsageReplayState, session: string, streamId: string, seq: number, ts: number, message: Message, copy: boolean, rowOf: RowSink): void {
	const stream = streamOf(state, streamId);
	const day = dayKey(ts);
	// 抄来的历史照样进上下文——之后的请求真的带着它——只是不在这里再数一遍。
	if (!copy) {
		if (message.role === "assistant") {
			useModel(stream, session, String(message.provider ?? "unknown"), String(message.model ?? "unknown"), rowOf);
			const row = rowOf({ day, session, provider: String(stream.provider), model: String(stream.model) });
			row.replies += 1;
			const duration = message.durationMs;
			const sse = message.sseDurationMs;
			if (duration !== undefined) {
				row.timedReplies += 1;
				row.modelMs += duration;
				if (sse !== undefined) {
					row.streamMs += Math.min(sse, duration);
					const thought = message.content.reduce((sum, block) => sum + (block.type === "thinking" ? (block.durationMs ?? 0) : 0), 0);
					row.thinkingMs += Math.min(thought, sse, duration);
				}
			}
			settleReply(stream, message, row);
		} else if (message.role === "toolResult") {
			const row = rowOf({ day, session, provider: stream.provider ?? "unknown", model: stream.model ?? "unknown" });
			row.tools += 1;
			if (message.isError) row.toolErrors += 1;
			row.toolMs += message.durationMs ?? 0;
		} else if (streamId === "main" && !message.synthetic) {
			if (stream.model) rowOf({ day, session, provider: stream.provider ?? "unknown", model: stream.model }).turns += 1;
			else stream.pendingTurns[day] = (stream.pendingTurns[day] ?? 0) + 1;
		}
	}
	push(stream, seq, message);
}

/** 这条序列眼下记在哪个模型上；之前没处可记的轮次一并补上，用它们自己那天。 */
function useModel(stream: StreamState, session: string, provider: string, model: string, rowOf: RowSink): void {
	stream.provider = provider;
	stream.model = model;
	for (const [day, turns] of Object.entries(stream.pendingTurns)) rowOf({ day, session, provider, model }).turns += turns;
	stream.pendingTurns = {};
}

function foldEvent(state: UsageReplayState, session: string, streamId: string, event: { type: string } & Record<string, unknown>, rowOf: RowSink): void {
	if (event.type === "request" && typeof event.messageCount === "number") {
		const stream = streamOf(state, streamId);
		stream.pending = event.messageCount;
		// 请求在回复之前就记下了模型：一轮只发出请求、没等到回复，也知道该记在谁头上。
		if (typeof event.provider === "string" && typeof event.model === "string") useModel(stream, session, event.provider, event.model, rowOf);
	} else if (event.type === "context" && typeof event.systemPrompt === "string") streamOf(state, streamId).prompt = promptOf(event as unknown as Parameters<typeof promptOf>[0]);
}

/** 回放一条记录。`record.copy` 是分叉时抄过来的历史，见 `SessionStore.write`。 */
export function foldUsageRecord(state: UsageReplayState, session: string, record: SessionRecord & { copy?: boolean }, rowOf: RowSink): void {
	if (record.type === "message") return foldMessage(state, session, "main", record.seq, record.ts, record.message, record.copy === true, rowOf);
	if (record.type === "truncate") {
		// 倒回去：之后的请求不再带被截掉的那些消息。
		const stream = state.streams.main;
		if (!stream) return;
		const keep = stream.seqs.findIndex((seq) => seq > record.afterSeq);
		if (keep === -1) return;
		stream.seqs.length = keep;
		for (const list of Object.values(stream.prefix)) list.length = keep;
		return;
	}
	if (record.type !== "event") return;
	const event = record.event as { type: string; id?: string; message?: Message; event?: { type: string } & Record<string, unknown> } & Record<string, unknown>;
	if (event.type === "subagent_message" && event.message) return foldMessage(state, session, `sub:${event.id}`, record.seq, record.ts, event.message, record.copy === true, rowOf);
	if (event.type === "subagent_event" && event.event) return foldEvent(state, session, `sub:${event.id}`, event.event, rowOf);
	foldEvent(state, session, "main", event, rowOf);
}

/** 记录里只有这几种和回放有关；存储据此在 SQL 里就把其余的（钩子、工具开始等）筛掉。 */
export const USAGE_RECORD_KINDS = ["message", "subagent_message", "subagent_event", "request", "context", "truncate"] as const;
