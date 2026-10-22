/**
 * 流式回复过 IPC：主进程只发这一次变了的部分，窗口把它接回整条消息。
 *
 * 以前每个 token 一条 `message_update`，带着整条回复。进程内那是一个引用，过 IPC 是一次结构化克隆：
 * 两万字的回复流完要搬 98MB，四万字 386MB——总量是回复长度的平方。现在每条只带新增的那几个字，
 * 总量跟回复长度成正比。
 *
 * 补丁是对消息结构做的通用 diff，而不是照搬 provider 给的 `delta` 字符串：工具参数会在收尾时整个
 * 解析出来，用量、签名之类的字段也会在流的中途变。diff 让窗口还原出来的那份和主进程手里的逐字段
 * 一致，不用知道每种 provider 会改哪些字段（字符串怎么判断「接着长」见 `grew`）。
 *
 * 两端各有一份「上一次发出去的样子」。主进程那份是自己的结构副本（字符串共用，不拷）——provider 会
 * 原地改 `partial`，拿它的引用当上一次是错的。窗口那份就是它最后交给 store 的消息，从不原地改：
 * 改动沿路径复制，store 里的旧消息还是旧的。
 */

import type { AgentEvent } from "@plume/core/contract-types";
import type { MessagePatch, PatchOp, WireAgentEvent } from "@plume/contract";

type StreamedReply = Extract<AgentEvent, { type: "message_update" }>;
type Reply = StreamedReply["message"];
type Path = (string | number)[];

const isPlain = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** 容器逐层复制，叶子共用。字符串不可变，共用就是快照。 */
function copy(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(copy);
	if (!isPlain(value)) return value;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value)) out[key] = copy(value[key]);
	return out;
}

/** 比较末尾多长一段来判断「是接着长的」，同 core 的 `session/partial.ts`。 */
const GROWTH_TAIL = 64;

/**
 * `next` 是不是 `prev` 接着往后长出来的。
 *
 * 不用 `startsWith`：那是每个 token 把整段正文比一遍，两万字的回复光这一项就是平方级的 CPU，正好把
 * 省下的序列化又花回去。只比旧值末尾那一段——流式输出只会往后长或者整段重来，重来时末尾对不上。
 * 中段被改写而末尾恰好不变的那种，补丁会少改一处，直到 `message_end` 带着整条消息来覆盖。
 */
function grew(prev: string, next: string): boolean {
	if (prev.length === 0 || next.length <= prev.length) return false;
	const from = Math.max(0, prev.length - GROWTH_TAIL);
	return next.slice(from, prev.length) === prev.slice(from);
}

/**
 * `prev` 变成 `next` 要哪几步，顺带返回 `next` 的快照，作为下一次的 `prev`。
 *
 * 字符串接着长的记成追加——流式输出几乎全是这种。数组变短、类型变了，整个换掉：罕见，换掉也是对的。
 * `path` 是一路共用的栈，只在真要记一步时才复制，不为每个没变的节点分配一个数组。
 */
function diff(prev: unknown, next: unknown, path: Path, ops: PatchOp[]): unknown {
	if (typeof next === "string") {
		if (prev === next) return next;
		if (typeof prev === "string" && grew(prev, next)) ops.push([path.slice(), "a", prev.length, next.slice(prev.length)]);
		else ops.push([path.slice(), "s", next]);
		return next;
	}
	if (Array.isArray(next)) {
		if (!Array.isArray(prev) || next.length < prev.length) {
			ops.push([path.slice(), "s", next]);
			return copy(next);
		}
		return next.map((item, i) => {
			path.push(i);
			const shadow = i < prev.length ? diff(prev[i], item, path, ops) : (ops.push([path.slice(), "s", item]), copy(item));
			path.pop();
			return shadow;
		});
	}
	if (isPlain(next)) {
		if (!isPlain(prev)) {
			ops.push([path.slice(), "s", next]);
			return copy(next);
		}
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(next)) {
			path.push(key);
			if (Object.hasOwn(prev, key)) out[key] = diff(prev[key], next[key], path, ops);
			else {
				ops.push([path.slice(), "s", next[key]]);
				out[key] = copy(next[key]);
			}
			path.pop();
		}
		for (const key of Object.keys(prev)) if (!Object.hasOwn(next, key)) ops.push([[...path, key], "d"]);
		return out;
	}
	if (!Object.is(prev, next)) ops.push([path.slice(), "s", next]);
	return next;
}

interface Sent {
	timestamp: number;
	seq: number;
	shadow: unknown;
}

/** 主进程这一端：每个会话记着上一次发出去的样子，把 `message_update` 换成补丁。 */
export class MessagePatcher {
	private readonly sent = new Map<string, Sent>();

	wire(sessionId: string, event: AgentEvent): WireAgentEvent {
		if (event.type === "message_update") return this.patch(sessionId, event);
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.sent.set(sessionId, { timestamp: event.message.timestamp, seq: 0, shadow: copy(event.message) });
		} else if ((event.type === "message_end" && event.message.role === "assistant") || event.type === "message_discarded" || event.type === "agent_end") {
			this.sent.delete(sessionId);
		}
		return event;
	}

	/** 正在流的那条回复，整条作为一帧：窗口手里那份接不上时拿它重新起头。 */
	keyframe(sessionId: string): MessagePatch | null {
		const sent = this.sent.get(sessionId);
		if (!sent) return null;
		return { type: "message_patch", timestamp: sent.timestamp, seq: sent.seq, ops: [[[], "s", sent.shadow]] };
	}

	private patch(sessionId: string, event: StreamedReply): MessagePatch {
		const message = event.message;
		const sent = this.sent.get(sessionId);
		// 没见过开头的回复（不该有，但不能因此发出一条谁也接不上的补丁）：从关键帧起。
		if (!sent || sent.timestamp !== message.timestamp) {
			this.sent.set(sessionId, { timestamp: message.timestamp, seq: 0, shadow: copy(message) });
			return { type: "message_patch", timestamp: message.timestamp, seq: 0, ops: [[[], "s", message]] };
		}
		const ops: PatchOp[] = [];
		sent.shadow = diff(sent.shadow, message, [], ops);
		sent.seq += 1;
		return { type: "message_patch", timestamp: message.timestamp, seq: sent.seq, ops };
	}
}

const isKeyframe = (patch: MessagePatch) => patch.ops[0]?.[0].length === 0 && patch.ops[0][1] === "s";

/**
 * 把补丁打在 `base` 上，返回新的消息；接不上就返回 null。
 *
 * 不原地改 `base`：它可能已经交给了 store，改了它就是在 store 不知情的时候改了画面的来源。
 * 沿路径把经过的容器各复制一次（同一次里复制过的不再复制）。
 */
export function applyPatch(base: Reply | null, patch: MessagePatch): Reply | null {
	let root: unknown = base;
	const owned = new Set<unknown>();
	const own = <T>(container: T): T => {
		if (owned.has(container)) return container;
		const fresh = (Array.isArray(container) ? container.slice() : { ...container }) as T;
		owned.add(fresh);
		return fresh;
	};
	for (const op of patch.ops) {
		const path = op[0];
		if (path.length === 0) {
			if (op[1] !== "s") return null;
			root = op[2];
			continue;
		}
		if (typeof root !== "object" || root === null) return null;
		root = own(root);
		let node = root as Record<string | number, unknown>;
		for (const key of path.slice(0, -1)) {
			const child = node[key];
			if (typeof child !== "object" || child === null) return null;
			node = node[key] = own(child) as Record<string | number, unknown>;
		}
		const last = path[path.length - 1];
		if (op[1] === "s") node[last] = op[2];
		else if (op[1] === "d") delete node[last];
		else {
			const text = node[last];
			// 长度对不上就是漏了一步——宁可要关键帧，也不拼出一段错字。
			if (typeof text !== "string" || text.length !== op[2]) return null;
			node[last] = text + op[3];
		}
	}
	return root as Reply | null;
}

/**
 * 还原出来的 `delta` 只是占位：窗口里没有谁读它，过 IPC 带着原来那份，新长的字就要发两遍
 * （补丁里一遍、`delta` 里一遍），占补丁字节的四分之一。`start` 是唯一只带整条消息的那种。
 */
const toUpdate = (message: Reply): StreamedReply => ({ type: "message_update", message, delta: { type: "start", partial: message } });

interface Open {
	timestamp: number;
	seq: number;
	message: Reply;
}

/**
 * 窗口这一端：把补丁接回整条 `message_update`，交给 `deliver`。
 *
 * 接不上的时候（窗口在回复中途才开始听、重载过、`seq` 断档）向主进程要一帧关键帧，等它回来之前
 * 收到的补丁先攒着，回来以后接着打上去——关键帧之前的跳过，之后的照常。等的这段时间这条回复在
 * 画面上停在原处，不会出现错字。
 */
export class PatchReader {
	private readonly open = new Map<string, Open>();
	private readonly waiting = new Map<string, { held: MessagePatch[] }>();
	private readonly resync: (sessionId: string) => Promise<MessagePatch | null>;
	private readonly deliver: (sessionId: string, event: AgentEvent) => void;

	constructor(resync: (sessionId: string) => Promise<MessagePatch | null>, deliver: (sessionId: string, event: AgentEvent) => void) {
		this.resync = resync;
		this.deliver = deliver;
	}

	read(sessionId: string, event: WireAgentEvent): void {
		if (event.type === "message_patch") return this.take(sessionId, event);
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.waiting.delete(sessionId);
			this.open.set(sessionId, { timestamp: event.message.timestamp, seq: 0, message: event.message });
		} else if ((event.type === "message_end" && event.message.role === "assistant") || event.type === "message_discarded" || event.type === "agent_end") {
			this.waiting.delete(sessionId);
			this.open.delete(sessionId);
		}
		this.deliver(sessionId, event);
	}

	private take(sessionId: string, patch: MessagePatch): void {
		const waiting = this.waiting.get(sessionId);
		if (waiting) {
			waiting.held.push(patch);
			return;
		}
		const open = this.open.get(sessionId);
		const fits = isKeyframe(patch) || (open !== undefined && open.timestamp === patch.timestamp && patch.seq === open.seq + 1);
		const message = fits ? applyPatch(open?.message ?? null, patch) : null;
		if (!message) return this.ask(sessionId, [patch]);
		this.open.set(sessionId, { timestamp: patch.timestamp, seq: patch.seq, message });
		this.deliver(sessionId, toUpdate(message));
	}

	private ask(sessionId: string, held: MessagePatch[]): void {
		this.open.delete(sessionId);
		const waiting = { held };
		this.waiting.set(sessionId, waiting);
		const settle = (keyframe: MessagePatch | null) => {
			// 等的这段时间回复已经收尾或换了一条：这帧关键帧过时了。
			if (this.waiting.get(sessionId) !== waiting) return;
			this.waiting.delete(sessionId);
			const start = keyframe ? applyPatch(null, keyframe) : null;
			// 回复已经流完（`message_end` 正在路上或已经到了）：它会带着整条消息来，不用补。
			if (!keyframe || !start) return;
			let message: Reply = start;
			let last = keyframe;
			for (const patch of waiting.held) {
				if (patch.timestamp !== keyframe.timestamp || patch.seq <= last.seq) continue;
				const next: Reply | null = patch.seq === last.seq + 1 ? applyPatch(message, patch) : null;
				if (!next) return this.ask(sessionId, waiting.held.filter((one) => one.seq > last.seq));
				message = next;
				last = patch;
			}
			this.open.set(sessionId, { timestamp: keyframe.timestamp, seq: last.seq, message });
			this.deliver(sessionId, toUpdate(message));
		};
		this.resync(sessionId).then(settle, () => settle(null));
	}
}
