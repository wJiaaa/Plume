/**
 * Conversations as a list: starting, opening, forking, moving, archiving, summarising.
 *
 * Running one — prompting, approving, stopping — is `agent.ts`.
 */

import type {
	CompactCode,
	ContextBreakdown,
	McpServerStatus,
	MessageAttachment,
	NoticeParams,
	Plugin,
	SessionMeta,
	Skill,
	SpawnedFrom,
	TrajectoryChanges,
	TrajectoryEntry,
	UserContent,
} from "@plume/core/contract-types";
import type { SessionChange, SessionSnapshot } from "./session.ts";

export interface StoredSummary {
	text: string;
	/** 已经概括进去的最后一条消息的 `timestamp`。 */
	upto: number;
	updatedAt: number;
}

export type SummarizeResult = { summary: StoredSummary | null; error?: string };

/** 推给窗口的那一份：后台开始生成时 `pending` 为真，生成完带着结果再推一次。 */
export type SummaryUpdate = { sessionId: string; pending: boolean; summary?: StoredSummary | null; error?: string };

export interface AgentCapabilities {
	skills: Skill[];
	skillDiagnostics: { path: string; message: string }[];
	plugins: Plugin[];
	pluginDiagnostics: { path: string; message: string }[];
	mcp: McpServerStatus[];
	agents: { name: string; description: string; source: string; tools: string[] | "*"; model?: string | string[]; avatar?: string }[];
	toolNames: string[];
}

export interface SessionsApi {
	onChanged(handler: (change: SessionChange) => void): () => void;
	/** 后台生成摘要开始和结束时各推一次（一轮结束、静下来一分钟后）。 */
	onSummaryChanged(handler: (update: SummaryUpdate) => void): () => void;
	list(): Promise<SessionMeta[]>;
	/**
	 * `initial.worktree`: this conversation in a worktree of its own, or not; absent follows the setting.
	 * `initial.spawnedFrom`: the suggestion card it was started from (`SessionMeta.spawnedFrom`).
	 * `initial.title`: its name in the list, instead of one cut from the first message.
	 */
	/** `project` is the project it is started in (`SessionMeta.project`); absent files it by its folder. */
	create(cwd: string, modelId: string, initial?: { content: UserContent[]; synthetic?: boolean; displayText?: string; skillRef?: { name: string; path?: string; pluginId?: string }; sessionRefs?: Array<{ id: string; title: string }>; attachments?: MessageAttachment[]; planMode?: boolean; worktree?: boolean; spawnedFrom?: SpawnedFrom; title?: string; project?: string }): Promise<SessionSnapshot>;
	/**
	 * 这个会话此刻在不在跑，问主进程要权威答案。
	 *
	 * 渲染层自己那份 `running` 是事件推出来的，丢一条就永久卡住。见 `ipc/sessions.ts` 里这个
	 * handler 的注释。
	 */
	running(sessionId: string): Promise<boolean>;
	/** Read the stored transcript without starting anything. For looking at things. */
	transcript(sessionId: string): Promise<SessionSnapshot | null>;
	/** The same log, read as a trajectory: one entry per thing that happened, by source. Only e2e calls it. */
	trajectory(sessionId: string): Promise<TrajectoryEntry[]>;
	trajectoryChanges(sessionId: string, cursor?: string): Promise<TrajectoryChanges>;
	/** Write the session out to a temporary file and return its path. `jsonl` is the raw records. */
	exportTrajectory(sessionId: string, format: "json" | "md" | "output" | "jsonl", selection?: { id?: string; correlationId?: string }): Promise<string>;
	/**
	 * Fork from just before a message the person wrote: everything before it in a new session, this
	 * one untouched. `messageIndex` is its place in the transcript the window shows, checked against
	 * `timestamp`; `title` names the fork in the window's language. Null when the message is not found.
	 */
	forkBefore(sessionId: string, messageIndex: number, timestamp: number, title?: string): Promise<{ meta: SessionMeta; messages: number } | null>;
	/**
	 * Fork from just after a reply that ended: the reply and everything before it in a new session,
	 * located the same way as `forkBefore`. Null when it is not found, or is a handover to a tool.
	 */
	forkAfter(sessionId: string, messageIndex: number, timestamp: number, title?: string): Promise<{ meta: SessionMeta; messages: number } | null>;
	remove(sessionId: string): Promise<void>;
	/** Move a session in or out of the archive. Returns the whole list, already updated. */
	setArchived(sessionId: string, archived: boolean): Promise<SessionMeta[]>;
	/**
	 * 从建议卡片开出来的会话，开始以后改「交回这里」。只在第一轮还在跑时算数；false 是已经晚了
	 * （第一轮结束了、它没在跑、或它不是从建议开出来的）。
	 */
	reportBack(sessionId: string, on: boolean): Promise<boolean>;
	/**
	 * 把会话归到另一个项目下：日志文件跟着搬，不只是改个名字。
	 *
	 * 答复分得比 `boolean` 细，因为三种失败要对用户说三句不同的话：`running` 是「先让它停下来」，
	 * `gone` 是「这条对话已经不在了」，`failed` 带着原话（多半是磁盘那边的原因）。
	 */
	move(sessionId: string, cwd: string, projectName: string, project?: string): Promise<
		| { ok: true; meta: SessionMeta }
		| { ok: false; reason: "running" | "gone" | "failed"; message?: string }
	>;
	/** Delete every archived session at once. Returns the remaining list. */
	removeArchived(): Promise<SessionMeta[]>;
	capabilities(sessionId: string): Promise<AgentCapabilities | null>;
	/** Rename a session and persist to disk/log. */
	rename(sessionId: string, title: string): Promise<SessionMeta | null>;
	/** Summarise now. `reason` says why not, when it declines. */
	compact(sessionId: string, instructions?: string): Promise<{ ok: boolean; reason?: string; code?: CompactCode; params?: NoticeParams; before?: number; after?: number }>;
	/** Null when the session is not open — this never boots one just to answer. */
	contextBreakdown(sessionId: string): Promise<ContextBreakdown | null>;
	/** 存着的那份摘要，没有就是 null。 */
	summary(sessionId: string): Promise<StoredSummary | null>;
	/** 要一份新的。没有新消息时不发请求，答的是存着的那份；失败时 `error` 说为什么，`summary` 仍是上一份。 */
	summarize(sessionId: string): Promise<SummarizeResult>;
}
