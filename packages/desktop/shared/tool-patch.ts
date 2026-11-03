/**
 * 跑着的工具的进度过 IPC：主进程只发这一次变了的部分，窗口把它接回整份 `tool_update`。
 *
 * `bash` 每 100ms 报一次累计到此刻的全部输出，最多约四万字；六条并行就是每个窗口每秒 2.4MB，而两次
 * 之间新来的往往只有几行。diff 用的是 `message-patch.ts` 那一份：输出接着长的记成追加；输出超过上限、
 * 中段被截掉之后，开头不变而末尾在滚，那一段对不上，退回整段换掉——那一次照旧是全量。
 *
 * 和回复的补丁分开记：一个会话里同时可以有几个调用在跑，按 `toolCallId` 各记一份。
 */

import type { AgentEvent } from "@plume/core/contract-types";
import type { PatchOp, ToolPatch, WireAgentEvent } from "@plume/contract";
import { applyOps, copy, diff } from "./message-patch.ts";

type ToolProgress = Extract<AgentEvent, { type: "tool_update" }>;
type Progress = ToolProgress["partial"];

interface Sent {
	seq: number;
	shadow: unknown;
}

/** 调用收尾（它的 id）、或者整轮收尾（`true`），记着的那份就不再要了。 */
function ends(event: AgentEvent | WireAgentEvent): string | true | null {
	if (event.type === "tool_end") return event.toolCallId;
	if (event.type === "agent_end") return true;
	return null;
}

/** 主进程这一端：每个调用记着上一次发出去的样子，把 `tool_update` 换成补丁。 */
export class ToolPatcher {
	private readonly sent = new Map<string, Map<string, Sent>>();

	/** `tool_update` 换成补丁，其余原样（顺带忘掉收了尾的那几个调用）。 */
	wire(sessionId: string, event: AgentEvent): AgentEvent | ToolPatch {
		if (event.type === "tool_update") return this.patch(sessionId, event);
		const ended = ends(event);
		if (ended === true) this.sent.delete(sessionId);
		else if (ended) this.sent.get(sessionId)?.delete(ended);
		return event;
	}

	/** 这个调用到此刻的进度，整份作为一帧：窗口手里那份接不上时拿它重新起头。 */
	keyframe(sessionId: string, toolCallId: string): ToolPatch | null {
		const sent = this.sent.get(sessionId)?.get(toolCallId);
		if (!sent) return null;
		return { type: "tool_patch", toolCallId, seq: sent.seq, ops: [[[], "s", sent.shadow]] };
	}

	private patch(sessionId: string, event: ToolProgress): ToolPatch {
		let calls = this.sent.get(sessionId);
		if (!calls) this.sent.set(sessionId, (calls = new Map()));
		const sent = calls.get(event.toolCallId);
		// 第一次进度没有可比的，整份作为关键帧。工具会每次给一个新对象，但不保证不原地改，所以记副本。
		if (!sent) {
			calls.set(event.toolCallId, { seq: 0, shadow: copy(event.partial) });
			return { type: "tool_patch", toolCallId: event.toolCallId, seq: 0, ops: [[[], "s", event.partial]] };
		}
		const ops: PatchOp[] = [];
		sent.shadow = diff(sent.shadow, event.partial, [], ops);
		sent.seq += 1;
		return { type: "tool_patch", toolCallId: event.toolCallId, seq: sent.seq, ops };
	}
}

const isKeyframe = (patch: ToolPatch) => patch.ops[0]?.[0].length === 0 && patch.ops[0][1] === "s";

interface Open {
	seq: number;
	partial: Progress;
}

/**
 * 窗口这一端：把补丁接回整份 `tool_update`，交给 `deliver`。
 *
 * 接不上的时候（窗口在命令跑到一半才开始听、重载过、`seq` 断档）向主进程要一帧关键帧，等它回来之前
 * 收到的补丁先攒着，回来以后接着打上去。规矩和回复的 `PatchReader` 一样：宁可停在原处等，不拼错字。
 */
export class ToolPatchReader {
	private readonly open = new Map<string, Open>();
	private readonly waiting = new Map<string, { held: ToolPatch[] }>();
	private readonly resync: (sessionId: string, toolCallId: string) => Promise<ToolPatch | null>;
	private readonly deliver: (sessionId: string, event: ToolProgress) => void;

	constructor(resync: (sessionId: string, toolCallId: string) => Promise<ToolPatch | null>, deliver: (sessionId: string, event: ToolProgress) => void) {
		this.resync = resync;
		this.deliver = deliver;
	}

	/** 别的事件只是看一眼：收了尾的调用不再记着。事件本身由调用方照常交付。 */
	observe(sessionId: string, event: WireAgentEvent): void {
		const ended = ends(event);
		if (ended === true) {
			for (const key of [...this.open.keys(), ...this.waiting.keys()]) if (key.startsWith(`${sessionId}\n`)) this.forget(key);
		} else if (ended) this.forget(keyOf(sessionId, ended));
	}

	private forget(key: string): void {
		this.open.delete(key);
		this.waiting.delete(key);
	}

	/** 补丁在这里还原成整份 `tool_update` 后交出去。 */
	take(sessionId: string, patch: ToolPatch): void {
		const key = keyOf(sessionId, patch.toolCallId);
		const waiting = this.waiting.get(key);
		if (waiting) {
			waiting.held.push(patch);
			return;
		}
		const open = this.open.get(key);
		const fits = isKeyframe(patch) || (open !== undefined && patch.seq === open.seq + 1);
		const partial = fits ? applyOps<Progress>(open?.partial ?? null, patch.ops) : null;
		if (!partial) return this.ask(sessionId, patch.toolCallId, [patch]);
		this.open.set(key, { seq: patch.seq, partial });
		this.deliver(sessionId, { type: "tool_update", toolCallId: patch.toolCallId, partial });
	}

	private ask(sessionId: string, toolCallId: string, held: ToolPatch[]): void {
		const key = keyOf(sessionId, toolCallId);
		this.open.delete(key);
		const waiting = { held };
		this.waiting.set(key, waiting);
		const settle = (keyframe: ToolPatch | null) => {
			// 等的这段时间调用已经收尾：`tool_end` 带着整份结果到了，这帧过时了。
			if (this.waiting.get(key) !== waiting) return;
			this.waiting.delete(key);
			const start = keyframe ? applyOps<Progress>(null, keyframe.ops) : null;
			if (!keyframe || !start) return;
			let partial: Progress = start;
			let last = keyframe.seq;
			for (const patch of waiting.held) {
				if (patch.seq <= last) continue;
				const next: Progress | null = patch.seq === last + 1 ? applyOps(partial, patch.ops) : null;
				if (!next) return this.ask(sessionId, toolCallId, waiting.held.filter((one) => one.seq > last));
				partial = next;
				last = patch.seq;
			}
			this.open.set(key, { seq: last, partial });
			this.deliver(sessionId, { type: "tool_update", toolCallId, partial });
		};
		this.resync(sessionId, toolCallId).then(settle, () => settle(null));
	}
}

/** 会话 id 与调用 id 拼成一格；换行不会出现在两者里，按会话前缀清的时候不会误伤。 */
const keyOf = (sessionId: string, toolCallId: string) => `${sessionId}\n${toolCallId}`;
