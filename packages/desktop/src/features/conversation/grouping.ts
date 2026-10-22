/**
 * Where one row of the transcript ends and the next begins, decided on plain data.
 *
 * The transcript is not the message list. A stretch of tool work is one line however many
 * messages it took, and it has to be the *same* line from the first call to the last. A group
 * that only forms once the model stops talking is a group that appears mid-turn, pushes what is
 * under it down, and then hands its contents to the row above and vanishes — which is what made
 * the transcript move while the agent worked.
 *
 * So the rule here never asks whether a message has finished. It reads what has arrived, and
 * what has arrived only ever grows.
 */
import { routedBlock } from "../../lib/tool-summary.ts";
import type { AssistantContent, AssistantMessage, CommandRun, Message } from "@plume/core";
import { isPlanTick } from "../../store/turn-stop.ts";
import { drawnAt } from "../../store/message-event.ts";
import type { Hiccup } from "../../lib/hiccup.ts";
import { intact } from "../../lib/transcript.ts";
import { previewPages, samePage, type PageState } from "./preview-pages.ts";
import { SPAWN_SESSION_TOOL } from "../../../shared/session-suggestion.ts";
import { newClock, opensTurn, resumesTurn, saw, settled, snapshot, type TurnStats } from "./turns.ts";

type ToolCallBlock = Extract<AssistantContent, { type: "toolCall" }>;

/**
 * A call together with the state of the message that made it: a call is live only while its turn is.
 * `page`: how a checked page and its publishing stand — see `preview-pages.ts`.
 */
export type Call = { block: ToolCallBlock; stopReason: AssistantMessage["stopReason"]; page?: PageState };

export type Run =
	| { kind: "command"; command: CommandRun }
	/** 连接抖了一下，画在它抖的那个位置上。见 `lib/hiccup.ts` 的 `at`。 */
	| { kind: "hiccup"; hiccup: Hiccup }
	/**
	 * 从这里起换了一个模型回答。按回复上记的模型认，不按「切换」那个动作认：只在菜单里换一下、
	 * 一句没发，转录里什么也没发生。`at` 是它插在哪一条消息之前。
	 */
	| { kind: "model"; at: number; from: ModelUsed; to: ModelUsed }
	/**
	 * A message, and how much of it is this row's.
	 *
	 * `upTo` is a count of content blocks: everything from there to the end is tool work, which
	 * belongs to the run below rather than to the reply. It is the whole message whenever the
	 * message has no trailing calls, which is most of them.
	 *
	 * `from` is the other end, and is set on a reply whose opening reasoning got a row of its own
	 * just above: the prose row starts after it, so the same reasoning is not drawn twice. Both
	 * rows are the same message, which is why `lead` exists — the timestamp, the delivery card and
	 * the copy button belong to the reply, not to the reasoning in front of it.
	 *
	 * `turnStats` rides along for assistant rows. It used to be computed where the row is drawn,
	 * which meant a fresh object per render — so `MessageRow`'s memo compared unequal every time
	 * and every visible reply was rebuilt whenever anything re-rendered the transcript. Computed
	 * here it is derived from the messages alone, which is what it is a fact about, and its
	 * identity changes exactly when the transcript does.
	 *
	 * `closes` 标在一轮里最后一条落定的回复上：时间、耗时、复制那一行只属于它，见 `runs` 里的 `closer`。
	 *
	 * `newest` 标在转录最后一轮的 `closes` 上。会话还在跑时它只是「到目前为止」的最后一句：清单追问
	 * 之后模型可能接着干活、再说一段，页脚要等跑完才知道该落在谁身上，调用方据此先不画。
	 *
	 * `pauses` 标在一轮中间说完了的一句上：它说完时一条子代理的结果正好到了、被插进这一轮（`steered`），
	 * 这一轮于是没在它这里收尾。对读的人它和收尾那句一样是说完了的一段，所以也有时间和复制，只是没有
	 * 整轮的统计和交付卡片。
	 *
	 * `trailer` 是收尾那句的页脚单独成的一行，接在这一轮最后一行后面：收尾那句后面还跟着这一轮的活时
	 * （被停下的回复末尾那几个没执行的调用），页脚留在话底下，那几行就落到了「这一轮已经结束」的下面。
	 * 它和那句话是同一条消息、同一段（`from`..`upTo`），只画页脚和交付卡片，不画正文。
	 */
	| { kind: "message"; message: Message; index: number; upTo: number; from?: number; lead?: boolean; turnStats?: TurnStats; closes?: true; newest?: true; pauses?: true; trailer?: true; key?: string }
	/**
	 * A stretch of tool work, and whether it is the stretch being worked on right now.
	 *
	 * `live` is set on at most one run in the transcript — see `liveWork` for which. It is a fact
	 * about the shape of the conversation, not about whether the agent is currently running, so the
	 * caller still asks that separately: a run can be the newest work in a turn that has since ended.
	 */
	/*
	 * `shown` is a run of one: a page the agent put up for the reader with `preview`, or a suggested
	 * session waiting on the reader's Start (`spawn_session`). Either is for the reader rather than
	 * the turn's work, so it is never folded away with the work — see `turnBlocks`.
	 */
	| { kind: "tools"; calls: Call[]; live?: boolean; shown?: true };

/** 一条回复是谁答的。同一个模型名挂在两家服务商底下是两个模型，所以两样一起比。 */
export type ModelUsed = { provider: string; model: string };

/**
 * A split reply has two identities; neither identity changes when more text arrives.
 *
 * **每一种 `Run` 都要有分支。** 漏掉一种，它就落到最后一行去读一个根本不存在的 `message`：从前签名里
 * `Exclude` 掉的一种被调用处一个 `as` 塞了进来，那种会话一打开就整页白掉，报
 * `Cannot read properties of undefined (reading 'role')`。
 */
export function runKey(run: Run): string {
	if (run.kind === "command") return `command-${run.command.id}`;
	if (run.kind === "hiccup") return `hiccup-${run.hiccup.id}`;
	if (run.kind === "model") return `model-${run.at}`;
	if (run.kind === "tools") return `tools-${run.calls[0]?.block.id ?? "empty"}`;
	// 按第一次画出来时的时间戳：乐观的那条换成落盘的那条，行不该跟着卸掉重挂，见 `drawnAt`。
	return run.key ?? `${run.message.role}-${drawnAt(run.message)}-${run.index}`;
}

/**
 * The run of tool work being pushed forward right now, or -1 for none.
 *
 * Not "the last run in the transcript", which is what this used to be and is a different claim
 * entirely. The two agree for as long as a turn keeps calling tools, and part company the moment
 * you ask something else: the newest run is then a piece of finished work from the turn before,
 * and calling it current lit it back up — a line describing work that ended minutes ago, gliding
 * for the whole of a reply that never touched a tool.
 *
 * So it is answered from the replies rather than from the rows. Walking back from the newest one:
 *
 * - a reply that made calls is the answer, and the row those calls landed in is the run;
 * - a reply that has *said* something and made no calls ends the search — the answer is being
 *   written, and the work above it is over;
 * - a reply that has done neither yet is passed over, which is the beat between `message_start`
 *   and the first block of a new reply. Stopping there would drop the highlight for a few hundred
 *   milliseconds between every batch of a turn, which reads as a flicker rather than as an end;
 * - anything the person actually said ends the search. Their question is the boundary: whatever
 *   was done before it belongs to what they asked before it.
 *
 * Where the walk *starts* is what separates two transcripts that look identical — a person's
 * message at the end, a reply before it. If that reply is still `pending` the message is
 * steering typed into a turn that is running, and the work it is doing goes on; if it has settled,
 * the message is a new question and there is nothing in flight to point at.
 */
function liveWork(messages: Message[], live: number, rowOfCalls: Map<number, number>): number {
	if (live < 0) return -1;
	const latest = messages[live];
	const inFlight = latest.role === "assistant" && latest.stopReason === "pending";
	for (let at = inFlight ? live : messages.length - 1; at >= 0; at--) {
		const message = messages[at];
		if (message.role === "user") {
			// The runtime's own messages are not the person speaking; see `opensTurn`.
			if (!opensTurn(message)) continue;
			return -1;
		}
		// A tool result is the contents of a card, not a step of its own.
		if (message.role !== "assistant") continue;
		const row = rowOfCalls.get(at);
		if (row !== undefined) return row;
		if (spoken(message.content) > 0) return -1;
	}
	return -1;
}

/**
 * How many blocks at the front are reasoning — the thinking row's whole content.
 *
 * Counted from the front rather than "everything before the first call", which is the same answer
 * for a reply that thinks and then works and a different one for a reply that has already spoken:
 * the looser reading would put the prose in the thinking row as well as in the reply's own.
 */
function leadingThinking(content: AssistantContent[]): number {
	let count = 0;
	for (const block of content) {
		if (block.type !== "thinking") break;
		count++;
	}
	return count;
}

/**
 * Whether the opening reasoning has any words in it yet.
 *
 * A reply announces its reasoning block before the first token of it arrives, and a row for an
 * empty one is a margin with nothing in it — drawn under the work of a turn that is between
 * batches, then filled a moment later. Waiting costs nothing: the row appears at the bottom of
 * the transcript, where appearing pushes nothing down.
 */
function written(content: AssistantContent[], think: number): boolean {
	for (let at = 0; at < think; at++) {
		const block = content[at];
		if (block.type === "thinking" && block.thinking.length > 0) return true;
	}
	return false;
}

/**
 * Where the reply's trailing run of calls begins — everything before it is the reply's own row.
 *
 * Counted back from the end rather than forward from the last sentence. The two agree for the
 * common shape (think, speak, call) and part company when a model goes back to reasoning after
 * speaking: measured from the sentence, that closing reasoning fell outside every row and was
 * drawn nowhere at all.
 */
function beforeTrailingCalls(content: AssistantContent[]): number {
	let end = content.length;
	while (end > 0 && content[end - 1].type === "toolCall") end--;
	return end;
}

/**
 * How far into a reply the model was still addressing you.
 *
 * Counted to the end of the last block of actual text. Everything after it is the model working,
 * and work joins the work around it — the sentence that introduces a batch of calls and the calls
 * themselves are one thought, and the next batch continues it. Text is the one thing that ends a
 * run, because that is the model stopping to say something and a group must not swallow it.
 *
 * Whether the message is still streaming is deliberately not consulted. That answer changes
 * halfway through a turn, and any grouping derived from it changes with it.
 */
function spoken(content: AssistantContent[]): number {
	let end = 0;
	for (const [index, block] of content.entries()) {
		if (block.type === "text" && block.text.trim()) end = index + 1;
	}
	return end;
}

/**
 * Whether a drawn run has anything new to show — the memo comparison behind `ToolRun`.
 *
 * It lives here, in a file the tests can load, rather than inline in the component. That is not
 * tidiness: the rule this guards was verified twice against a *copy* of itself written into the
 * test, and a copy agrees with whatever it was copied from, including the mistakes. The component
 * cannot be imported by the unit tests at all (they strip types, they do not compile JSX), so the
 * only way for a test to check the real comparison is for the real comparison to be plain data.
 *
 * Structural on purpose: `runs` is a store type, and nothing in this file should know about the
 * store. Identity is all that is asked of it.
 *
 * Returns true when React may skip the render.
 */
export function sameRun(
	before: { calls: Call[]; live?: boolean; runs?: object; shown?: boolean },
	after: { calls: Call[]; live?: boolean; runs?: object; shown?: boolean },
): boolean {
	if (before.live !== after.live) return false;
	// A preview that failed stops being a page and joins the work, keeping its key — the one change here that leaves `calls` alone.
	if (before.shown !== after.shown) return false;
	// Injected records are rebuilt whenever their transcript grows, and a new map is the only sign
	// that a call in this group has finished — nothing there subscribes to them.
	if (before.runs !== after.runs) return false;
	if (before.calls.length !== after.calls.length) return false;
	return before.calls.every(
		(call, i) => call.block.id === after.calls[i].block.id && call.stopReason === after.calls[i].stopReason && samePage(call.page, after.calls[i].page),
	);
}

/**
 * A message list, as rows.
 *
 * Runs of tool calls are gathered across messages, not just inside one. A model that calls a tool,
 * reads the result and calls the next one produces a fresh assistant message every time, so grouping
 * within a message caught parallel batches and missed sequential ones — the common case. A message
 * carrying text ends the run, because that is the model saying something worth reading.
 *
 * 压缩不进转录：自动压缩归运行指示器，人自己敲的压缩命令是一条 `command`。
 */
export function runs(messages: Message[]): Exclude<Run, { kind: "command" } | { kind: "hiccup" }>[];
export function runs(messages: Message[], commands: CommandRun[], hiccups?: Hiccup[]): Run[];
export function runs(rawMessages: Message[], commands: CommandRun[] = [], hiccups: Hiccup[] = []): Run[] {
	const messages = intact(rawMessages);
	const out: Run[] = [];
	// Sorted so the marks can be consumed in order as the transcript is walked.
	const commandMarks = [...commands].sort((a, b) => a.at - b.at);
	let nextCommand = 0;
	/*
	 * 断线也是一个标记，和命令一样按位置插。
	 *
	 * 它们从前一律画在转录最下面、运行指示器底下，于是一轮跑四十分钟、中间断过两次又接上的那句
	 * 「重连 2 次后恢复」贴在最后一行 loading 下面——说的是某个时刻的事，站的却是「此刻」的位置。
	 * 断线是这段工作当中的一件事，就该待在它发生的那一段旁边。见 `lib/hiccup.ts` 的 `at`。
	 */
	const hiccupMarks = [...hiccups].sort((a, b) => a.at - b.at);
	let nextHiccup = 0;
	/** The reply being made, if one is: the last assistant message, whatever state it is in. */
	let live = -1;
	for (let at = messages.length - 1; at >= 0 && live < 0; at--) {
		if (messages[at].role === "assistant") live = at;
	}
	/**
	 * Which row each reply's calls ended up in.
	 *
	 * A run gathers calls from several replies, so "the row this reply is working in" is not
	 * something the rows can be asked afterwards — it is only known here, as they are placed.
	 * `liveWork` walks back through the replies and reads it off.
	 */
	const rowOfCalls = new Map<number, number>();

	/*
	 * A preview whose call failed showed nothing — the host refuses a page that throws — so it is work
	 * like any other call and folds with it. Still running counts as shown: it is about to be a page.
	 * A `check` is a page while it is waiting to be published and once it has been, and the call that
	 * publishes it is then one of the turn's steps — see `preview-pages.ts`. A check the turn ended
	 * without publishing is the model looking at its page, and folds with the work.
	 */
	const failed = new Set<string>();
	for (const message of messages) if (message.role === "toolResult" && message.isError) failed.add(message.toolCallId);
	const pages = previewPages(messages, (at) => opensTurn(messages[at]) && !resumesTurn(messages, at));
	const shows = (call: Call) => {
		// 建议另开的会话是等人点「开始」的卡片，折进过程就没人点了；参数被退回的没有卡片，照常是活。
		if (call.block.name === SPAWN_SESSION_TOOL) return !failed.has(call.block.id);
		if (call.block.name !== "preview" || failed.has(call.block.id)) return false;
		if (call.page) return !("publishing" in call.page);
		return call.block.arguments?.check !== true;
	};

	/** Extend the run this lands in, or start one. Empty batches leave the transcript alone. */
	const work = (calls: Call[], from: number) => {
		if (calls.length === 0) return;
		for (const call of calls) {
			const last = out[out.length - 1];
			if (shows(call)) out.push({ kind: "tools", calls: [call], shown: true });
			else if (last?.kind === "tools" && !last.shown) last.calls.push(call);
			else out.push({ kind: "tools", calls: [call] });
		}
		rowOfCalls.set(from, out.length - 1);
	};

	/*
	 * What the turn in progress has spent, carried down the transcript as it is walked.
	 *
	 * The same answer `computeTurnStats` gives — the same `saw` — arrived at in one pass instead of
	 * one backward scan per row. On a session of several thousand messages that difference is the
	 * whole cost: the scan was being run for every visible reply, on every render of the transcript.
	 */
	/*
	 * 上一条回复是哪个模型答的。换了就落一条分隔：换在两轮之间的，落在开这一轮的那句话上面——
	 * 人是先换模型再开口的；换在一轮当中的（跑着的时候换，下一步才生效），落在第一条新回复上面。
	 */
	let used: ModelUsed | null = null;
	const answeredBy = (message: AssistantMessage, at: number) => {
		const next = { provider: message.provider, model: message.model };
		if (used && (used.provider !== next.provider || used.model !== next.model)) out.push({ kind: "model", at, from: used, to: next });
		used = next;
	};

	/*
	 * 这一轮到目前为止最后一条落定的回复行，轮换了（或者走完了）才把 `closes` 落到它身上。
	 *
	 * 不看紧跟在后面的是不是「自动继续」那一句：运行时在正文后面插话续跑的不止那一种——清单没勾完
	 * 的追问（`openPlanNote`）用的是「（自动提示）」，英文界面下连「自动继续」的译文都对不上 core
	 * 写进去的中文。按前缀认，每加一种续跑都得记得来这里登记，漏一次就是一轮跑到一半先贴出页脚。
	 * 只问「这一轮最后一句是哪条」，插进来的是什么都无所谓。
	 */
	// 断言而不是标注：它只在闭包里被赋值，标注的话 TS 在循环里把它收窄成初值 `null`。
	let closer = null as Extract<Run, { kind: "message" }> | null;
	/*
	 * `ended`：这一轮确实收了尾。还在跑的那一轮（最新的回复还在写、或者刚交出调用）谁是最后一行还没定，
	 * 页脚留在原处——它跑着时本来就不画（`Run.newest`），先拆出一行只会是一行空的。
	 *
	 * 交回挂上 `closes` 的那一行，最后一轮要在它上面再标一个 `newest`。
	 */
	const closeTurn = (ended = true) => {
		let closing: Extract<Run, { kind: "message" }> | null = closer;
		if (closer && ended && spoke(closer) && out.slice(out.lastIndexOf(closer) + 1).some((run) => run.kind === "tools")) {
			const { message, index, upTo, from } = closer;
			// 页脚整个搬下去，话底下不留：一句中途的 `pauses` 也是页脚，留着就是同一轮两个。
			delete closer.pauses;
			// 账也记到这一轮最后，和页脚站的位置说同一件事：话后面那段活的时间在里面。
			closing = { kind: "message", message, index, upTo, from, turnStats: snapshot(clock), closes: true, trailer: true, key: `trailer-${drawnAt(message)}-${index}` };
			out.push(closing);
		} else if (closer) closer.closes = true;
		closer = null;
		return closing;
	};
	// 还在写的、说完要接着调工具的都不是一轮的最后一句；只开头推理的那一行也不是，页脚归后面的正文。
	const consider = (row: Extract<Run, { kind: "message" }>) => {
		const { message } = row;
		if (row.lead || message.role !== "assistant" || !settled(message.stopReason)) return;
		closer = row;
	};

	let clock = newClock();
	for (const [index, message] of messages.entries()) {
		/*
		 * A person speaking starts a new turn; the runtime's own messages continue the one running.
		 *
		 * 先于下面那几种标记换轮：上一轮的页脚可能要单独接在它最后一行后面（`closeTurn`），排到标记后面，
		 * 一条命令标记（`opensBlock`）就把它分进了下一块。
		 */
		if (opensTurn(message) && !resumesTurn(messages, index)) {
			closeTurn();
			clock = newClock(index, clock.openTodos);
		}
		// Commands are visible boundaries, including between an interrupted tool run and its resume.
		while (nextCommand < commandMarks.length && commandMarks[nextCommand].at <= index) {
			out.push({ kind: "command", command: commandMarks[nextCommand++] });
		}
		while (nextHiccup < hiccupMarks.length && hiccupMarks[nextHiccup].at <= index) {
			out.push({ kind: "hiccup", hiccup: hiccupMarks[nextHiccup++] });
		}

		/*
		 * 每一条都记进表里，包括下面那两种画不出行的。
		 *
		 * 它们不出现在转录上，可是它们占的时间是真的：一条工具结果背后是一次四分钟的子代理，一句
		 * 「自动继续」后面是模型接着往下干。这一句要排在下面所有 `continue` 前面——从前那些 continue
		 * 是纯粹的渲染决定，把统计一起跳过去，正是时间丢掉的地方。
		 */
		saw(clock, message);

		/*
		 * Tool results are not entries in the transcript; they are the contents of a card.
		 *
		 * This is what kept the runs from ever forming. Every call is answered by a `toolResult`
		 * message, and treating those as ordinary messages put one between every pair of calls —
		 * so a run of seven arrived as seven runs of one. They render nothing on their own, so
		 * passing over them changes only the grouping.
		 */
		if (message.role === "toolResult") continue;

		/*
		 * The runtime talking to the model is invisible, including the fact that it happened —
		 * so it must not divide what it sits between. The work either side of a nudge is one
		 * continuous stretch, and a row drawn through the middle of it would break the run in
		 * two at a line nobody can see.
		 */
		/*
		 * 送回来的结果和另一个会话的消息要画出来。把空闲的会话叫醒的那种是一道缝：不画，读的人看到的
		 * 是主智能体说完一段话、隔了几分钟又自己动了起来。插在一轮中间的那种只是这段工作里的一步，
		 * 见 `turnBlocks`。
		 */
		if (message.role === "user" && message.synthetic && !message.delivery && !message.peer) continue;

		/*
		 * 回答之后补勾清单的那一次 todo_write 不画：回答和它的页脚已经是这一轮的结尾，再在下面画一行
		 * 工作，读起来像回答完又动手干了点什么。勾的结果清单面板上看得到。时间上面 `saw` 已经记了。
		 */
		if (message.role === "assistant" && isPlanTick(messages, index)) continue;

		if (message.role !== "assistant") {
			if (opensTurn(message)) {
				// 这一轮的第一条回复。下一句人话先到说明这句没得到回答，那就不归它管。
				for (let ahead = index + 1; ahead < messages.length; ahead++) {
					const next = messages[ahead];
					if (next.role === "assistant") answeredBy(next, index);
					if (next.role === "assistant" || opensTurn(next)) break;
				}
			}
			// 插进一轮中间的送达紧挨着一句说完了的话：那句话就是一段的结尾。
			if (message.role === "user" && message.delivery && !(opensTurn(message) && !resumesTurn(messages, index))) {
				if (closer && out[out.length - 1] === closer && spoke(closer)) closer.pauses = true;
			}
			out.push({ kind: "message", message, index, upTo: message.content.length });
			continue;
		}

		answeredBy(message, index);
		const think = leadingThinking(message.content);
		const own = beforeTrailingCalls(message.content);
		const calls: Call[] = [];
		for (const block of message.content.slice(own)) {
			// 经 `mcp_call` 转手的按真正那个工具排、画：一次 preview 照样是一页，不是折进工作里的一行。
			if (block.type === "toolCall") calls.push({ block: routedBlock(block), stopReason: message.stopReason, page: pages.get(block.id) });
		}

		/*
		 * The reasoning that opens a reply gets a row of its own, where it was written.
		 *
		 * One row per stretch of reasoning, in the order the model produced it, so a turn reads
		 * think, work, think, work — the shape it actually ran in. This used to be a single row
		 * for the whole turn, holding only the newest reasoning and pinned above the work: every
		 * thought a turn had before its last one was never drawn at all, which on a long turn is
		 * nearly all of them.
		 *
		 * Pushing it here is also what keeps the work below from swallowing it. `work` only ever
		 * extends a run that is still the last row, so a reasoning row landing between two batches
		 * is exactly what ends the first and starts the second.
		 */
		if (think > 0 && written(message.content, think)) {
			const row: Extract<Run, { kind: "message" }> = {
				kind: "message", message, index, upTo: think,
				/*
				 * A lead-in only when the reply has a row of its own below this one.
				 *
				 * Otherwise this row is the whole message, and what belongs to the message —
				 * a failure, the delivery card — belongs to it. A dropped connection during the
				 * reasoning is exactly that case, and it is the one where the failure has to show.
				 */
				lead: own > think || undefined,
				// Its own identity, distinct from the prose row of the same message. See `runKey`.
				key: `thinking-${message.timestamp}-${index}`,
			};
			out.push(row);
			consider(row);
		}

		/*
		 * A page made before the reply's last words gets its row all the same.
		 *
		 * A call followed by more reasoning is not trailing, so it stays in the reply's own row — and a
		 * row of nothing else but reasoning is process (`thinkingOnly`), so the page was drawn inside it
		 * and folded away with it. Cut out here, it is the same row it was while it was the last block
		 * (`tools-<id>`), so the reasoning arriving after it does not move it into another row and load
		 * the page a second time. The pieces in front of it lead into the reply, which is the last piece.
		 */
		let from = think;
		for (let at = think; at < own; at++) {
			const block = message.content[at];
			if (block.type !== "toolCall") continue;
			const call: Call = { block: routedBlock(block), stopReason: message.stopReason, page: pages.get(block.id) };
			if (!shows(call)) continue;
			if (at > from) out.push({ kind: "message", message, index, upTo: at, from, lead: true, key: `part-${at}-${message.timestamp}-${index}` });
			work([call], index);
			from = at + 1;
		}
		// `own` never ends on a call, so the reply keeps a piece of its own after the last page.
		if (own > from) {
			const row: Extract<Run, { kind: "message" }> = { kind: "message", message, index, upTo: own, from, turnStats: snapshot(clock) };
			out.push(row);
			consider(row);
		} else if (think === 0 && calls.length === 0 && message.stopReason !== "pending") {
			/*
			 * Nothing thought, nothing said, nothing done, and the turn is over: a failure with no
			 * output. This message's only chance to show it, so it gets a row.
			 */
			const row: Extract<Run, { kind: "message" }> = { kind: "message", message, index, upTo: message.content.length, turnStats: snapshot(clock) };
			out.push(row);
			consider(row);
		}

		work(calls, index);
	}

	const latest = messages[live];
	const newest = closeTurn(!(latest?.role === "assistant" && !settled(latest.stopReason)));
	if (newest) newest.newest = true;

	while (nextCommand < commandMarks.length) out.push({ kind: "command", command: commandMarks[nextCommand++] });
	// 还在等的那一条数出来正好落在这里——它确实正在此刻发生，末尾就是它的位置。
	while (nextHiccup < hiccupMarks.length) out.push({ kind: "hiccup", hiccup: hiccupMarks[nextHiccup++] });

	/*
	 * Which run is being pushed forward, answered once the whole transcript is known.
	 *
	 * Rows are only ever appended by the walk above — nothing is inserted after the fact any more —
	 * so the indices `work` recorded still point where they did.
	 */
	const working = liveWork(messages, live, rowOfCalls);

	if (working >= 0) {
		const row = out[working];
		if (row.kind === "tools") row.live = true;
	}
	return out;
}

/** 这一行有话：时间和复制那一行只挂在有话的回复下面（`rows.tsx` 的 `text.trim()`）。 */
function spoke(run: Extract<Run, { kind: "message" }>): boolean {
	return run.message.content.slice(run.from ?? 0, run.upTo).some((block) => block.type === "text" && block.text.trim() !== "");
}
