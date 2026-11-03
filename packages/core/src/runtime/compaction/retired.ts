/**
 * 压缩时被折进头里的那段历史，一条条往后长。
 *
 * 收尾部（`compaction.ts` 的 `fit`、`dropOldest`）每多折一条，头里的最新请求、任务上下文、文件清单
 * 都要按新的那段重算。从前每次都对整段重跑 `lastRequest`、`taskContextFromHistory`、`filesSeen`，
 * 尾部删得多的时候是 O(n²)。这里逐条读下去，读到哪儿交出的都和对那一段从头调那三个函数得出的
 * 同一份——它们本身就是这里的读法从头跑一遍（`foldTaskContext`、`SeenFiles`），不另写一套。
 */

import type { CompactionContext, Message } from "../../types/message.ts";
import { lastRequest, SeenFiles } from "./compaction-head.ts";
import { copyTaskContext, foldTaskContext } from "./task-context.ts";

export class RetiredHistory {
	private context: CompactionContext = {};
	private readonly seen = new SeenFiles();
	private standing: string | null = null;

	add(message: Message): void {
		this.context = foldTaskContext(this.context, message);
		this.seen.add(message);
		// `lastRequest` 从后往前取第一条有话的人话；逐条往后读时，最后一条有话的就是它。
		if (message.role === "user") this.standing = lastRequest([message]) ?? this.standing;
	}

	/** 同 `lastRequest(读过的那段)`。 */
	request(): string | null {
		return this.standing;
	}

	/** 同 `filesSeen(读过的那段)`。 */
	files(): { read: string[]; changed: string[] } {
		return this.seen.list();
	}

	/** 同 `taskContextFromHistory(读过的那段)`，是一份自己的：后面的 `add` 不会改到它。 */
	taskContext(): CompactionContext {
		return copyTaskContext(this.context);
	}
}
