/**
 * Running a conversation: the turn itself, the work it hands to sub-agents and queued tasks, and
 * what a finished turn left behind — files it changed, services it started.
 */

import type {
	AgentEvent,
	ApprovalDecision,
	ContextBreakdown,
	DiffHunk,
	MessageAttachment,
	QueuedTask,
	SessionMeta,
	SessionWakeup,
	SubAgentDetail,
	SubAgentSummary,
	ThinkingLevel,
	UndoProblem,
	UserContent,
} from "@plume/core/contract-types";

export interface DeliveryFile { path: string; added: number; removed: number; hunks: DiffHunk[]; canUndo: boolean }
/**
 * 撤回能一并拿回的文件：被截掉的那几轮改过的每一个，和它为什么不能安全写回。
 *
 * 全有或全无：有一个 `problem`，或者有记录读不出来（`unrecorded`），这次撤回就只撤对话——只拿回一部分，
 * 代码会停在一个从没存在过的中间状态。
 */
export interface RevertPlan { files: { path: string; added: number; removed: number; problem: UndoProblem | null }[]; unrecorded: boolean }
export interface TurnDelivery { files: DeliveryFile[]; commands: { command: string; status: string; output: string }[]; serviceJobIds: string[]; warnings: string[]; reportPath: string | null }

export interface ServiceEndpoint { address: string; port: number; pid: number; url?: string }
interface SessionService {
	id: string;
	command: string;
	/** What the agent said the command is for; the row shows it instead of the shell line. */
	description?: string;
	pid?: number;
	startedAt: number;
	exitCode: number | null;
	finishedAt?: number;
	status: "running" | "stopping" | "exited" | "failed";
	error?: string;
	/** Started by `monitor`: its output wakes the agent while it runs, not once at the end. */
	kind?: "monitor";
	endpoints: ServiceEndpoint[];
}
export interface SessionServices { jobs: SessionService[]; discoveryError?: string }

/**
 * A slice of a job's output, read from where the last one ended.
 *
 * `next` is the byte offset to ask from next time; ask from -1 to start near the end. `replace`
 * means the text is the whole of what there is rather than a continuation — a job that kept no log
 * file only has its in-memory copy.
 */
export interface ServiceOutput { text: string; next: number; done: boolean; replace?: boolean }

type StreamedReply = Extract<AgentEvent, { type: "message_update" }>;

/**
 * 一步改动：路径、`a` 追加（`at` 是追加前的长度）、`s` 换成新值、`d` 删掉这个键。
 *
 * 路径为空的 `s` 是整条换掉——关键帧，不依赖接收方手里有什么。
 */
export type PatchOp =
	| [path: (string | number)[], kind: "a", at: number, text: string]
	| [path: (string | number)[], kind: "s", value: unknown]
	| [path: (string | number)[], kind: "d"];

/**
 * 流式回复过 IPC 时的样子：`message_update` 只带这一次变了的部分。
 *
 * 进程内的 `message_update` 带整条消息是免费的——那是一个引用；过 IPC 就是一次结构化克隆，每个
 * token 搬一整条回复，两万字的回复要搬近百兆。`seq` 从 `message_start`（记作 0）往上数，接收方
 * 据此知道自己手里那份是不是正好接得上；接不上就用 `agent.streamingMessage` 要一帧关键帧。
 * 编码与还原见 `desktop/shared/message-patch.ts`。
 */
export interface MessagePatch {
	type: "message_patch";
	/** 正在流的那条回复的 `timestamp`。 */
	timestamp: number;
	seq: number;
	ops: PatchOp[];
}

/** 主进程发给窗口的事件：`message_update` 换成了 `MessagePatch`，其余原样。 */
export type WireAgentEvent = Exclude<AgentEvent, StreamedReply> | MessagePatch;

export interface AgentApi {
	/**
	 * `synthetic` marks a message the app composed on the user's behalf — 「继续」 — so the
	 * transcript does not show it as something they typed. See `Session.prompt`.
	 */
	prompt(sessionId: string, content: UserContent[], options?: { synthetic?: boolean; deliver?: "steer" | "followUp" | "interrupt"; resumePending?: boolean; displayText?: string; skillRef?: { name: string; path?: string; pluginId?: string }; sessionRefs?: Array<{ id: string; title: string }>; attachments?: MessageAttachment[] }): Promise<SessionMeta>;
	/**
	 * Replace a message and re-run from there, discarding everything after it.
	 *
	 * `options` 是这条消息除措辞之外的那部分——编辑改的是措辞，别的应当原样留着。不带它的
	 * 那一版等于每编辑一次就把附件从界面上抹掉一次，并把附件正文重新铺回气泡里。
	 *
	 * `files` 和撤回的一样：先把被截掉那几轮改过的文件写回去，全部成功才截断重发。
	 */
	editMessage(sessionId: string, messageIndex: number, content: UserContent[], options?: { displayText?: string; attachments?: MessageAttachment[]; files?: boolean }): Promise<void>;
	/**
	 * Cut from this user message and stop. The wording goes back to the composer, not the model.
	 *
	 * `files` 先把被截掉那几轮改过的文件写回去，全部成功才截对话；有一个不能安全写回就整件不做。
	 */
	revertMessage(sessionId: string, messageIndex: number, options?: { files?: boolean }): Promise<void>;
	/** 撤回到这条消息会碰到哪些文件，只演算不写盘，给确认框用。 */
	revertPlan(sessionId: string, messageIndex: number): Promise<RevertPlan>;
	abort(sessionId: string): Promise<void>;
	approve(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
	setModel(sessionId: string, modelId: string): Promise<void>;
	/**
	 * The reasoning level for this conversation, from here on. `null` returns it to the app
	 * default — which is not the same as pinning it to whatever that default is today.
	 */
	setThinking(sessionId: string, thinking: ThinkingLevel | null): Promise<void>;
	/** 进出计划模式。批准计划后 core 自己关掉，那一次经 `sessions:changed` 送到渲染层。 */
	setPlanMode(sessionId: string, on: boolean): Promise<void>;
	onEvent(handler: (payload: { sessionId: string; event: WireAgentEvent }) => void): () => void;
	/**
	 * 这个会话正在流的那条回复，作为一帧关键帧；没有在流的就是 null。
	 *
	 * 窗口手里的那份接不上补丁时才问（中途打开、重载、`seq` 断档），见 `MessagePatch`。
	 */
	streamingMessage(sessionId: string): Promise<MessagePatch | null>;
}

/**
 * Work this session delegated: what each sub-agent is doing, and a way into a running one.
 *
 * The roster itself is not here — it rides `agent.onEvent` as a `subagents` event, so a window
 * already receiving events is already in step and one that has been away is correct on the
 * first event it gets. These are the things that must be asked for: a transcript, which is too
 * big to broadcast on every tool call, and the two actions.
 */
export interface SubAgentsApi {
	list(sessionId: string): Promise<SubAgentSummary[]>;
	/** Everything one sub-agent has said. Null if the session is closed or the id is unknown. */
	detail(sessionId: string, id: string): Promise<SubAgentDetail | null>;
	/** Where one sub-agent's context window is going, the same reading as `sessions.contextBreakdown`. */
	contextBreakdown(sessionId: string, id: string): Promise<ContextBreakdown | null>;
	/**
	 * Say something to a running sub-agent.
	 *
	 * Spliced between its turns, so it finishes the step it is on and carries on with its
	 * context intact. False when it has already finished — there is no loop left to read it.
	 */
	/** 一段字，或者一串内容块——操控框现在也能附图，见 `core/runtime/sub-agent/sub-agents.ts`。 */
	steer(sessionId: string, id: string, said: string | UserContent[], display?: { displayText?: string; attachments?: MessageAttachment[] }): Promise<boolean>;
	/** Stop one. The parent and its siblings carry on. */
	abort(sessionId: string, id: string): Promise<boolean>;
	/**
	 * Take one off the roster.
	 *
	 * `"stopping"` when it was still running: dismissing does not orphan a live sub-agent, it
	 * stops it first and the row goes once the run has filed itself as aborted.
	 */
	dismiss(sessionId: string, id: string): Promise<"removed" | "stopping" | "unknown">;
}

/**
 * 一个会话旁边的侧边聊天，按「会话 + 面板自己的 id」认。最早那一个叫 `"default"`。
 *
 * 侧边聊天本身是一个会话（`SessionMeta.parentId`）：问、停、编辑重问、换模型都走 `agent`，
 * 读记录走 `sessions.transcript`。这里只有面板要的两件事。
 */
export interface SideChatApi {
	/** 这个会话旁边的侧边聊天会话。 */
	list(sessionId: string): Promise<SessionMeta[]>;
	/** 这一格背后的会话，没有就建一个——第一次提问之前调用。 */
	open(sessionId: string, sideId: string): Promise<SessionMeta>;
	/** 关掉这一个：停下，会话连同记录一起删掉。重开就是一段新的，主会话不受影响。 */
	close(sessionId: string, sideId: string): Promise<void>;
}

/** Work the side chat handed to a session, waiting for it to be free. */
export interface TasksApi {
	list(sessionId: string): Promise<QueuedTask[]>;
	/** Only a task that has not started can be withdrawn; stopping a running one is `abort`. */
	cancel(sessionId: string, taskId: string): Promise<boolean>;
	/**
	 * Take a finished task off the list without touching what it did.
	 *
	 * The list is a receipt for work the side chat handed over. Clearing a row you have already
	 * read — or one you cancelled yourself, whose outcome you knew when you clicked — leaves the
	 * transcript alone. Refuses anything still queued or running: that would read as cancelling
	 * and would not be.
	 */
	dismiss(sessionId: string, taskId: string): Promise<boolean>;
	/**
	 * Put a task that stopped back on the queue.
	 *
	 * For the two ways a task stops without finishing: the main session was paused under it, or
	 * it failed. Both are work you still want done, and both used to be terminal — the row said
	 * so and nothing could act on it.
	 */
	resume(sessionId: string, taskId: string): Promise<boolean>;
}

/**
 * What the model scheduled to come back to this conversation (`schedule_wakeup`, `cron_*`). Live
 * changes arrive as the `wakeups` agent event; `list` is for a window that was not listening.
 */
export interface WakeupsApi {
	list(sessionId: string): Promise<SessionWakeup[]>;
	/** False when it already fired, was cancelled, or the session is not live. */
	cancel(sessionId: string, wakeupId: string): Promise<boolean>;
}

export interface DeliveryApi {
	get(sessionId: string, timestamp: number): Promise<TurnDelivery>;
	/** Answers with the turn as it stands after the undo, which every window also hears through `onChanged`. */
	undo(sessionId: string, timestamp: number, path?: string): Promise<TurnDelivery>;
	/** A turn's delivery changed — an undo, made in any window. */
	onChanged(handler: (change: { sessionId: string; timestamp: number; delivery: TurnDelivery }) => void): () => void;
}

export interface ServicesApi {
	list(sessionId: string): Promise<SessionServices>;
	stop(sessionId: string, id: string, force: boolean): Promise<boolean>;
	output(sessionId: string, id: string, from: number): Promise<ServiceOutput | null>;
}
