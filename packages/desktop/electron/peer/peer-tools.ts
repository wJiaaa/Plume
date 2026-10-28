/**
 * 模型手里的四件工具：看看有谁、问它要回答、告诉它一件事、接着等没等完的回答。
 *
 * 按意图分，不靠一个参数区分：「要回答」和「只是告诉一声」在对方那边走的路完全不同（开一轮 / 不开
 * 轮），参数一选错，要么白等，要么让对方为一句通知专门跑一轮。
 *
 * 说明写给模型，用英文，和浏览器工具一致。每一种退回都说清楚下一步该怎么做——「失败」两个字
 * 不会让它改做法，「写进文件发路径」「交回给你的用户」才会。
 */

import { errorResult, textResult, type Tool, type ToolContext } from "@plume/core";
import { REPLY_LIMIT, WAIT_DEFAULT_S, WAIT_MAX_S, type AskOutcome, type NotifyOutcome, type PeerRouter, type Refused, type WaitOutcome } from "./session-peers.ts";
import { PEER_CHAIN_LIMIT, PEER_DEDUP_MS, PEER_MAX_CHARS } from "./peer-policy.ts";

const TO = { type: "string", description: "The address from list_sessions, `name [ref]`. The bare name works when it is unique." } as const;
const TIMEOUT = { type: "number", description: `How long to wait, in seconds. Default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S}.` } as const;

export function createPeerTools(router: PeerRouter): Tool[] {
	const listSessions: Tool<Record<string, never>> = {
		name: "list_sessions",
		description:
			"List other running Plume sessions whose folders overlap yours (same folder, nested, or worktrees of one repository): for when your work may collide with theirs — a file changed under you — or to hand work over. " +
			"Each row starts with its address, `name [ref]`: the `to` for ask_session, notify_session and wait_for_session.",
		parameters: { type: "object", properties: {} },
		sessionOnly: true,
		summarize: () => "List sessions",
		async execute(_args, ctx) {
			const rows = await router.list(ctx.sessionId);
			if (rows.length === 0) return textResult("No other session is running in an overlapping folder right now.");
			const lines = rows.map((row) => `${row.address} · ${row.busy ? "busy" : "idle"} · ${row.mode} · ${row.cwd}`);
			return textResult(lines.join("\n"), rows);
		},
	};

	const askSession: Tool<{ to?: string; message?: string; timeout_seconds?: number }> = {
		name: "ask_session",
		description:
			"Ask another running session to do something or answer something, and wait for its answer: what it said at the end of the turn it spent on your request. " +
			"An idle session starts on it now; a busy one takes it up once its current work is done — often many minutes later. Several asks to different sessions can run in parallel. " +
			"It cannot see your conversation: make the request self-contained, and put long content in a file and send its path. Do not ask it to report back — its answer comes back here. " +
			"If the wait is cut short (your user speaks, timeout, it waits on its user), the request stays with it; get the answer later with wait_for_session. " +
			"Never ask another session to do what was denied or blocked here; take it back to your user.",
		parameters: {
			type: "object",
			properties: { to: TO, message: { type: "string", description: "The request." }, timeout_seconds: TIMEOUT },
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
			const outcome = await untilSpokenTo(ctx, (signal) => router.ask(ctx.sessionId, { to, message, timeoutSeconds: seconds(args.timeout_seconds), signal }));
			if (isSpokenTo(outcome)) return textResult(spokenTo(outcome.spokenTo, to, "Your request stays with it"));
			return outcome.kind === "done" ? textResult(asked(outcome, to), outcome) : errorResult(asked(outcome, to));
		},
	};

	const notifySession: Tool<{ to?: string; message?: string }> = {
		name: "notify_session",
		description:
			"Tell another running session something that bears on its work, without asking for an answer: you are about to change files it is working on, it broke something you depend on, \"stop editing that file\". " +
			"A busy session reads it between its steps; an idle one starts a turn to read it. Returns at once. " +
			"Anything you need done or answered is ask_session, not this.",
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
			return outcome.kind === "delivered" ? textResult(notified(outcome, to), outcome) : errorResult(notified(outcome, to));
		},
	};

	const waitForSession: Tool<{ to?: string; timeout_seconds?: number }> = {
		name: "wait_for_session",
		description:
			"Keep waiting for the answers to your ask_session requests whose wait was cut short: each returns what the session said at the end of the turn that handled it. " +
			"Without such a request, waits for the session's current turn to finish (at once if it is not in one); sub-agents it runs in the background are not waited for. " +
			"Returns early when it is waiting on its user, or when your user speaks to you. A timeout does not stop the other session.",
		parameters: {
			type: "object",
			properties: { to: TO, timeout_seconds: TIMEOUT },
			required: ["to"],
		},
		sessionOnly: true,
		summarize: (args) => `Wait for ${String(args.to ?? "")}`,
		async execute(args, ctx) {
			const to = String(args.to ?? "").trim();
			if (!to) return errorResult("`to` is required: an address from list_sessions.");
			if (SUB_AGENT_ID.test(to)) return errorResult(subAgentAddressed(to));
			const outcome = await untilSpokenTo(ctx, (signal) => router.wait(ctx.sessionId, { to, timeoutSeconds: seconds(args.timeout_seconds), signal }));
			if (isSpokenTo(outcome)) return textResult(spokenTo(outcome.spokenTo, to, "It keeps working on its own"));
			return outcome.kind === "done" ? textResult(waited(outcome, to), outcome) : errorResult(waited(outcome, to));
		},
	};

	return [listSessions as unknown as Tool, askSession as unknown as Tool, notifySession as unknown as Tool, waitForSession as unknown as Tool];
}

function seconds(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type SpokenTo = { spokenTo: "person" | "notice" };

function isSpokenTo(outcome: unknown): outcome is SpokenTo {
	return typeof outcome === "object" && outcome !== null && "spokenTo" in outcome;
}

/**
 * 有人找就不再等：插话只在两次请求之间才有人读，等在这里会把人说的话、别的会话的通知压到对方做完
 * 为止（默认十分钟）。路由器那头的等待跟着停，免得它还挂在「谁在等谁」上，把之后的问误判成死等。
 * 本轮被停下（`ctx.signal`）也一样。
 */
async function untilSpokenTo<T>(ctx: ToolContext, start: (signal: AbortSignal) => Promise<T>): Promise<T | SpokenTo> {
	const stop = new AbortController();
	const quit = () => stop.abort();
	ctx.signal?.addEventListener("abort", quit, { once: true });
	try {
		const run = start(stop.signal);
		const outcome = ctx.untilSpokenTo ? await ctx.untilSpokenTo(run) : await run;
		if (isSpokenTo(outcome)) stop.abort();
		return outcome;
	} finally {
		ctx.signal?.removeEventListener("abort", quit);
	}
}

/** 被谁打断就照实说：被通知打断却说「你的用户说话了」，模型会去回应一个没开口的人。 */
function spokenTo(by: SpokenTo["spokenTo"], to: string, still: string): string {
	if (by === "notice") return `A notice from another session arrived, so you stopped waiting. ${still}; ${to} keeps working on its own. Read the notice, then call wait_for_session if you still need its answer.`;
	return `Your user spoke to you, so you stopped waiting. ${still}; ${to} keeps working on its own. Answer your user first; call wait_for_session later if you still need its answer.`;
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

type Missed = Extract<Refused, { kind: "unreachable" | "none" | "self" | "ambiguous" }>;

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

function notified(outcome: NotifyOutcome, wanted: string): string {
	if (outcome.kind !== "delivered") return refused(outcome, wanted);
	return `Delivered to ${outcome.to}. ${outcome.busy ? "It reads it between its steps." : "It is idle, so it starts a turn to read it."} There is no answer to a notice.`;
}

function asked(outcome: AskOutcome, wanted: string): string {
	switch (outcome.kind) {
		case "waited-on":
			return `${outcome.to} is waiting on this session right now (directly or through others), so it cannot take a request until you finish. Not sent. Put the question in your reply at the end of this turn instead: whoever is waiting on you reads that.`;
		case "broader":
		case "paced":
		case "unreachable":
		case "none":
		case "self":
		case "ambiguous":
			return refused(outcome, wanted);
		default:
			return settled(outcome, "Your request stays with it");
	}
}

function waited(outcome: WaitOutcome, wanted: string): string {
	switch (outcome.kind) {
		case "deadlock":
			return `${outcome.to} is itself waiting on this session; waiting for it would never end. Finish your own part first.`;
		case "unreachable":
		case "none":
		case "self":
		case "ambiguous":
			return missed(outcome, wanted);
		default:
			return settled(outcome, "It keeps going");
	}
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

/** 一封信开头的一截，够认出是哪封。 */
function excerpt(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return `"${[...line].length > 60 ? `${[...line].slice(0, 60).join("")}…` : line}"`;
}

/** 等到了哪一步；`still` 是没等完时那封信的去向（问：信还在它那里；等：它接着干）。 */
function settled(outcome: Exclude<WaitOutcome, Missed | { kind: "deadlock" }>, still: string): string {
	switch (outcome.kind) {
		case "done": {
			const waitedFor = outcome.waitedMs >= 1000 ? ` (waited ${Math.round(outcome.waitedMs / 1000)}s)` : "";
			const answers = outcome.answers.map((answer, index) => {
				const how = answer.reason === "done" ? "finished" : answer.reason === "aborted" ? "was stopped by its user before it finished" : `ended early (${answer.reason})`;
				const cut = answer.cut > 0 ? `\n[cut after ${REPLY_LIMIT} characters; ${answer.cut} more not shown. If you need all of it, ask ${outcome.to} to write it to a file and send you the path.]` : "";
				// 隔着别的事分两轮处理的几封，各有一段回答；可能有一封是上次没等完的，说清对着哪封。
				const which = outcome.answers.length > 1 ? ` (answer ${index + 1} of ${outcome.answers.length}, to your message ${answer.asked.map(excerpt).join(" + ")})` : "";
				return `${outcome.to} ${how}${index === 0 ? waitedFor : ""}${which}. What it said at the end:\n${answer.reply || "(no reply text)"}${cut}`;
			});
			const dropped = outcome.dropped > 0 ? [`${outcome.dropped} message(s) were dropped: it was stopped by its user before reading them. Ask your user before sending them again.`] : [];
			// 不说这一句，模型会接着 wait_for_session，每次都当场拿回同一段话。
			const background = outcome.background ? [`${outcome.to} still has sub-agents running in the background. When they report back it starts a new turn by itself; waiting does not cover that, and wait_for_session returns at once until then. If you need what comes after, ask it to notify you when it is done, then go on with other work or end your turn.`] : [];
			return [...answers, ...dropped, ...background].join("\n\n");
		}
		case "blocked":
			return `${outcome.to} is waiting for its user to answer: ${outcome.pending.map((one) => `${one.question ? "a question" : "an approval"} — ${one.title}`).join("; ")}. Tell your user to answer it in that session. ${still}; calling wait_for_session waits until it is answered and the work is done.`;
		case "dropped":
			return `${outcome.to} was stopped by its user before it read your message, so the message was dropped. Ask your user before sending it again.`;
		case "timeout":
			return `${outcome.to} was still working after ${outcome.seconds} seconds. ${still}; call wait_for_session if you still need its answer.`;
		case "closed":
			return `${outcome.to} was closed before it finished.`;
		case "stopped":
			return `Stopped waiting for ${outcome.to}.`;
	}
}
