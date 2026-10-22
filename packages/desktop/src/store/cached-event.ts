import { translate } from "../i18n/translate.ts";
import type { AgentEvent, Message } from "@plume/core";
import { settleTail } from "../lib/transcript.ts";
import { applyToolEvent } from "./apply-tool.ts";
import { EMPTY_SLOT, rebuildToolRuns, todosFrom, type Cache, type CachedSessionState } from "./derive.ts";
import { howItStopped } from "./turn-stop.ts";
import { messageEvent } from "./message-event.ts";
import { foldRetry, settleHiccups } from "../lib/hiccup.ts";
import { outlivingTurn } from "../lib/approval-scope.ts";
import type { ToolRun } from "./tool-run.ts";

/** 一个会话的转录和这一轮的状态——屏上那个摊在 `AppState` 顶层，停在缓存里的分在 `Cache` 的几格里。 */
export type SessionSlot = CachedSessionState & { messages: Message[]; toolRuns: Record<string, ToolRun> };

/**
 * 一个会话收到一条事件之后的样子。
 *
 * 屏上那个会话和停在缓存里的那些走同一份：从前各写一遍，审批卡逐字段抄了两份，`rewound` 一边重建
 * 工具卡和清单、一边不。这里只管转录和这一轮的状态；只属于屏上那个的事（合批、通知、子智能体）留在
 * `apply-event`。
 *
 * `handoff`：这一轮是被「现在就发」停下的，会话不放下，新的一轮几十毫秒后就开始（见 `handoff.ts`）。
 * 不认得的事件原样交回同一个对象，调用方据此不写。
 */
export function foldEvent(slot: SessionSlot, event: AgentEvent, sessionId: string, handoff = false): SessionSlot {
	switch (event.type) {
		case "message_start": case "message_update": case "message_end": {
			const next = messageEvent(slot, event, sessionId);
			const cleared = event.message.role === "user" && event.message.clearsTaskPlan === true;
			// 有东西流进来，连接就是好的：「N 秒后重试」不能一直挂到这一轮结束。
			return { ...slot, messages: next.messages, pendingUserMessage: next.pendingUserMessage, retrying: null, ...(cleared ? { todos: [] } : {}) };
		}
		case "tool_start": case "tool_update": case "tool_end": {
			let next = slot.retrying === null ? slot : { ...slot, retrying: null };
			applyToolEvent(event, (patch) => { next = { ...next, ...patch }; }, () => next);
			return next;
		}
		case "agent_start":
			/*
			 * 上一轮的波折不带进这一轮。
			 *
			 * 记录挂在转录末尾，说的是「这一轮发生了什么」。留着上一轮的，它就会显示在一段跟它无关的
			 * 回答下面——而那一轮的事，读的人已经在当时看过了。
			 */
			return { ...slot, running: true, stopped: null, retrying: null, hiccups: [] };
		case "agent_end": {
			// 先落定再问怎么停的：写到一半的回复是 `settleTail` 落成 `aborted` 的，问旧的那份得到的还是 `pending`。
			const messages = settleTail(slot.messages, event);
			return {
				...slot,
				messages,
				running: handoff,
				stopped: handoff ? null : howItStopped(messages, event.reason),
				retrying: null,
				compactedAt: null,
				pendingUserMessage: null,
				// 主会话自己的问题跟着这一轮走；后台子智能体的还等着人，见 `outlivingTurn`。
				approvals: outlivingTurn(slot.approvals),
				commandRuns: slot.commandRuns.map((run) => (run.automatic && run.status === "running" ? { ...run, status: "cancelled", detail: translate("compact.autoInterrupted") } : run)),
			};
		}
		case "approval_request":
			// Rebuilt field by field, so anything added to the event has to be added here too.
			return {
				...slot,
				approvals: [...slot.approvals, {
					id: event.requestId, kind: event.kind, title: event.title, detail: event.detail,
					...(event.reason ? { reason: event.reason } : {}),
					...(event.risk ? { risk: event.risk } : {}),
					subject: event.subject,
					...(event.escalation ? { escalation: event.escalation } : {}),
					...(event.fields ? { fields: event.fields } : {}),
					...(event.options ? { options: event.options } : {}),
					...(event.allowCustomInput !== undefined ? { allowCustomInput: event.allowCustomInput } : {}),
					selectionMode: event.selectionMode, allowSkip: event.allowSkip, defaultOptionIndex: event.defaultOptionIndex,
					...(event.expiresAt !== undefined ? { expiresAt: event.expiresAt } : {}),
					...(event.from ? { from: event.from } : {}),
				}],
			};
		// 一张卡收场了（答了、超时、问它的子智能体停下了）——核心说一声，这里拿走。
		case "approval_settled":
			if (!slot.approvals.some((one) => one.id === event.requestId)) return slot;
			return { ...slot, approvals: slot.approvals.filter((one) => one.id !== event.requestId) };
		case "rewound": {
			/*
			 * 运行时丢掉了一截历史：照它说的条数截，不从后面到的消息去猜。
			 *
			 * 按位置活着的记录（命令、钩子、压缩、抖动，见 `lib/hiccup.ts` 的 `at`）跟着它们说明的那一段
			 * 一起走——留下来的会滑到转录末尾，说给一段已经不存在的工作。清单回到截断处，和运行时一致
			 * （core 的 `restorePlan`）；工具卡只留还在转录里的那些。
			 */
			const messages = slot.messages.slice(0, event.messageCount);
			const kept = (one: { at: number }) => one.at <= event.messageCount;
			return {
				...slot,
				messages,
				toolRuns: rebuildToolRuns(messages, slot.running, slot.toolRuns),
				todos: todosFrom(messages),
				commandRuns: slot.commandRuns.filter(kept),
				hookRuns: slot.hookRuns.filter(kept),
				compactions: slot.compactions.filter(kept),
				hiccups: slot.hiccups.filter(kept),
			};
		}
		// 同一条钩子先报「开始」再报结局，按 id 替换，位置（`at`）以第一次为准——`SessionLog` 已经盖好了。
		case "hook_run":
			return { ...slot, hookRuns: [...slot.hookRuns.filter((run) => run.id !== event.run.id), event.run] };
		case "command_status": {
			// 一轮里的自动压缩跟着那一轮亮灭；一轮收尾后的那种（`automatic.idle`）外面没有轮，和手动压缩一样自己亮灭。
			const own = !event.command.automatic || event.command.automatic.idle === true;
			return { ...slot, ...(own ? { running: event.command.status === "running" } : {}), commandRuns: [...slot.commandRuns.filter((run) => run.id !== event.command.id), event.command] };
		}
		case "compacted":
			return {
				...slot,
				...(event.command ? { commandRuns: [...slot.commandRuns.filter((run) => run.id !== event.commandId), event.command] } : {}),
				// 自动压缩的结局只有这一条，没有收尾的 `command_status`：收尾后的那种在这里熄灭「进行中」。
				...(event.command?.automatic?.idle ? { running: false } : {}),
				compactions: [...slot.compactions, { at: slot.messages.length, before: event.before, after: event.after }],
				// When, as well as where: the running line mentions it for a moment.
				compactedAt: Date.now(),
			};
		case "retry":
			return {
				...slot,
				// Stamped on arrival: the delay is counted from now, and the countdown reads the clock.
				retrying: { attempt: event.attempt, until: Date.now() + event.delayMs, reason: event.reason },
				// 同一次中断折进同一条记录，次数往上加；位置是转录此刻的末尾——断线发生在这儿，记录也该留在这儿。
				hiccups: foldRetry(slot.hiccups, event, Date.now(), slot.messages.length),
			};
		/*
		 * 那次中断收场了——接上了，还是没接上。
		 *
		 * `retrying` 管的是运行行上那句「N 秒后重连」：接上之后那句话必须立刻消失，而记录要留下。两件事，
		 * 两个字段，同一个事件喂。
		 */
		case "retry_settled":
			return { ...slot, retrying: null, hiccups: settleHiccups(slot.hiccups, event, slot.messages.length) };
		default:
			return slot;
	}
}

/** Cache entries have history, so unlike never-visited sessions they can consume live events. */
export function cachedEvent(cached: Cache[string], event: AgentEvent, handoff = false): Cache[string] {
	const state = cached.state ?? { ...EMPTY_SLOT, todos: todosFrom(cached.messages), stopped: howItStopped(cached.messages) };
	const slot: SessionSlot = { ...state, messages: cached.messages, toolRuns: cached.toolRuns };
	const next = foldEvent(slot, event, cached.meta.id, handoff);
	if (next === slot) return cached;
	const { messages, toolRuns, ...rest } = next;
	return { ...cached, messages, toolRuns, state: rest, dirty: true };
}
