/**
 * What a session looks like when it crosses the boundary: in a reply, in an event, out of a file.
 *
 * Kept apart from the calls that carry it (`sessions.ts`) because the phone receives these too, over
 * its own connection. So this file reaches core through `client-types` and nothing else — the entry
 * the phone already compiles against — and importing the contract costs the phone's type check no
 * more of core than it had. The rest of the contract goes through `contract-types`, which is all of
 * core's index.
 */

import type { ApprovalRequest, CommandRun, HookRun, Message, SessionMeta } from "@plume/core/client-types";

export interface SessionChange {
	id: string;
	projectId: string;
	meta: SessionMeta | null;
}

export interface SessionSnapshot {
	meta: SessionMeta;
	messages: Message[];
	running: boolean;
	pendingApprovals: (ApprovalRequest & { id: string; expiresAt?: number })[];
	/** Message positions where history was summarised, so the mark survives a reload. */
	compactions?: number[];
	commandRuns?: CommandRun[];
	/** 钩子的执行记录，会话里每一轮那个锚点按钮读的就是它。 */
	hookRuns?: HookRun[];
}
