/**
 * What the window knows about the work this session has delegated.
 *
 * Two halves, kept apart on purpose. The roster — who is running, how long, how many tool calls —
 * arrives as an event on every change, because it is a dozen small rows and the whole point is
 * that it is live. The transcripts are pulled per sub-agent and then kept up to date by the
 * messages that stream in, because a delegated run can read forty files and broadcasting all of
 * that on every change would put the run on the wire dozens of times over.
 *
 * Rosters are kept by session id: a sub-agent belongs to the conversation that dispatched it, and
 * with two screens the other conversation is on display too, so a screen reads its own through
 * `useScopedSubAgents`. The opened transcripts are keyed by nothing and belong to the conversation in
 * the live slot; when that changes they are emptied.
 */

import { create } from "zustand";
import type { HookRun, Message, SubAgentSummary } from "@plume/core";
import { freshTokens } from "@plume/core/tokens";
import { bridge } from "../services/index.ts";

export interface SubAgentState {
	/** Transcripts, by sub-agent id, for the ones that have been opened. */
	transcripts: Record<string, Message[]>;
	/** 它们跑过的钩子，和转录同进同出：打开时一起读，之后跟着事件补。 */
	hookRuns: Record<string, HookRun[]>;
	/** Which one the pane is showing, or null for none open yet. */
	focused: string | null;
	/**
	 * Ids whose transcript has been asked for but not yet arrived.
	 *
	 * Held so a second click while the first read is in flight does not ask again, and so the pane
	 * can say "loading" rather than "empty" — which for a sub-agent that has genuinely said nothing
	 * yet are two different and equally believable states.
	 */
	loading: string[];
	/**
	 * The last roster each conversation broadcast, by session id, oldest first — the order a tab strip
	 * reads in.
	 *
	 * Re-sent on every tool call of every sub-agent, so nothing derived from it may move what the
	 * pane is showing: jumping to the newest one because a *sibling* made a tool call would make
	 * reading a long run impossible. `focused` is set only by a person.
	 */
	rosters: Record<string, SubAgentSummary[]>;

	/**
	 * Take the roster the session in the live slot just broadcast, or just read back.
	 *
	 * `live`：这份名单是运行时刚广播出来的，而不是切回会话时从磁盘读回来的。只有前者能说「刚派了活」
	 * （见 `announced`）。
	 */
	sync(agents: SubAgentSummary[], sessionId: string, live?: boolean): void;
	/** Keep the roster a conversation that is not in the live slot just broadcast. */
	retain(sessionId: string, agents: SubAgentSummary[]): void;
	/** One message, as the sub-agent writes it. Ignored for a transcript nobody has opened. */
	append(id: string, message: Message): void;
	/** One hook run, started or settled. Ignored for a transcript nobody has opened, like `append`. */
	hookRun(id: string, run: HookRun): void;
	focus(id: string | null): void;
	/**
	 * 有人要看某一个——在对话里点了它的派发卡片。
	 *
	 * 翻到它那一页之外，还要把面板打开；而打开面板是 dock 的事，对话那一侧够不着它（从对话里
	 * 直接引 dock，会在依赖图上绕出一个新的环）。所以这里只记下「谁、在哪个会话里、什么时候」，
	 * 由输入框上方那条状态条——它本来就负责在派活时把面板打开——看到之后去开。
	 */
	revealed: { id: string; sessionId: string | null; at: number } | null;
	reveal(id: string, sessionId: string | null): void;
	/**
	 * 某个会话刚派出了新的子智能体，面板该打开了。
	 *
	 * 只看实时广播里冒出来的、这个会话从没登记过的 id。从前是输入框上方那条自己数「在跑的变多了」，
	 * 而切会话时实时名单先被清空、再异步读回来——读回来那一下也是「变多了」，于是每次切回一个子智能体
	 * 还在跑的会话，人在侧边面板里停着的那一页都被翻到子 Agent。读回来的名单不是派发，不算。
	 */
	announced: { sessionId: string } | null;
	/** Read one sub-agent's transcript. Idempotent while a read is in flight. */
	load(sessionId: string, id: string): Promise<void>;
	/** A different conversation is in front of you: the transcripts opened for this one go. Rosters stay, by session. */
	clear(): void;
}

export const useSubAgents = create<SubAgentState>((set, get) => ({
	transcripts: {},
	hookRuns: {},
	focused: null,
	loading: [],
	rosters: {},
	revealed: null,
	announced: null,

	reveal(id, sessionId) {
		set({ focused: id, revealed: { id, sessionId, at: Date.now() } });
	},

	retain(sessionId, agents) {
		set({ rosters: { ...get().rosters, [sessionId]: agents } });
	},

	sync(agents, sessionId, live) {
		const known = new Set(get().rosters[sessionId]?.map((one) => one.id) ?? []);
		const fresh = live === true && agents.some((one) => isActive(one) && !known.has(one.id));
		set({
			// 每次一个新对象：听的那一头按引用认「又派了一次」，同一毫秒里的两次也分得开。
			...(fresh ? { announced: { sessionId } } : {}),
			rosters: { ...get().rosters, [sessionId]: agents },
		});
	},

	append(id, message) {
		const existing = get().transcripts[id];
		// Nothing has been opened for this one, so there is no list to keep in step. Opening it
		// later reads the whole thing, including this.
		if (!existing) return;
		/*
		 * Already read by `load`, and only now announced.
		 *
		 * The main process records a message, writes it to disk, and only then broadcasts it; a read
		 * landing in that gap carries the message, and the broadcast arriving after it showed the same
		 * bubble twice. Compared by value because both copies crossed IPC and share no identity.
		 */
		if (existing.some((one) => sameMessage(one, message))) return;
		set({ transcripts: { ...get().transcripts, [id]: [...existing, message] } });
	},

	hookRun(id, run) {
		if (!get().transcripts[id]) return;
		set({ hookRuns: { ...get().hookRuns, [id]: upsert(get().hookRuns[id] ?? [], run) } });
	},

	focus(id) {
		set({ focused: id });
	},

	async load(sessionId, id) {
		const { transcripts, loading } = get();
		if (transcripts[id] || loading.includes(id)) return;
		set({ loading: [...loading, id] });
		try {
			const detail = await bridge.subAgents.detail(sessionId, id);
			/*
			 * Merged, not replaced.
			 *
			 * Messages can stream in while the read is in flight, and `append` drops them because
			 * there is no list yet. Taking whichever is longer is enough: both are prefixes of the
			 * same transcript, and the read is the one that started earlier.
			 */
			const arrived = detail?.messages ?? [];
			const since = get().transcripts[id] ?? [];
			// 读的时候到了的那几条钩子更新，压在读回来的那份上面。
			const runs = (get().hookRuns[id] ?? []).reduce(upsert, detail?.hookRuns ?? []);
			set({
				transcripts: { ...get().transcripts, [id]: arrived.length >= since.length ? arrived : since },
				hookRuns: { ...get().hookRuns, [id]: runs },
			});
		} finally {
			set({ loading: get().loading.filter((each) => each !== id) });
		}
	},

	clear() {
		set({ transcripts: {}, hookRuns: {}, focused: null, loading: [] });
	},
}));

/** 同一条钩子先报开始、再报结局，按 id 换掉；两次的位置运行时盖的是同一个（`SubAgentRegistry.hookRun`）。 */
function upsert(runs: readonly HookRun[], run: HookRun): HookRun[] {
	const at = runs.findIndex((known) => known.id === run.id);
	return at < 0 ? [...runs, run] : runs.map((known, index) => (index === at ? run : known));
}

/** Role and timestamp first: cheap, and they rule out almost every pair before the full comparison. */
function sameMessage(a: Message, b: Message): boolean {
	return a.role === b.role && a.timestamp === b.timestamp && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Running first, then the ones queued behind the gate, then the finished ones — which is the order
 * they are worth reading in.
 */
export function rosterOrder(agents: SubAgentSummary[]): SubAgentSummary[] {
	const rank = (one: SubAgentSummary) => (one.status === "running" ? 0 : one.status === "queued" ? 1 : 2);
	return [...agents].sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt);
}

/** 还没完：在跑，或者在闸门后面排着。 */
export function isActive(one: Pick<SubAgentSummary, "status">): boolean {
	return one.status === "running" || one.status === "queued";
}

/**
 * 这个会话派出去的还有没交差的。
 *
 * 子代理派出即放手（`detached-dispatches.ts`）：派完那一轮当场收尾，活其实才开始，结果回来还会再开
 * 一轮。只看主回合，会话行在它们跑的那十几分钟里不是「已完成」就是什么都没有。
 */
export function delegating(roster: readonly SubAgentSummary[] | undefined): boolean {
	return roster?.some(isActive) ?? false;
}

/** What a sub-agent has spent, in the two numbers a person reads: tokens, and dollars when priced. */
export interface RosterFigures {
	tokens: number;
	/** 0 when the model has no pricing — which is "unknown", and is shown as nothing rather than as free. */
	cost: number;
}

/**
 * Fresh tokens, matching the session card and the usage page — see `freshTokens`.
 *
 * A sub-agent is dispatched precisely when the work is too big for the main thread, so it runs the
 * longest tool loops in the app and re-reads its context the most. Reporting `usage.total` here
 * made every roster row read as though delegating were ruinously expensive, when most of what it
 * counted was the same context being read back at a tenth of the rate.
 */
export function figuresOf(agent: SubAgentSummary): RosterFigures {
	return { tokens: agent.usage ? freshTokens(agent.usage) : 0, cost: agent.usage?.cost.total ?? 0 };
}
