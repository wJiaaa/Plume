/**
 * 让模型给这个对话安排以后的继续：`schedule_wakeup`、`cron_create`、`cron_list`、`cron_delete`。
 *
 * 由宿主注入（`extraTools`）而不是 core 自己挂：只有桌面端的主会话有，命令行跑完一个任务就退出，
 * 没有「以后」可言。`sessionOnly` 让子代理拿不到——它不是一个对话，到点送达的消息没有人接；侧边聊天
 * 不带宿主注入的工具。和 `session-ops.ts` 一样，一份工具所有会话共用，是谁调的看 `ctx.sessionId`。
 *
 * 说明写给模型，用英文，和别的宿主工具一致。任务表本身在 `session-wakeups.ts`。
 *
 * 四件的说明每个请求都带着，所以只写模型决定「用不用、怎么用」要的话，每件事只在一处说：到点怎么
 * 送、活多久写在 `schedule_wakeup`，`cron_create` 说「同上」，和定时任务页的分别写在 `cron_create`
 * ——要「每天早上」的模型找的是它。跳过、上限、过期这些调用之后才用得上的，由工具结果和报错去说。
 */

import type { SessionWakeup } from "../../agent/events.ts";
import { errorResult } from "../../tools/result.ts";
import type { Tool, ToolResult } from "../../types.ts";
import { localTime } from "./wakeup-message.ts";
import { CRON_MAX_AGE_MS, WAKEUP_MAX_SECONDS, WAKEUP_MIN_SECONDS, type SessionWakeups } from "./session-wakeups.ts";

const SCHEDULE_WAKEUP_TOOL = "schedule_wakeup";
const CRON_CREATE_TOOL = "cron_create";
const CRON_LIST_TOOL = "cron_list";
const CRON_DELETE_TOOL = "cron_delete";

/** 一段续做的说明装得下；再长就是把一份记录贴进了提醒里。 */
const PROMPT_MAX = 4000;
const REASON_MAX = 200;

const DAYS = CRON_MAX_AGE_MS / (24 * 60 * 60_000);

function text(value: unknown, name: string, max: number): string | { error: string } {
	if (typeof value !== "string" || !value.trim()) return { error: `${name} is required and must be non-empty text.` };
	const trimmed = value.trim();
	const length = [...trimmed].length;
	if (length > max) return { error: `${name} is ${length} characters; keep it to ${max}.` };
	return trimmed;
}

/** 一行，给模型读：id、什么时候、循环与否、过期。 */
function describe(wakeup: SessionWakeup): string {
	const when = wakeup.kind === "cron" ? `cron "${wakeup.cron}"${wakeup.recurring ? "" : ", once"}` : "one-time wakeup";
	const expiry = wakeup.expiresAt !== undefined ? `, expires ${localTime(wakeup.expiresAt)}` : "";
	const label = wakeup.reason ?? (wakeup.prompt.split("\n")[0] ?? "");
	return `${wakeup.id}: ${when}, next ${localTime(wakeup.nextAt)}${expiry}${wakeup.fired ? `, fired ${wakeup.fired}x` : ""} — ${label}`;
}

function attempt(run: () => ToolResult): ToolResult {
	try {
		return run();
	} catch (error) {
		return errorResult(error instanceof Error ? error.message : String(error));
	}
}

export function createWakeupTools(find: (sessionId: string) => SessionWakeups | undefined): Tool[] {
	/** `sessionOnly` 已经挡住子代理；这里再挡一次，免得别处重建工具表时把子代理的调用记到父会话头上。 */
	const table = (sessionId: string): SessionWakeups | { error: string } => {
		if (sessionId.includes(":sub:")) return { error: "Only the conversation itself can schedule wakeups; a sub-agent cannot." };
		return find(sessionId) ?? { error: "This conversation cannot schedule wakeups." };
	};

	const wakeup: Tool<{ delay_seconds?: unknown; prompt?: unknown; reason?: unknown }> = {
		name: SCHEDULE_WAKEUP_TOOL,
		description:
			"Come back to this conversation once, after a delay (\"check the CI result in 10 minutes\"). " +
			"When it fires, a message arrives here and you carry on from it; nothing runs before then, so end this turn normally. " +
			"Not needed for a background command or sub-agent: those already report back when done. " +
			"Each wakeup costs a turn, so wait as long as the thing takes — 300-600 seconds for CI or a deploy. " +
			"It lives in this conversation only: cancelled by Stop, gone if the app quits.",
		parameters: {
			type: "object",
			properties: {
				delay_seconds: { type: "number", description: `Seconds from now, ${WAKEUP_MIN_SECONDS} to ${WAKEUP_MAX_SECONDS}.` },
				prompt: { type: "string", description: "What to do when it fires, written to yourself: what to check and what to do with the answer." },
				reason: { type: "string", description: "A few words shown to the person (\"waiting for CI on #482\")." },
			},
			required: ["delay_seconds", "prompt", "reason"],
			additionalProperties: false,
		},
		sessionOnly: true,
		summarize: (args) => `Schedule wakeup ${typeof args.reason === "string" ? args.reason.trim() : ""}`.trim(),
		execute: async (args, ctx) => attempt(() => {
			const found = table(ctx.sessionId);
			if ("error" in found) return errorResult(found.error);
			const prompt = text(args.prompt, "prompt", PROMPT_MAX);
			if (typeof prompt !== "string") return errorResult(prompt.error);
			const reason = text(args.reason, "reason", REASON_MAX);
			if (typeof reason !== "string") return errorResult(reason.error);
			if (typeof args.delay_seconds !== "number") return errorResult("delay_seconds must be a number of seconds.");
			const { wakeup: made, clamped } = found.wakeup(args.delay_seconds, prompt, reason);
			return {
				content: [{
					type: "text",
					text:
						`Scheduled ${made.id} for ${localTime(made.nextAt)}${clamped ? ` (raised to the ${WAKEUP_MIN_SECONDS}-second minimum)` : ""}. ` +
						"Nothing runs until then; finish this turn normally. It is cancelled if the person presses Stop, and gone if the app quits. Cancel it with cron_delete.",
				}],
				details: { kind: "wakeup", wakeup: made },
			};
		}),
	};

	const create: Tool<{ cron?: unknown; prompt?: unknown; recurring?: unknown }> = {
		name: CRON_CREATE_TOOL,
		description:
			"Like schedule_wakeup, but on a schedule (\"check the deploy every 5 minutes until it is done\", \"at 14:30 today\"). " +
			"5-field cron in local time: \"*/5 * * * *\", \"30 14 * * *\", \"0 9 * * 1-5\". " +
			`Recurring jobs expire after ${DAYS} days. Each firing costs a turn: pick the longest interval that works, and delete the job with cron_delete once it is settled. ` +
			"Not the app's Scheduled page (定时任务): for something that should keep running on its own (\"every morning\"), tell the person to create it there.",
		parameters: {
			type: "object",
			properties: {
				cron: { type: "string", description: "5-field cron expression in local time." },
				prompt: { type: "string", description: "What to do each time it fires, written to yourself, including when to stop." },
				recurring: { type: "boolean", description: "Default true; false fires once at the next match." },
			},
			required: ["cron", "prompt"],
			additionalProperties: false,
		},
		sessionOnly: true,
		summarize: (args) => `Create cron ${typeof args.cron === "string" ? args.cron.trim() : ""}`.trim(),
		execute: async (args, ctx) => attempt(() => {
			const found = table(ctx.sessionId);
			if ("error" in found) return errorResult(found.error);
			if (typeof args.cron !== "string" || !args.cron.trim()) return errorResult("cron is required: a 5-field cron expression.");
			const prompt = text(args.prompt, "prompt", PROMPT_MAX);
			if (typeof prompt !== "string") return errorResult(prompt.error);
			if (args.recurring !== undefined && typeof args.recurring !== "boolean") return errorResult("recurring must be true or false.");
			const made = found.cron(args.cron, prompt, args.recurring !== false);
			const tail = made.recurring
				? `It repeats until ${localTime(made.expiresAt ?? made.nextAt)}, when it expires; a firing that comes while the turn of the previous one is still running is skipped.`
				: "It fires once, then is deleted.";
			return {
				content: [{ type: "text", text: `Created ${made.id}. Next firing: ${localTime(made.nextAt)}. ${tail} Nothing runs until then; finish this turn normally. Cancel it with cron_delete.` }],
				details: { kind: "wakeup", wakeup: made },
			};
		}),
	};

	const list: Tool = {
		name: CRON_LIST_TOOL,
		description: "List this conversation's pending wakeups and cron jobs, with ids and next firing times.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		sessionOnly: true,
		summarize: () => "List cron jobs",
		execute: async (_args, ctx) => attempt(() => {
			const found = table(ctx.sessionId);
			if ("error" in found) return errorResult(found.error);
			const all = found.list();
			return {
				content: [{ type: "text", text: all.length === 0 ? "No pending wakeups or cron jobs in this conversation." : all.map(describe).join("\n") }],
			};
		}),
	};

	const remove: Tool<{ id?: unknown }> = {
		name: CRON_DELETE_TOOL,
		description: "Cancel a pending wakeup or cron job by id.",
		parameters: {
			type: "object",
			properties: { id: { type: "string", description: "The id, e.g. \"cron-2\"." } },
			required: ["id"],
			additionalProperties: false,
		},
		sessionOnly: true,
		summarize: (args) => `Delete cron ${typeof args.id === "string" ? args.id.trim() : ""}`.trim(),
		execute: async (args, ctx) => attempt(() => {
			const found = table(ctx.sessionId);
			if ("error" in found) return errorResult(found.error);
			if (typeof args.id !== "string" || !args.id.trim()) return errorResult("id is required.");
			const id = args.id.trim();
			if (!found.cancel(id)) return errorResult(`No pending wakeup or cron job "${id}" in this conversation; it may have fired already. cron_list shows what is pending.`);
			return { content: [{ type: "text", text: `Cancelled ${id}.` }] };
		}),
	};

	return [wakeup, create, list, remove];
}
