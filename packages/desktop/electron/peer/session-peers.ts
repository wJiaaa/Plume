/**
 * 在跑的会话之间互相发现、递话、拿回答。照 t3code 的线程工具（`t3_thread_send` / `t3_thread_wait`），
 * 但按意图分成三件，不靠一个参数区分：
 *
 * - **问**（`ask`）：发一封请求，就地等处理它的那一轮收场，带回那一轮最后说的话。对方闲着开一轮，
 *   忙着排到手上这一轮之后，每个发件会话单独一轮（core 的 `SessionInbox.next`）。等的只认自己那封
 *   信进的那一轮（`peer-runs.ts`），几家同时来问也不串。等到一半被打断（人开口、超时、对方在等它
 *   的人），信照样在对方那里，记在账上，之后用 `wait` 接着等。
 * - **告诉**（`notify`）：一句通知，从不为它开一轮——对方在跑就在两步之间读到，闲着就攒到它下一次
 *   开工时读。没有回答，也就没有等。最初「通知」也能叫醒空闲的对方，结果是对方为一句不需要回答
 *   的话专门跑了一轮，发件方还得等它跑完。
 * - **等**（`wait`）：只给被打断的那几次问，以及「等它把手上的事做完」。
 *
 * 发件方那一轮本来就没结束，所以不需要运行时另递「它闲了」的回执，也不会因为回执多开一轮——最初是
 * 那样做的，人看到的是一件事被切成了好几截。对方卡在等它的人回答上时，等待当场返回，让发件方去
 * 告诉人，而不是干等到超时。往来链记在运行上，不按会话只记最近一条。
 *
 * 对方的权限模式比自己宽，不让发（见 `peer-policy.ts`）。对方此刻（直接或转手）正等着自己，不让问：
 * 问出去它要等对方先回答，而对方在等这边——这时该把问题写进自己这一轮的回复里，等着的那一方读的
 * 就是它。
 *
 * 路由只在主进程里：桌面端是单实例，所有会话都在 `session-hub.ts` 的那张表里，不需要 socket、
 * token 那一层。只认在跑的会话、目录要重叠（见 `peer-reach.ts`）。设计见
 * docs/architecture/session-messaging.md。
 */

import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentSession, PeerLetter, PermissionMode, Settings } from "@plume/core";
import { peerAddress, resolvePeer } from "./peer-address.ts";
import { broaderThan, PeerPacer, type PaceRefusal } from "./peer-policy.ts";
import { rootsOverlap, sessionRoots } from "./peer-reach.ts";
import { PeerRuns, type Pending, type RunEnd } from "./peer-runs.ts";

/** 等对方做完，默认等多久、最多等多久（秒）。到点只是不等了，对方照常干。 */
export const WAIT_DEFAULT_S = 600;
export const WAIT_MAX_S = 1800;
/** 等到之后带回对方那段回复的多少字：够读结论，长报告该让对方写进文件。 */
export const REPLY_LIMIT = 4000;

export interface PeerHost {
	/** 已经起来、没在退场的会话。 */
	live(): AgentSession[];
	/** 应用的设置，没叠项目层。 */
	settings(): Settings;
}

/** `list_sessions` 的一行；地址就是其余几件工具的 `to`。 */
export interface PeerRow {
	address: string;
	sessionId: string;
	cwd: string;
	busy: boolean;
	mode: PermissionMode;
}

/** 找对方时可能落空的几种，几件都共用。 */
type Missed =
	| { kind: "unreachable"; to: string }
	| { kind: "none" }
	| { kind: "self" }
	| { kind: "ambiguous"; candidates: string[] };

/** 信没发出去的几种，`ask` 和 `notify` 共用。 */
export type Refused =
	| Missed
	| { kind: "broader"; to: string; theirs: PermissionMode; mine: PermissionMode }
	| { kind: "paced"; to: string; reason: PaceRefusal; length: number; chain: number };

export type NotifyOutcome = Refused | { kind: "delivered"; to: string; busy: boolean };

/** 一次运行给的回答：它最后说的话、怎么收的场，回答的是我发的哪几封（原文）。 */
interface Answer {
	reply: string;
	cut: number;
	reason: RunEnd["reason"];
	asked: string[];
}

/** 发出去、还没等过的一封：等回来时要说清每段回答对着哪封信。 */
interface Sent {
	id: string;
	text: string;
}

export type WaitOutcome =
	| Missed
	/** `dropped`：一起等的信里有几封还没进对话就被对方的人停下，丢了，没有回答。 */
	| { kind: "done"; to: string; answers: Answer[]; dropped: number; waitedMs: number }
	| { kind: "blocked"; to: string; pending: Pending[] }
	| { kind: "dropped"; to: string }
	| { kind: "timeout"; to: string; seconds: number }
	| { kind: "closed"; to: string }
	| { kind: "stopped"; to: string }
	| { kind: "deadlock"; to: string };

/** 问：要么没发出去，要么发出去了、等到了哪一步。`waited-on`：对方正等着这边，没发。 */
export type AskOutcome = Refused | Exclude<WaitOutcome, Missed | { kind: "deadlock" }> | { kind: "waited-on"; to: string };

/** 一个发件方对同一个收件方最多记几封还没等过的信；再多就是没打算等，旧的忘掉。 */
const OUTSTANDING_PER_PAIR = 8;

export function createPeerRouter(host: PeerHost) {
	const pacer = new PeerPacer();
	/**
	 * 谁正在等谁、各等着几次。一个会话可以同时等好几个（同一批里并发的几次问），
	 * 所以是一对多；按次数记，同一对的两次等待各自收场时不会把对方的那一条也删掉。顺着它走回到
	 * 自己，就是互相死等。
	 */
	const waiting = new Map<string, Map<string, number>>();
	const runs = new PeerRuns();
	/** 发件方→收件方问出去、还没拿到回答的信，按发出的顺序：`wait` 一次把它们的回答都带回来。 */
	const outstanding = new Map<string, Sent[]>();
	/** 每个发件方已经被告知过的「对方在等人回答」：同一件事只报一次，再等就等它被回答。 */
	const reported = new Map<string, Set<string>>();
	const pair = (from: string, to: string) => `${from}\u0000${to}`;

	const find = (id: string) => host.live().find((session) => session.meta.id === id);
	const address = (session: AgentSession) => peerAddress({ id: session.meta.id, title: session.meta.title, cwd: session.cwd });
	const identity = (session: AgentSession) => ({ id: session.meta.id, title: session.meta.title, cwd: session.cwd, session });

	async function reachable(from: AgentSession, to: AgentSession): Promise<boolean> {
		const projects = host.settings().projects;
		const [mine, theirs] = await Promise.all([sessionRoots(from.cwd, projects, from.meta.project), sessionRoots(to.cwd, projects, to.meta.project)]);
		return rootsOverlap(mine, theirs);
	}

	/** 解析地址、查目录重叠。自己也在候选里：拿自己的地址来，该告诉它「这是你自己」而不是「没这个人」。 */
	async function lookup(fromId: string, to: string): Promise<Missed | { kind: "found"; from: AgentSession; target: AgentSession; to: string }> {
		const from = find(fromId);
		if (!from) return { kind: "none" };
		const found = resolvePeer(to, host.live().map(identity));
		if (found.kind === "none") return { kind: "none" };
		if (found.kind === "ambiguous") return { kind: "ambiguous", candidates: found.candidates.map((one) => address(one.session)) };
		const target = found.peer.session;
		if (target === from) return { kind: "self" };
		const name = address(target);
		if (!(await reachable(from, target))) return { kind: "unreachable", to: name };
		return { kind: "found", from, target, to: name };
	}

	/** `from` 等 `target` 会不会绕回来等到自己头上。 */
	function waitsOn(target: string, from: string): boolean {
		const seen = new Set<string>();
		const stack = [target];
		while (stack.length > 0) {
			const at = stack.pop()!;
			if (at === from) return true;
			if (seen.has(at)) continue;
			seen.add(at);
			stack.push(...(waiting.get(at)?.keys() ?? []));
		}
		return false;
	}

	function startWaiting(from: string, to: string): () => void {
		const targets = waiting.get(from) ?? new Map<string, number>();
		waiting.set(from, targets);
		targets.set(to, (targets.get(to) ?? 0) + 1);
		return () => {
			const left = (targets.get(to) ?? 1) - 1;
			if (left > 0) targets.set(to, left);
			else targets.delete(to);
			if (targets.size === 0 && waiting.get(from) === targets) waiting.delete(from);
		};
	}

	/**
	 * 这几封信落定了没有：等到处理它的那一轮收场，还没进对话它却闲了的是丢了。还有没落定的给 null。
	 *
	 * `idle` 时收场事件还没到的（宿主没把事件交过来），不再等，拿对话里最后那句。
	 */
	function settle(target: AgentSession, letters: Sent[]): { answers: Map<number, RunEnd & { asked: string[] }>; dropped: number } | null {
		const id = target.meta.id;
		const idle = target.idle;
		const answers = new Map<number, RunEnd & { asked: string[] }>();
		let dropped = 0;
		for (const letter of letters) {
			const run = runs.entry(id, letter.id);
			if (run === undefined) {
				// 信还没进对话，它却已经闲了：攒着待送的时候被人按了停，信跟着丢了。
				if (!idle) return null;
				dropped += 1;
				continue;
			}
			const end = runs.ended(id, run) ?? (idle ? { reason: "done" as const, reply: lastReply(target) } : null);
			if (!end) return null;
			answers.set(run, { ...end, asked: [...(answers.get(run)?.asked ?? []), letter.text] });
		}
		return { answers, dropped };
	}

	/** 找到人之后、发出去之前的两道关：权限、限速。过了就把信交给对方。 */
	function post(from: AgentSession, target: AgentSession, to: string, message: string, kind: "request" | "notice"): Refused | { kind: "posted"; sent: Sent; busy: boolean } {
		const fromId = from.meta.id;
		const text = message.trim();

		const mine = from.settingsInEffect.permissionMode;
		const theirs = target.settingsInEffect.permissionMode;
		if (broaderThan(theirs, mine)) return { kind: "broader", to, theirs, mine };

		const chain = [...runs.chain(fromId), fromId];
		const refusal = pacer.admit(fromId, target.meta.id, text, chain);
		if (refusal) return { kind: "paced", to, reason: refusal, length: text.length, chain: chain.length };

		const busy = !target.idle;
		const letter: PeerLetter = { id: randomUUID(), sessionId: fromId, from: address(from), text, cwd: from.cwd, chain };
		target.receive(letter, kind);
		return { kind: "posted", sent: { id: letter.id!, text }, busy };
	}

	/**
	 * 等这几封落定，或者（不给信时）等对方手上这一次。落定的从 `outstanding` 里划掉；被打断的留着，
	 * 下次 `wait` 接着等。
	 */
	async function untilSettled(fromId: string, target: AgentSession, to: string, letters: Sent[], input: { timeoutSeconds?: number; signal?: AbortSignal }): Promise<Exclude<WaitOutcome, Missed | { kind: "deadlock" }>> {
		const id = target.meta.id;
		const started = Date.now();
		const key = pair(fromId, id);
		const answered = (ends: (RunEnd & { asked?: string[] })[], dropped = 0) => ({
			kind: "done" as const,
			to,
			answers: ends.map((end) => ({ ...clip(end.reply), reason: end.reason, asked: end.asked ?? [] })),
			dropped,
			waitedMs: Date.now() - started,
		});
		const run = letters.length > 0 ? undefined : (runs.current(id) ?? (target.idle ? undefined : runs.next(id)));
		if (letters.length === 0 && run === undefined) return answered([{ reason: "done", reply: lastReply(target) }]);

		/** 落定了的结果；还没有就是 null。 */
		const outcome = () => {
			if (letters.length === 0) {
				const end = runs.ended(id, run!) ?? (target.idle ? { reason: "done" as const, reply: lastReply(target) } : null);
				return end && answered([end]);
			}
			const settled = settle(target, letters);
			if (!settled) return null;
			const left = (outstanding.get(key) ?? []).filter((one) => !letters.includes(one));
			if (left.length > 0) outstanding.set(key, left);
			else outstanding.delete(key);
			const { answers, dropped } = settled;
			if (answers.size > 0) return answered([...answers.entries()].sort(([a], [b]) => a - b).map(([, end]) => end), dropped);
			return { kind: "dropped" as const, to };
		};

		const seconds = Math.min(WAIT_MAX_S, Math.max(1, Math.round(input.timeoutSeconds ?? WAIT_DEFAULT_S)));
		const deadline = started + seconds * 1000;
		const told = reported.get(fromId) ?? new Set<string>();
		reported.set(fromId, told);
		const stopWaiting = startWaiting(fromId, id);
		try {
			for (;;) {
				if (!find(id)) return { kind: "closed", to };
				const done = outcome();
				if (done) return done;
				const fresh = runs.pending(id).filter((one) => !told.has(one.requestId));
				if (fresh.length > 0) {
					for (const one of fresh) told.add(one.requestId);
					return { kind: "blocked", to, pending: fresh };
				}
				const woke = await wake(target, deadline, input.signal);
				if (woke === "timeout") return { kind: "timeout", to, seconds };
				if (woke === "stopped") return { kind: "stopped", to };
			}
		} finally {
			stopWaiting();
		}
	}

	async function wake(session: AgentSession, until: number, signal?: AbortSignal): Promise<"changed" | "timeout" | "stopped"> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			return await Promise.race([
				runs.changed(session.meta.id).then(() => "changed" as const),
				session.whenIdle().then(() => "changed" as const),
				new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), Math.max(0, until - Date.now())); }),
				new Promise<"stopped">((resolve) => {
					if (signal?.aborted) return resolve("stopped");
					onAbort = () => resolve("stopped");
					signal?.addEventListener("abort", onAbort, { once: true });
				}),
			]);
		} finally {
			clearTimeout(timer);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	}

	return {
		/** `from` 看得见的会话：在跑、不是自己、目录重叠。 */
		async list(fromId: string): Promise<PeerRow[]> {
			const from = find(fromId);
			if (!from) return [];
			const others = host.live().filter((session) => session.meta.id !== fromId);
			const visible = await Promise.all(others.map(async (session) => ((await reachable(from, session)) ? session : null)));
			return visible
				.filter((session): session is AgentSession => session !== null)
				.map((session) => ({ address: address(session), sessionId: session.meta.id, cwd: session.cwd, busy: !session.idle, mode: session.settingsInEffect.permissionMode }));
		},

		/** 发一封请求，等处理它的那一轮收场。被打断时信留在账上，见 `wait`。 */
		async ask(fromId: string, input: { to: string; message: string; timeoutSeconds?: number; signal?: AbortSignal }): Promise<AskOutcome> {
			const found = await lookup(fromId, input.to);
			if (found.kind !== "found") return found;
			const { from, target, to } = found;
			// 对方（直接或转手）正等着这边：问出去它得先等这边答，而这边在等它。
			if (waitsOn(target.meta.id, fromId)) return { kind: "waited-on", to };
			const posted = post(from, target, to, input.message, "request");
			if (posted.kind !== "posted") return posted;
			const key = pair(fromId, target.meta.id);
			outstanding.set(key, [...(outstanding.get(key) ?? []), posted.sent].slice(-OUTSTANDING_PER_PAIR));
			return untilSettled(fromId, target, to, [posted.sent], input);
		},

		/** 递一句通知：不开轮、不等，见文件头。 */
		async notify(fromId: string, input: { to: string; message: string }): Promise<NotifyOutcome> {
			const found = await lookup(fromId, input.to);
			if (found.kind !== "found") return found;
			const posted = post(found.from, found.target, found.to, input.message, "notice");
			return posted.kind === "posted" ? { kind: "delivered", to: found.to, busy: posted.busy } : posted;
		},

		/**
		 * 接着等问出去、还没拿到回答的那几封：每封带回处理它的那一轮最后说的话。没有这样的信：照
		 * t3code，闲着立刻返回它最后那句，忙着就等手上这一次。
		 */
		async wait(fromId: string, input: { to: string; timeoutSeconds?: number; signal?: AbortSignal }): Promise<WaitOutcome> {
			const found = await lookup(fromId, input.to);
			if (found.kind !== "found") return found;
			const { target, to } = found;
			if (waitsOn(target.meta.id, fromId)) return { kind: "deadlock", to };
			return untilSettled(fromId, target, to, [...(outstanding.get(pair(fromId, target.meta.id)) ?? [])], input);
		},

		/** 每个会话的事件都交过来一份：路由器据此知道哪封信进了哪一次运行、它有没有在等人。 */
		observe(sessionId: string, event: AgentEvent): void {
			runs.observe(sessionId, event);
		},

		/** 人开口了：之后这个会话发出去的信是一条新链，不再接着别人的那条。 */
		personSpoke(sessionId: string): void {
			runs.personSpoke(sessionId);
		},

		/** 会话要被卸载了。等它的那一方由 `whenIdle` 兑现后自己发现它不在了。 */
		forget(sessionId: string): void {
			waiting.delete(sessionId);
			reported.delete(sessionId);
			// 它发出去的、发给它的都清掉：它再起来是新的一套运行编号，旧的那封对不上了。
			for (const key of outstanding.keys()) if (key.split("\u0000").includes(sessionId)) outstanding.delete(key);
			runs.forget(sessionId);
		},
	};
}

export type PeerRouter = ReturnType<typeof createPeerRouter>;

/** 它最后那段 assistant 文本。交回建议的会话也读这一段，见 `session-report-back.ts`。 */
export function lastReply(session: AgentSession): string {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index]!;
		if (message.role !== "assistant") continue;
		const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
		if (text) return text;
	}
	return "";
}

/** 太长的截掉，记下截了多少：说明里要告诉模型怎么拿到其余的部分。 */
function clip(text: string): { reply: string; cut: number } {
	return text.length > REPLY_LIMIT ? { reply: text.slice(0, REPLY_LIMIT), cut: text.length - REPLY_LIMIT } : { reply: text, cut: 0 };
}
