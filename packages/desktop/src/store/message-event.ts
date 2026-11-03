import type { AgentEvent, Message } from "@plume/core/client-types";


interface State { messages: Message[]; pendingUserMessage: { sessionId: string | null; message: Message } | null }
type Event = Extract<AgentEvent, { type: "message_start" | "message_update" | "message_end" }>;

/*
 * The timestamp a message was first drawn with, for messages that took over from an earlier copy.
 *
 * The optimistic copy of a prompt is stamped by the window, the committed one by the runtime a few
 * dozen milliseconds later. Rows are keyed by timestamp, so the swap unmounted the person's own
 * bubble — and the whole turn keyed on it — at the busiest moment of a send. A WeakMap rather than
 * a field: `Message` is core's shape, and which row a message sits in is only the screen's concern.
 */
const firstDrawn = new WeakMap<Message, number>();

/** The timestamp to key this message's row by: the one it was first drawn with. */
export function drawnAt(message: Message): number {
	return firstDrawn.get(message) ?? message.timestamp;
}

/*
 * 回复末尾那段正文上一次变长是什么时候。
 *
 * 桌面运行行看它判断结论是不是停住了（`RunningRow` 的 `STALL_MS`）。钟不能长在画运行行的组件里：
 * 切到别的会话再切回来，组件看见的长度换了两次，钟就重走一遍——字明明停了一分钟，运行行还要再藏两秒。
 * 记在消息合并这一步，后台会话的每次更新也经过这里，时刻就是字真正落下的时刻。
 *
 * 只在前后长度不同时记新时刻，长度没变就沿用前一份的。正文写完了（`ended`）、或者末尾不是一段正在写的
 * 正文，就不记：那时候没有「停住」可言。从快照读进来的没有记录，同样当它不在写。
 */
const proseAt = new WeakMap<Message, number>();

/** 这条回复末尾那段正文最后一次变长的时刻；它没在写、或者不知道，就是 `undefined`。 */
export function proseGrewAt(message: Message | undefined): number | undefined {
	return message ? proseAt.get(message) : undefined;
}

function tailProse(message: Message | undefined): number | null {
	if (message?.role !== "assistant" || message.stopReason !== "pending") return null;
	const block = message.content[message.content.length - 1];
	return block?.type === "text" && !block.ended ? block.text.length : null;
}

function grew(incoming: Message, earlier: Message | undefined): void {
	const length = tailProse(incoming);
	if (length === null || incoming === earlier) return;
	const before = earlier ? proseAt.get(earlier) : undefined;
	if (earlier && tailProse(earlier) === length) {
		if (before !== undefined) proseAt.set(incoming, before);
		return;
	}
	proseAt.set(incoming, Date.now());
}

function succeeds(incoming: Message, earlier: Message): Message {
	if (incoming !== earlier && drawnAt(earlier) !== incoming.timestamp) firstDrawn.set(incoming, drawnAt(earlier));
	return incoming;
}

/** The same message identity rules apply on screen and in a parked transcript. */
export function messageEvent(state: State, event: Event, sessionId: string): State {
	const { messages, pendingUserMessage: pending } = state;
	const incoming = event.message;
	const pendingMatch =
		pending &&
		pending.sessionId === sessionId &&
		messages.includes(pending.message);
	if (incoming.role === "user" && pendingMatch) {
		return { messages: messages.map((message) => message === pending.message ? succeeds(incoming, message) : message), pendingUserMessage: null };
	}

	const at = findMessageSlot(messages, incoming);
	if (event.type === "message_start") {
		if (incoming.role === "assistant" && at >= 0) return state;
		grew(incoming, undefined);
		return { ...state, messages: [...messages, incoming] };
	}
	grew(incoming, at < 0 ? undefined : messages[at]);
	return { ...state, messages: at < 0 ? [...messages, incoming] : messages.map((message, index) => index === at ? succeeds(incoming, message) : message) };
}

/** 同一条消息在屏上和读回来的那份里认得出彼此：角色、时间戳，工具结果再加它答的是哪个调用。 */
function slotKey(message: Message): string {
	return `${message.role}\n${message.timestamp}\n${message.role === "toolResult" ? message.toolCallId : ""}`;
}

/** 两份 JSON 形状的值是不是一样。字符串整段比：读回来的那份和屏上那份不是同一个字符串对象。 */
function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
		return true;
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	for (const key of keys) if (!Object.hasOwn(right, key) || !sameValue(left[key], right[key])) return false;
	return true;
}

/**
 * 从磁盘读回来的转录，换上屏之前先认一遍屏上已经画着的那些。
 *
 * 读回来的每条都是过了 IPC 的新对象。整份换上去，一行行的 memo 全对不上；更糟的是乐观发出、后来被落盘
 * 那条接管的那句话：它的行按第一次画出来的时间戳起 key（`drawnAt`），这份记录挂在屏上那个对象上，新对象
 * 没有，key 换成落盘的时间戳，那句话连同按它起名的整轮过程卸掉重挂。
 *
 * 内容一样的沿用屏上那个对象；不一样的（读回来的才是准的）用新的，但接着按原来那一行画。角色和时间戳
 * 撞上的两条不认，宁可让那一行重画。
 */
export function keepDrawn(screen: readonly Message[], read: Message[]): Message[] {
	if (screen.length === 0 || read.length === 0) return read;
	const drawn = new Map<string, Message | null>();
	for (const message of screen) {
		const key = slotKey(message);
		drawn.set(key, drawn.has(key) ? null : message);
	}
	let changed = false;
	const next = read.map((message) => {
		const earlier = drawn.get(slotKey(message));
		if (!earlier || earlier === message) return message;
		if (sameValue(earlier, message)) {
			changed = true;
			return earlier;
		}
		return succeeds(message, earlier);
	});
	return changed ? next : read;
}

function findMessageSlot(messages: Message[], incoming: Message): number {
	if (incoming.role === "toolResult") {
		return messages.findIndex((message) => message.role === "toolResult" && message.toolCallId === incoming.toolCallId);
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const candidate = messages[i];
		if (candidate.role !== incoming.role) continue;
		if (candidate.role === "assistant" && incoming.role === "assistant") {
			if (candidate.stopReason === "pending" || candidate.timestamp === incoming.timestamp) return i;
			return -1;
		}
		if (candidate.timestamp === incoming.timestamp) return i;
	}
	return -1;
}
