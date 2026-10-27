/**
 * Which conversation a mounted pane is drawing.
 *
 * The app store still has one live transcript slot. A split window mounts more than one
 * conversation, so each pane names the session it is responsible for. The focused pane reads
 * the live fields; the others read the cache that `openSession` parks on the way out.
 *
 * `undefined` means "not inside a pane" — Composer on the empty state, the skeleton — and
 * falls back to the store's active id. `null` is the blank conversation that has not been sent.
 *
 * A pane reads the live fields only when its conversation is the one in the live slot — the blank
 * one included. A split can show a blank screen while a conversation beside it holds the slot, and
 * that screen reading the live fields drew the other conversation's state: its running turn, its
 * stop button, its project.
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Message, SessionMeta, SubAgentSummary } from "@plume/core";
import { isProjectLess } from "../lib/project-scope.ts";
import { sessionProject } from "../lib/project-identity.ts";
import { useApp, type AppState } from "../store/index.ts";
import { delegating, type SubAgentState, useSubAgents } from "../store/subAgents.ts";
import { unreadWorkspace, worktreeWorkspace } from "../store/session-workspace.ts";
import { EMPTY_SLOT, type Cache, type CachedSessionState } from "../store/derive.ts";
import type { ToolRun } from "../store/tool-run.ts";

export const SessionScope = createContext<string | null | undefined>(undefined);

/**
 * Which screen's dock a pane is drawn in: that screen's key — its session id, or `@draft`.
 *
 * Null outside any screen, which is a panel window: it holds one panel and is that panel. Kept here
 * beside `SessionScope` rather than in the dock so a panel can ask without importing the dock.
 */
export const DockScope = createContext<string | null>(null);

export function useDockScope(): string | null {
	return useContext(DockScope);
}

/**
 * 正在画的这一格是哪个 kind。
 *
 * 大多数面板一种只有一格，知道自己是什么就够了。侧边聊天一个会话可以开好几格，面板正文、头上的
 * 按钮得知道自己是其中哪一个——dock 的 `renderPanel` 这些在画的时候把 kind 放进来，见 `lib/panel-instance.ts`。
 * 和 `DockScope` 一样放在这里，面板问它不用去引 dock。
 */
export const PanelKindScope = createContext<string | null>(null);

export function usePanelKind(): string | null {
	return useContext(PanelKindScope);
}

/**
 * Put a screen's conversation in the live slot — what pressing anywhere on that screen does.
 *
 * Registered by the split workspace, which owns the screens; a window without one shows a single
 * conversation that is live already. Kept here beside `SessionScope` so a composer can ask without
 * importing the split, which draws the composer and would close a loop.
 */
let focusScreen: ((sessionId: string | null) => void) | null = null;

export function provideScreenFocus(focus: ((sessionId: string | null) => void) | null): void {
	focusScreen = focus;
}

/** For the keyboard, which reaches a screen's controls without the press that would have focused it. */
export function focusScreenOf(sessionId: string | null): void {
	focusScreen?.(sessionId);
}

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_TOOLS: Record<string, ToolRun> = {};
const EMPTY_AGENTS: SubAgentSummary[] = [];

/** A screen's parked copy — none for a blank screen away from the live slot, which has said nothing yet. */
function parked(s: AppState, id: string | null): Cache[string] | undefined {
	return id === null ? undefined : s.sessionCache[id];
}

export function useScopedSessionId(): string | null {
	const scoped = useContext(SessionScope);
	const active = useApp((s) => s.activeSessionId);
	return scoped === undefined ? active : scoped;
}

/** 这一屏的转录，不订阅。给只在自己的节拍上取样的地方用，见 `useProducedChars`。 */
export function scopedMessages(s: AppState, id: string | null): Message[] {
	return id === s.activeSessionId ? s.messages : (parked(s, id)?.messages ?? EMPTY_MESSAGES);
}

export function useScopedMessages(): Message[] {
	const id = useScopedSessionId();
	return useApp((s) => scopedMessages(s, id));
}

/**
 * One fact read off this screen's transcript, redrawing only when the fact changes.
 *
 * For a row that needs something about the whole transcript — which message was said last — and
 * would otherwise redraw on every streamed token by holding the list itself.
 */
export function useScopedFromMessages<T>(read: (messages: Message[]) => T): T {
	const id = useScopedSessionId();
	return useApp((s) => read(scopedMessages(s, id)));
}

/**
 * 这一屏里人说过的那几条（用户消息），按原对象给。
 *
 * 流式输出时变的只有助手那一条，别的消息对象原样留着，逐个比下来这份名单不动——输入历史拿它，
 * 输入框就不跟着每个 token 整个重画。
 */
export function useScopedUserMessages(): Message[] {
	const id = useScopedSessionId();
	return useApp(useShallow((s) => scopedMessages(s, id).filter((message) => message.role === "user")));
}

export function useScopedRunning(): boolean {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return s.running;
		return parked(s, id)?.state?.running ?? (id !== null && s.activity[id] === "running");
	});
}

/**
 * 这场对话此刻有没有活在干：主会话这一轮在跑，或者它放到后台的子智能体还没跑完。
 *
 * 清单和「接着做」那一行看这个，而不是 `useScopedRunning`。子智能体派出即放手，派完那一轮主会话
 * 就收尾了——可活并没有停：后台那几个跑完，结果会送回来，主会话接着干。那时候清单说「停在
 * 这一步」、再给一个 ▶，是请人把一件本来就在进行的事再启动一遍（按下去还会让它重派一遍）。
 *
 * 输入框不看这个：它问的是「现在说话会不会插进一轮」，而后台的子智能体不占着主会话。
 */
export function useScopedWorking(): boolean {
	const id = useScopedSessionId();
	const running = useScopedRunning();
	const background = useScopedFromSubAgents(delegating);
	/*
	 * 最后一个子智能体交差、送达还没开出下一轮的那一下也算在干：core 把结果攒 400ms 再开一轮
	 * （`DELIVERY_GATHER_MS`），这段空档里主回合和名册都是空闲的，交付卡片、「继续」会闪出来又收回去。
	 * core 的 `idle` 算着这段，可它不到界面，所以这里按那个数留余量。没有送达（刚按了停止）只是晚
	 * 这么一会儿才显示，不会卡住。在渲染里比对上一次，不放进 effect：effect 晚一帧，那一帧就是闪的那一下。
	 */
	const [seen, setSeen] = useState({ id, background });
	const [settling, setSettling] = useState(false);
	if (seen.id !== id || seen.background !== background) {
		setSeen({ id, background });
		setSettling(seen.id === id && seen.background && !background);
	}
	useEffect(() => {
		if (!settling) return;
		const timer = setTimeout(() => setSettling(false), DELIVERY_SETTLE_MS);
		return () => clearTimeout(timer);
	}, [settling]);
	return running || background || settling;
}

/** 见 `useScopedWorking`：core 攒送达的 400ms，加上开轮、事件过 IPC 的余量。 */
const DELIVERY_SETTLE_MS = 1000;

/** 这一屏这一轮的一样状态：屏上那个读顶层，别的读它停在缓存里的那份，没有就是空的。 */
function useScopedSlot<K extends keyof CachedSessionState>(key: K): CachedSessionState[K] {
	const id = useScopedSessionId();
	return useApp((s) => (id === s.activeSessionId ? s[key] : (parked(s, id)?.state?.[key] ?? EMPTY_SLOT[key])));
}

export const useScopedStopped = () => useScopedSlot("stopped");
export const useScopedTodos = () => useScopedSlot("todos");
export const useScopedApprovals = (): AppState["approvals"] => useScopedSlot("approvals");
export const useScopedCompactions = () => useScopedSlot("compactions");
export const useScopedCommandRuns = () => useScopedSlot("commandRuns");
export const useScopedHookRuns = () => useScopedSlot("hookRuns");
export const useScopedHiccups = () => useScopedSlot("hiccups");

export function useScopedToolRuns(): Record<string, ToolRun> {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return s.toolRuns;
		return parked(s, id)?.toolRuns ?? EMPTY_TOOLS;
	});
}

/** One fact read off this screen's tool runs, redrawing only when the fact changes — see `useScopedFromMessages`. */
export function useScopedFromToolRuns<T>(read: (runs: Record<string, ToolRun>) => T): T {
	const id = useScopedSessionId();
	return useApp((s) => read(id === s.activeSessionId ? s.toolRuns : (parked(s, id)?.toolRuns ?? EMPTY_TOOLS)));
}

/**
 * This screen's turn meter: when its turn began, and what it has spent so far.
 *
 * `turnStartedAt` and `turnTokens` mirror `turns[activeSessionId]` — the live slot's. A conversation
 * running beside it keeps its own meter in `turns`; read from the pair, its running line showed the
 * focused conversation's clock and count.
 */
export function useScopedTurnMeter(): { startedAt: number | null; tokens: number } {
	const id = useScopedSessionId();
	const startedAt = useApp((s) => (id === s.activeSessionId ? s.turnStartedAt : id === null ? null : (s.turns[id]?.startedAt ?? null)));
	const tokens = useApp((s) => (id === s.activeSessionId ? s.turnTokens : id === null ? 0 : (s.turns[id]?.tokens ?? 0)));
	return { startedAt, tokens };
}

/** Whether this screen's turn is waiting out a dropped connection. */
export const useScopedRetrying = () => useScopedSlot("retrying");

/** When this screen's history was last summarised, for the running line's passing mention of it. */
export const useScopedCompactedAt = () => useScopedSlot("compactedAt");

export function useScopedMeta(): SessionMeta | null {
	return useScopedFromMeta(whole);
}

const whole = <T,>(value: T) => value;

/**
 * 元数据里的一样东西，变了才重画。
 *
 * 元数据每写一条记录就换一个新对象（`seq`、`updatedAt` 跟着走），一次并行工具就是十几次。转录里
 * 每一行都要的只是其中不变的一两样（`cwd`、是不是侧边聊天），拿整个对象就是每写一条记录，可见的
 * 每一段活、每一句回复都重画一遍——会话越长越贵。行里一律用这个，别用 `useScopedMeta`。
 */
export function useScopedFromMeta<T>(read: (meta: SessionMeta | null) => T): T {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return read(s.meta);
		return read(parked(s, id)?.meta ?? (id === null ? null : (s.sessions.find((session) => session.id === id) ?? null)));
	});
}

export function useScopedLoading(): boolean {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (!id) return false;
		if (s.activeSessionId === id) return s.loadingSession;
		const cached = s.sessionCache[id] as Cache[string] | undefined;
		return !cached;
	});
}

/**
 * This conversation's sub-agents: the live roster when it is the live conversation, and the last one
 * it broadcast otherwise — a second screen shows its own delegated work, not the focused one's.
 */
export function useScopedSubAgents(): SubAgentSummary[] {
	return useScopedFromSubAgents(whole);
}

/** 这一屏的子智能体，不订阅。 */
export function scopedSubAgents(state: SubAgentState, id: string | null): SubAgentSummary[] {
	return (id ? state.rosters[id] : undefined) ?? EMPTY_AGENTS;
}

/** 子智能体里的一样东西，变了才重画——见 `useScopedFromMessages`。名册随每个子智能体的进度换新。 */
function useScopedFromSubAgents<T>(read: (agents: SubAgentSummary[]) => T): T {
	const id = useScopedSessionId();
	return useSubAgents((s) => read(scopedSubAgents(s, id)));
}

/**
 * The project this screen's conversation works in, as its path — null for one in no project.
 *
 * The same answer `useScopedWorkspace` gives as `workspace.path`, for the many small readers that
 * need only the path: every relative link in a transcript resolves against it, and one subscription
 * each is what a long transcript can afford where a dozen is not.
 */
export function useScopedProjectPath(): string | null {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) {
			/*
			 * `workspace` is read back after the switch (`openSession`), and until then it is the project
			 * left behind, or null. The transcript paints first: `apps/web/a.ts` in inline code showed as
			 * the bare path, then turned into a file chip once the project arrived. Its path is the
			 * conversation's own directory anyway, so take that until the two agree.
			 */
			const cwd = s.meta?.id === id ? s.meta.cwd : null;
			if (cwd === null || s.workspace?.path === cwd) return s.workspace?.path ?? null;
			return isProjectLess(cwd, s.scratchRoots) ? null : cwd;
		}
		if (id === null) return s.parkedDraft?.workspace?.path ?? null;
		const cwd = (s.sessionCache[id]?.meta ?? s.sessions.find((one) => one.id === id))?.cwd ?? null;
		return cwd !== null && !isProjectLess(cwd, s.scratchRoots) ? cwd : null;
	});
}

const NO_WORKSPACE: { workspace: AppState["workspace"]; scratchCwd: string | null } = { workspace: null, scratchCwd: null };

/**
 * Where this screen's conversation runs: its own project, not the one that has focus.
 *
 * `workspace` and `scratchCwd` describe the live slot. Another conversation's screen takes its
 * project from that conversation's directory, split into project and project-less the way
 * `openSession` splits it, and named from what the project was when it last held the live slot — or
 * read once, for one that never did. A blank screen away from the live slot runs where it was parked.
 */
export function useScopedWorkspace(): { workspace: AppState["workspace"]; scratchCwd: string | null } {
	const id = useScopedSessionId();
	const live = useApp((s) => id === s.activeSessionId);
	const workspace = useApp((s) => s.workspace);
	const scratchCwd = useApp((s) => s.scratchCwd);
	const draft = useApp((s) => (id === null ? s.parkedDraft : null));
	const meta = useApp((s) => (id === null ? null : (s.sessionCache[id]?.meta ?? s.sessions.find((one) => one.id === id) ?? null)));
	const cwd = meta?.cwd ?? null;
	const projectLess = useApp((s) => cwd !== null && isProjectLess(cwd, s.scratchRoots));
	const known = useApp((s) => (cwd === null ? undefined : s.workspaceByPath[cwd]));
	// The conversation's project, not its folder's: two projects can share one. An entry of the list, so a stable reference.
	const project = useApp((s) => (meta === null ? undefined : sessionProject(s.settings?.projects ?? [], meta)));
	const describe = useApp((s) => s.describeWorkspace);
	// A conversation's own worktree is named for its project here too, as in the live slot (`sessionWorkspace`).
	const worktreeOf = meta?.worktree?.project;
	const asWorktree = useMemo(() => (known && worktreeOf ? worktreeWorkspace(known, worktreeOf) : known), [known, worktreeOf]);
	const projectName = meta?.projectName;
	const scoped = useMemo(() => {
		if (cwd === null) return null;
		// Named at once from the conversation; the branch arrives with the read.
		const base = asWorktree ?? unreadWorkspace(cwd, projectName ?? cwd, worktreeOf);
		return project ? { ...base, name: project.name, projectId: project.id } : base;
	}, [asWorktree, cwd, projectName, worktreeOf, project]);
	const unread = !live && cwd !== null && !projectLess && !known;
	useEffect(() => {
		if (unread && cwd) void describe(cwd);
	}, [unread, cwd, describe]);
	if (live) return { workspace, scratchCwd };
	if (id === null) return draft ?? NO_WORKSPACE;
	if (cwd === null) return NO_WORKSPACE;
	if (projectLess) return { workspace: null, scratchCwd: cwd };
	return { workspace: scoped, scratchCwd: null };
}
