/**
 * 旧日志里没记下的那两处检查点，重建续跑上下文时补齐。
 *
 * 2026-10-29 之前，检查点上运行时递进去的两句话都不进转录：没写清单就续跑那段开头那句
 * （`planDemand`），和讨交接那句（`finalDemand`）。跑着的时候前一句在模型的历史里、讨交接那一轮不在；
 * 而日志里前一句没有、讨交接那一轮的回复和结果倒有。现在两句都记了（`sub-agent-run.ts`），这里只管
 * 那之前写下的日志，让它们重启后续跑发出的历史也跟没重启时逐字相同。
 *
 * 能补得回来，是因为两件事日志里都留了确定的痕迹：
 *
 * - `planDemand` 前面必有一条 `continue-planless` 通知，文本只取决于轮数，而上一段撞上检查点时最后
 *   那个 `turn_start` 正是第 `checkpoint` 轮（`loop.ts`）。时间戳补成那条通知的：它是 `synthetic`，
 *   不当日期块的锚点（`withEnvironment`），发出去的字节里没有它。
 * - 讨交接那一轮是这次派发的最后一段：紧跟在一段 `max_turns` 后面、中间没有续跑通知、至多两轮
 *   （`maxTurns: 2`），收场那句以「到了检查点（这一段 N 轮）」开头且 N 正是上一段的轮数。
 *
 * 认不准的一律不动：剔错一段真实的工作是发出错误的历史，留着多余的一轮只是这一次缓存不命中。
 */

import type { AgentEvent } from "../../agent/events.ts";
import type { Message } from "../../types.ts";
import { isPlanDemand, planDemand } from "./checkpoint-demands.ts";
import { isFinalDemand } from "./yield-tool.ts";

type Inner = Extract<AgentEvent, { type: "subagent_event" }>["event"];
type Done = Extract<AgentEvent, { type: "subagent_done" }>;

/** 讨交接那一轮的上限（`sub-agent-run.ts` 里 `maxTurns: 2`）。 */
const SALVAGE_TURNS = 2;
/** 跑满检查点、讨过交接的那种收场，答案开头那句（`sub-agent-finish.ts` 的 `incompleteNote`）。 */
const CHECKPOINT_NOTE = /^⚠ 到了检查点（这一段 (\d+) 轮）/;

interface Run {
	reason: string;
	turns: number;
	/** 这一段跑完时转录有多长。 */
	end: number;
	/** 它前面有续跑通知：是 `continueWhileWorkRemains` 接着跑的一段，不是讨交接。 */
	continued: boolean;
}

/** 一个子代理的一次派发（或续跑）里，各段是怎么跑、怎么停的。 */
export class LegacyCheckpoints {
	private runs: Run[] = [];
	private turns = 0;
	private continued = false;
	/** 刚说了「接着跑、先列清单」，那句话本身还没见到。 */
	private planless: { rounds: number; at: number } | undefined;
	/** 这次派发里讨交接那句记进了转录：新日志，剔除由 `isFinalDemand` 那条路管。 */
	private demanded = false;

	/** 新的一次派发或续跑：各段从头数。 */
	dispatched(): void {
		this.runs = [];
		this.turns = 0;
		this.continued = false;
		this.demanded = false;
	}

	event(inner: Inner, length: number, at: number): void {
		if (inner.type === "turn_start") this.turns = inner.turn;
		else if (inner.type === "agent_end") {
			this.runs.push({ reason: inner.reason, turns: this.turns, end: length, continued: this.continued });
			this.turns = 0;
			this.continued = false;
		} else if (inner.type === "notice" && (inner.code === "continue-plan" || inner.code === "continue-planless")) {
			this.continued = true;
			const last = this.runs.at(-1);
			if (inner.code === "continue-planless" && last?.reason === "max_turns") this.planless = { rounds: last.turns, at };
		}
	}

	/** 一条消息要进转录了。旧日志在它前面少了那句「接着跑」的话，就交回补上的那句。 */
	before(message: Message): Message | undefined {
		if (isFinalDemand(message)) this.demanded = true;
		const pending = this.planless;
		if (!pending) return undefined;
		this.planless = undefined;
		return isPlanDemand(message, pending.rounds) ? undefined : planDemand(pending.rounds, pending.at);
	}

	/** 这次派发收场了。旧日志里讨交接那一轮从转录的哪一条起，认不准就是 `undefined`。 */
	salvageFrom(done: Done): number | undefined {
		if (this.demanded || done.status !== "done" || !done.incomplete) return undefined;
		const last = this.runs.at(-1);
		const before = this.runs.at(-2);
		if (!last || !before || last.continued || before.reason !== "max_turns") return undefined;
		const rounds = Number(CHECKPOINT_NOTE.exec(done.answer)?.[1]);
		if (rounds !== before.turns || last.turns > SALVAGE_TURNS || last.turns >= before.turns) return undefined;
		return before.end;
	}
}
