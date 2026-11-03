/**
 * 模型手里的五件工具：看看有谁、读它的记录、问它要答复、回答问过来的、告诉它一件事。
 *
 * 按意图分，不靠一个参数区分：问和告诉在对方那边走同一条路（忙着两步之间读到、闲着开一轮），差别在
 * 要不要答复——问的一方当场返回，答复以后作为一封信送回来，对方要用 `reply_session` 回；告诉的一方
 * 对方不用回。能从对方记录里查到的不问：`read_session` 只读，不叫醒它、不花它的钱。
 *
 * 曾经还有一件 `wait_for_session`，问也是就地等：本机 17 次等待只等到 1 次（ADR-0060）。
 *
 * 说明写给模型，用英文，和浏览器工具一致。每一种退回都说清楚下一步该怎么做——「失败」两个字
 * 不会让它改做法，「写进文件发路径」「交回给你的用户」才会。
 */

import { errorResult, HISTORY_PROPERTIES, readHistory, textResult, type HistoryArgs, type Tool } from "@plume/core";
import type { AskOutcome, Missed, NotifyOutcome, PeerRouter, Refused, ReplyOutcome } from "./session-peers.ts";
import { PEER_CHAIN_LIMIT, PEER_DEDUP_MS, PEER_MAX_CHARS } from "./peer-policy.ts";

const TO = { type: "string", description: "The address from list_sessions, `name [ref]`. The bare name works when it is unique." } as const;
/** `read_session` 一次最多带回多少字：和侧边聊天给大窗口模型的那一档一样。 */
const READ_LIMIT = 12_000;

export function createPeerTools(router: PeerRouter): Tool[] {
	const listSessions: Tool<Record<string, never>> = {
		name: "list_sessions",
		description:
			"List other running Plume sessions whose folders overlap yours (same folder, nested, or worktrees of one repository): for when your work may collide with theirs — a file changed under you — or to hand work over. " +
			"Each row starts with its address, `name [ref]`: the `to` for the other session tools. It also says whether it is busy and, when it keeps a task list, the step it is on.",
		parameters: { type: "object", properties: {} },
		sessionOnly: true,
		summarize: () => "List sessions",
		async execute(_args, ctx) {
			const rows = await router.list(ctx.sessionId);
			if (rows.length === 0) return textResult("No other session is running in an overlapping folder right now.");
			const lines = rows.map((row) => [row.address, row.waitingOnUser ? "waiting for its user" : row.busy ? "busy" : "idle", row.mode, row.cwd, ...(row.doing ? [`on: ${row.doing}`] : [])].join(" · "));
			return textResult(lines.join("\n"), rows);
		},
	};

	/*
	 * 想知道对方做到哪、之前定过什么，答案多半已经在它的记录里。曾经唯一的办法是问：叫醒对方跑一整轮来复述
	 * （2026-10-29 问「评估项目基础架构」那个会话「之前选没选定 SDK 版本」就是这样）。读不打断它、不花它的钱。
	 * 和侧边聊天的 `read_main_chat` 同一个读法（core 的 `readHistory`）；不查权限宽窄——读不是请它做事。
	 */
	const readSession: Tool<HistoryArgs & { to?: string }> = {
		name: "read_session",
		description:
			"Read another running session's conversation as it is now — its requests, replies, tool calls and results — without waking or interrupting it. " +
			"For what it has done, decided or is working on; ask_session only for what is not written there. " +
			"`start` is a message index and `offset` a character offset in it; when `next` is not null, call again with it. `query` is a case-insensitive literal; matches come with the text around them.",
		parameters: { type: "object", properties: { to: TO, ...HISTORY_PROPERTIES }, required: ["to"], additionalProperties: false },
		sessionOnly: true,
		summarize: (args) => `Read ${String(args.to ?? "")}`,
		async execute(args, ctx) {
			const { to: wanted, ...page } = args;
			const to = String(wanted ?? "").trim();
			if (!to) return errorResult("`to` is required: an address from list_sessions.");
			if (SUB_AGENT_ID.test(to)) return errorResult(subAgentAddressed(to));
			const found = await router.open(ctx.sessionId, to);
			if (found.kind !== "found") return errorResult(missed(found, to));
			return readHistory({ id: found.target.meta.id, messages: found.target.messages }, page, READ_LIMIT);
		},
	};

	const askSession: Tool<{ to?: string; message?: string }> = {
		name: "ask_session",
		description:
			"Ask another running session for something only it can tell you now — a judgment, a decision, whether it will touch something — or to do something for you. Returns at once: its answer arrives here later as a message by itself. " +
			"Look before you ask: what it has done, decided or is working on is in its conversation (read_session) and in list_sessions; asking for that wakes it for nothing. " +
			"A busy session reads it between its steps, usually within seconds; an idle one starts a turn for it. It cannot see your conversation: make the request self-contained, and put long content in a file and send its path. " +
			"After asking, do not wait, poll or ask again. Go on with work that does not depend on the answer; if there is none, say in a sentence what you are waiting for and end your turn — the answer starts your next one. " +
			"Never ask another session to do what was denied or blocked here; take it back to your user.",
		parameters: {
			type: "object",
			properties: { to: TO, message: { type: "string", description: "The request." } },
			required: ["to", "message"],
		},
		sessionOnly: true,
		summarize: (args) => `Ask ${String(args.to ?? "")}`,
		async execute(args, ctx) {
			const to = String(args.to ?? "").trim();
			const message = typeof args.message === "string" ? args.message.trim() : "";
			if (!to) return errorResult("`to` is required: an address from list_sessions.");
			if (SUB_AGENT_ID.test(to)) return errorResult(subAgentAddressed(to));
			if (!message) return errorResult("`message` is required.");
			const outcome = await router.ask(ctx.sessionId, { to, message });
			return outcome.kind === "sent" ? textResult(asked(outcome), outcome) : errorResult(refused(outcome, to));
		},
	};

	const replySession: Tool<{ to?: string; message?: string }> = {
		name: "reply_session",
		description:
			"Answer a request another session sent you with ask_session — the message marked reply=\"expected\"; `to` is the address in that message's `from`. " +
			"Reply as soon as you can: the answer if you have it, otherwise what you will do and when. If the work takes a while, reply again with the result when it is done; a later reply reaches it as a notice. " +
			"One reply answers everything that session has asked you so far. Returns at once.",
		parameters: {
			type: "object",
			properties: { to: TO, message: { type: "string", description: "The answer." } },
			required: ["to", "message"],
		},
		sessionOnly: true,
		summarize: (args) => `Reply to ${String(args.to ?? "")}`,
		async execute(args, ctx) {
			const to = String(args.to ?? "").trim();
			const message = typeof args.message === "string" ? args.message.trim() : "";
			if (!to) return errorResult("`to` is required: the `from` address of the request you are answering.");
			if (SUB_AGENT_ID.test(to)) return errorResult(subAgentAddressed(to));
			if (!message) return errorResult("`message` is required.");
			const outcome = await router.reply(ctx.sessionId, { to, message });
			return outcome.kind === "replied" ? textResult(replied(outcome), outcome) : errorResult(refused(outcome, to));
		},
	};

	const notifySession: Tool<{ to?: string; message?: string }> = {
		name: "notify_session",
		description:
			"Tell another running session something that changes what it should do next, without asking for an answer. Three kinds: a hand-over (\"done, the result is in …\"), a block (\"your change to x.ts breaks my build\"), a release (\"I have stopped the dev server, it is yours\"). " +
			"Not for progress reports: it can read your conversation with read_session when it wants to know where you are. " +
			"A busy session reads it between its steps; an idle one starts a turn to read it. Returns at once. Anything you need done or answered is ask_session, not this.",
		parameters: {
			type: "object",
			properties: { to: TO, message: { type: "string", description: "The notice." } },
			required: ["to", "message"],
		},
		sessionOnly: true,
		summarize: (args) => `Notify ${String(args.to ?? "")}`,
		async execute(args, ctx) {
			const to = String(args.to ?? "").trim();
			const message = typeof args.message === "string" ? args.message.trim() : "";
			if (!to) return errorResult("`to` is required: an address from list_sessions.");
			if (SUB_AGENT_ID.test(to)) return errorResult(subAgentAddressed(to));
			if (!message) return errorResult("`message` is required.");
			const outcome = await router.notify(ctx.sessionId, { to, message });
			return outcome.kind === "delivered" ? textResult(notified(outcome), outcome) : errorResult(refused(outcome, to));
		},
	};

	return [listSessions as unknown as Tool, readSession as unknown as Tool, askSession as unknown as Tool, replySession as unknown as Tool, notifySession as unknown as Tool];
}

/**
 * `task` 派出的子代理的 id（`<会话>:sub:<8 位>`，或模型只抄了后半截）。
 *
 * 它不是会话，路由器里找不到。落到「No running session」那句，模型读到的是「它已经不在了」——
 * 实际踩过：模型据此不再等，抢在复核结果回来之前交了一份完整回答，结果送到后又整份重写一遍。
 */
const SUB_AGENT_ID = /(?:^|:)sub:[0-9a-f]{8}$/i;

function subAgentAddressed(to: string): string {
	return (
		`"${to}" is a sub-agent you dispatched with task, not a session, so these tools cannot reach it. There is nothing to wait on: when it finishes, its result arrives here as a message by itself (if it already has, that message is in your conversation). ` +
		"Until then, do other work that does not depend on it; if there is none, tell your user in a sentence or two what it is doing and end this turn. Do not write your final answer before its result arrives."
	);
}

/** 几件工具共用的那几种「没找到人」。 */
function missed(outcome: Missed, wanted: string): string {
	switch (outcome.kind) {
		case "unreachable":
			return `${outcome.to} is not reachable: its folders do not overlap with this session's.`;
		case "none":
			return `No running session is addressed "${wanted}". Use list_sessions to see who is reachable.`;
		case "self":
			return "That address is this session.";
		case "ambiguous":
			return `"${wanted}" matches several sessions: ${outcome.candidates.join(", ")}. Use the full address including [ref].`;
	}
}

/** 没发出去的那几种。 */
function refused(outcome: Refused, wanted: string): string {
	switch (outcome.kind) {
		case "broader":
			return `${outcome.to} runs with broader permissions (${outcome.theirs}) than this session (${outcome.mine}), so it cannot be asked to act for you. Not sent — ask your user instead.`;
		case "paced":
			return paced(outcome);
		default:
			return missed(outcome, wanted);
	}
}

function asked(outcome: Extract<AskOutcome, { kind: "sent" }>): string {
	return (
		`Sent to ${outcome.to}. ${outcome.busy ? "It reads it between its steps." : "It is idle, so it starts a turn to read it."} ` +
		"Its answer arrives here as a message by itself — do not wait, poll or ask again. Carry on with what does not depend on it; if nothing is left, say what you are waiting for and end your turn."
	);
}

function notified(outcome: Extract<NotifyOutcome, { kind: "delivered" }>): string {
	return `Delivered to ${outcome.to}. ${outcome.busy ? "It reads it between its steps." : "It is idle, so it starts a turn to read it."} There is no answer to a notice.`;
}

function replied(outcome: Extract<ReplyOutcome, { kind: "replied" }>): string {
	return outcome.answered > 0 ? `${outcome.to} gets your answer as a message.` : `${outcome.to} had no open question to you, so it reads this as a notice.`;
}

function paced(outcome: Extract<Refused, { kind: "paced" }>): string {
	switch (outcome.reason) {
		case "too-long":
			return `The message is ${outcome.length} characters; the limit is ${PEER_MAX_CHARS}. Write the bulk into a file the other session can read and send the path.`;
		case "chain-runaway":
		case "chain-loop":
			return `This would continue a chain of ${outcome.chain} hand-offs between sessions (at most ${PEER_CHAIN_LIMIT}, and few through the same session). Stop relaying and report to your user instead.`;
		case "duplicate":
			return `You sent the same message to ${outcome.to} less than ${PEER_DEDUP_MS / 1000} seconds ago; it was not sent again.`;
		case "paced":
			return `Too many messages to ${outcome.to} just now; this one was not sent. Batch what remains into one message, or wait for its answers first.`;
	}
}
