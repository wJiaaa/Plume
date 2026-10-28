import type { QueuedTask } from "../../agent/events.ts";
import type { SessionMeta } from "../../session/types.ts";
import type { Message, UserContent } from "../../types.ts";

/**
 * 侧边聊天够得着的那一面主会话：读它的记录、看它在不在忙、往它的队里排活、让它停下或接着做。
 *
 * 不直接写 `AgentSession`：`session.ts` 要引侧边聊天这几个文件，它们再反过来引 `session.ts`，
 * 哪怕只是类型，`pnpm arch` 也会按环报出来。`AgentSession` 按结构满足它。
 */
export interface MainSession {
	readonly meta: SessionMeta;
	readonly messages: Message[];
	readonly running: boolean;
	/**
	 * 真闲着：没在跑，派出去的子代理也都回来了、没有攒着待送和排着的。`running` 为假时后台照样
	 * 可能在跑、在花钱，跑完还会叫醒主会话——暂停和查状态都得看这个。见 `AgentSession.idle`。
	 */
	readonly idle: boolean;
	readonly taskQueue: QueuedTask[];
	enqueueTask(text: string, origin?: QueuedTask["origin"], sideId?: string): Promise<QueuedTask>;
	resumeTask(taskId: string): Promise<boolean>;
	interruptedTask(): QueuedTask | null;
	discardTaskPlan(): Promise<void>;
	abort(): void;
	prompt(content: UserContent[], options: { synthetic: true }): Promise<unknown>;
}
