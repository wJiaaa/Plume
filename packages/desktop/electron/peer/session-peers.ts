/**
 * 在跑的会话之间互相发现、递话、拿回答。按意图分成三件，不靠一个参数区分：
 *
 * - **问**（`ask`）：发一封请求，当场返回。对方闲着开一轮，忙着在两步之间读到。答复不在这次调用里
 *   等，而是作为一封 `answer` 信送回发件方——和子代理送回结果（ADR-0051）、t3code 的 `delegate_task`
 *   一个样子。曾经就地等：等待会被人开口、别家的信、甚至被等的那一家自己发来的信打断，本机 17 次
 *   `wait_for_session` 只等到 1 次；等的期间人说的话也要特殊处理才送得进去。见 ADR-0060。
 * - **回**（`reply`）：收件方交回答复，这个发件方发来、已经读到、还没答的几封一起答，作为一封信送过去。
 * - **告诉**（`notify`）：一句通知，当场返回。对方在跑就在两步之间读到，闲着就为它开一轮。没有答复。
 *
 * 答复总会到：对方读到请求的那一轮收场了还没回，拿那一轮最后说的话代它答（`unreplied`）；请求没读到就被
 * 对方的人停下了，代它说「没读到」（`dropped`）；对方关了，说「关了」（`closed`）。发件方问完多半已经收尾
 * 等着，什么都不送它就永远等下去。代答钉住读到信的那一次运行（`peer-runs.ts`），不取对方下一次空闲时的
 * 最后一句：那之前它可能跑了好几次，最后一句回答的是别人（照 synara 的 `wait_for_threads`）。
 *
 * 还有没拿到答复的问时，发件方不算闲（`awaitingAnswers`）：交回建议的会话等它，宿主也不回收它——
 * 回收了，答复就没人收了。
 *
 * 对方的权限模式比自己宽，不让发（见 `peer-policy.ts`）。路由只在主进程里：桌面端是单实例，所有会话
 * 都在 `session-hub.ts` 的那张表里，不需要 socket、token 那一层。只认在跑的会话、目录要重叠
 * （见 `peer-reach.ts`）。设计见 docs/architecture/session-messaging.md。
 */

import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentSession, PeerLetter, PermissionMode, Settings } from "@plume/core";
import { peerAddress, resolvePeer } from "./peer-address.ts";
import { broaderThan, PeerPacer, type PaceRefusal } from "./peer-policy.ts";
import { rootsOverlap, sessionRoots } from "./peer-reach.ts";
import { PeerRuns } from "./peer-runs.ts";

/** 代答时带过去的对方最后那段话最多几个字：够读结论，长报告该让对方写进文件。 */
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
	/** 它清单上正在做的那一项；没有清单就没有。 */
	doing?: string;
	/** 它在等它的人审批或回答。 */
	waitingOnUser: boolean;
}

/** 找对方时可能落空的几种，几件都共用。 */
export type Missed =
	| { kind: "unreachable"; to: string }
	| { kind: "none" }
	| { kind: "self" }
	| { kind: "ambiguous"; candidates: string[] };

/** 信没发出去的几种。 */
export type Refused =
	| Missed
	| { kind: "broader"; to: string; theirs: PermissionMode; mine: PermissionMode }
	| { kind: "paced"; to: string; reason: PaceRefusal; length: number; chain: number };

export type AskOutcome = Refused | { kind: "sent"; to: string; busy: boolean };
export type NotifyOutcome = Refused | { kind: "delivered"; to: string; busy: boolean };
/** 回：`answered` 是这次答了它几封问；0 说明它没有待答的问，这句当作通知送过去。 */
export type ReplyOutcome = Refused | { kind: "replied"; to: string; answered: number };

/** 一封还没拿到答复的问。收件方的地址和目录在发出时记下：它关了以后还要替它说一句。 */
interface Asked {
	id: string;
	text: string;
	/** 发出时的往来链，含发件方自己：代答的信接在它后面。 */
	chain: string[];
	asker: string;
	target: { id: string; address: string; cwd: string };
}

/** 一个发件方对同一个收件方最多记几封还没答的问；再多就是在刷，旧的忘掉。 */
const OUTSTANDING_PER_PAIR = 8;

export function createPeerRouter(host: PeerHost) {
	const pacer = new PeerPacer();
	const runs = new PeerRuns();
	/** 问出去、还没拿到答复的，按发出的顺序。 */
	let outstanding: Asked[] = [];
	/** 等某个发件方的问都答完的人（交回建议的会话）。 */
	const answeredWaiters = new Map<string, Set<() => void>>();

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

	/** 找到人之后、发出去之前的两道关：权限、限速。过了就把信交给对方。 */
	function post(from: AgentSession, target: AgentSession, to: string, message: string, kind: "request" | "notice"): Refused | { kind: "posted"; letter: PeerLetter & { id: string; chain: string[] }; busy: boolean } {
		const fromId = from.meta.id;
		const text = message.trim();

		const mine = from.settingsInEffect.permissionMode;
		const theirs = target.settingsInEffect.permissionMode;
		if (broaderThan(theirs, mine)) return { kind: "broader", to, theirs, mine };

		const chain = [...runs.chain(fromId), fromId];
		const refusal = pacer.admit(fromId, target.meta.id, text, chain);
		if (refusal) return { kind: "paced", to, reason: refusal, length: text.length, chain: chain.length };

		const busy = !target.idleInForeground;
		const letter = { id: randomUUID(), sessionId: fromId, from: address(from), text, cwd: from.cwd, chain, ...(kind === "request" ? { request: true as const } : {}) };
		target.receive(letter);
		return { kind: "posted", letter, busy };
	}

	/** 这个发件方还有几封问没拿到答复。 */
	const pendingFrom = (askerId: string) => outstanding.filter((one) => one.asker === askerId).length;

	/** 划掉这几封；发件方的问都答完了就叫醒等它的人。 */
	function settle(asked: Asked[]): void {
		outstanding = outstanding.filter((one) => !asked.includes(one));
		for (const askerId of new Set(asked.map((one) => one.asker))) {
			if (pendingFrom(askerId) > 0) continue;
			const waiters = answeredWaiters.get(askerId);
			answeredWaiters.delete(askerId);
			for (const resolve of waiters ?? []) resolve();
		}
	}

	/** 把一段答复作为信送到发件方，这几封随之划掉。发件方已经不在了就只划掉。 */
	function answer(asked: Asked[], how: NonNullable<PeerLetter["answer"]>, text: string, chain: string[]): void {
		const { asker: askerId, target } = asked[0]!;
		settle(asked);
		find(askerId)?.receive({ id: randomUUID(), sessionId: target.id, from: target.address, text, cwd: target.cwd, chain, answer: how, re: asked.map((one) => excerpt(one.text)) });
	}

	/** 按发件方分组，一家一封答复：几家问了同一个会话，各收各的。 */
	function answerEach(asked: Asked[], how: NonNullable<PeerLetter["answer"]>, text: string): void {
		for (const askerId of new Set(asked.map((one) => one.asker))) {
			const theirs = asked.filter((one) => one.asker === askerId);
			const longest = theirs.reduce<string[]>((chain, one) => (one.chain.length > chain.length ? one.chain : chain), []);
			answer(theirs, how, text, [...longest, theirs[0]!.target.id]);
		}
	}

	/** 收件方一次运行收场了：读到了却没回的，拿那一次最后说的话代答。 */
	function afterRun(targetId: string): void {
		const mine = outstanding.filter((one) => one.target.id === targetId);
		const byRun = new Map<number, Asked[]>();
		for (const one of mine) {
			const run = runs.entry(targetId, one.id);
			if (run === undefined || !runs.ended(targetId, run)) continue;
			byRun.set(run, [...(byRun.get(run) ?? []), one]);
		}
		for (const [run, asked] of byRun) {
			const end = runs.ended(targetId, run)!;
			const said = clip(end.reply);
			const how = end.reason === "done" ? "" : `[The turn that read your message ended early (${end.reason}).]\n`;
			answerEach(asked, "unreplied", `${how}${said || "(It said nothing.)"}`);
		}
	}

	/**
	 * 收件方闲下来时，这封问还没进它的对话：被它的人按停时丢了（core 在 `halt` 和送达里丢掉没读到的请求）。
	 * 不挂在 `agent_end` 上：信还在攒着待送时人按了停，那一轮根本没开，不会有 `agent_end`。收到信的会话在
	 * 读到之前不算闲（攒着待送也算忙），所以闲下来时还没读到，就再也读不到了。
	 */
	function watchUnread(target: AgentSession, letterId: string): void {
		const targetId = target.meta.id;
		void target.whenIdle("foreground").then(() => {
			const asked = outstanding.find((one) => one.id === letterId);
			if (!asked || runs.entry(targetId, letterId) !== undefined || !find(targetId)?.idleInForeground) return;
			answerEach([asked], "dropped", "Its user stopped it before it read your message. Nothing was read and nothing will be answered.");
		});
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
				.map((session) => {
					const doing = currentStep(session);
					return {
						address: address(session),
						sessionId: session.meta.id,
						cwd: session.cwd,
						busy: !session.idleInForeground,
						mode: session.settingsInEffect.permissionMode,
						...(doing ? { doing } : {}),
						waitingOnUser: runs.pending(session.meta.id).length > 0,
					};
				});
		},

		/** 找到一个看得见的会话本身：`read_session` 读它的记录用。 */
		async open(fromId: string, to: string): Promise<Missed | { kind: "found"; target: AgentSession; to: string }> {
			const found = await lookup(fromId, to);
			return found.kind === "found" ? { kind: "found", target: found.target, to: found.to } : found;
		},

		/** 发一封请求，当场返回；答复以后作为一封信送回来。 */
		async ask(fromId: string, input: { to: string; message: string }): Promise<AskOutcome> {
			const found = await lookup(fromId, input.to);
			if (found.kind !== "found") return found;
			const { from, target, to } = found;
			const posted = post(from, target, to, input.message, "request");
			if (posted.kind !== "posted") return posted;
			const mine = outstanding.filter((one) => one.asker === fromId && one.target.id === target.meta.id);
			// 刷到上限的，最旧的那封不再记：它的答复照样会写，只是不再有人为它代答。
			if (mine.length >= OUTSTANDING_PER_PAIR) outstanding = outstanding.filter((one) => one !== mine[0]);
			outstanding.push({ id: posted.letter.id, text: posted.letter.text, chain: posted.letter.chain, asker: fromId, target: { id: target.meta.id, address: to, cwd: target.cwd } });
			watchUnread(target, posted.letter.id);
			return { kind: "sent", to, busy: posted.busy };
		},

		/**
		 * 回答问过来的会话：它发给这边、已经读到、还没答的几封一起答，作为一封信送过去。这时不查权限宽窄：
		 * 回答不是请对方做事。
		 *
		 * 没有待答的信也照送，当作通知、照通知的规矩查：先回一句「稍后做」、做完再回结果，第二句就落在
		 * 这里，报错只会让模型换成 `notify_session` 再发一遍。
		 */
		async reply(fromId: string, input: { to: string; message: string }): Promise<ReplyOutcome> {
			const found = await lookup(fromId, input.to);
			if (found.kind !== "found") return found;
			const { from, target, to } = found;
			const asked = outstanding.filter((one) => one.asker === target.meta.id && one.target.id === fromId && runs.entry(fromId, one.id) !== undefined);
			if (asked.length === 0) {
				const posted = post(from, target, to, input.message, "notice");
				return posted.kind === "posted" ? { kind: "replied", to, answered: 0 } : posted;
			}
			const text = input.message.trim();
			const chain = [...runs.chain(fromId), fromId];
			const refusal = pacer.admit(fromId, target.meta.id, text, chain);
			if (refusal) return { kind: "paced", to, reason: refusal, length: text.length, chain: chain.length };
			answer(asked, "replied", text, chain);
			return { kind: "replied", to, answered: asked.length };
		},

		/** 递一句通知：当场返回，没有答复。 */
		async notify(fromId: string, input: { to: string; message: string }): Promise<NotifyOutcome> {
			const found = await lookup(fromId, input.to);
			if (found.kind !== "found") return found;
			const posted = post(found.from, found.target, found.to, input.message, "notice");
			return posted.kind === "posted" ? { kind: "delivered", to: found.to, busy: posted.busy } : posted;
		},

		/** 这个会话问出去、还没拿到答复的有几封。宿主据此不回收它。 */
		awaitingAnswers(sessionId: string): number {
			return pendingFrom(sessionId);
		},

		/** 这个会话问出去的都拿到答复时兑现；此刻就没有则立刻兑现。 */
		whenAnswered(sessionId: string): Promise<void> {
			if (pendingFrom(sessionId) === 0) return Promise.resolve();
			return new Promise((resolve) => {
				const set = answeredWaiters.get(sessionId) ?? new Set();
				set.add(resolve);
				answeredWaiters.set(sessionId, set);
			});
		},

		/** 每个会话的事件都交过来一份：路由器据此知道哪封信进了哪一次运行、它有没有在等人、该不该代答。 */
		observe(sessionId: string, event: AgentEvent): void {
			runs.observe(sessionId, event);
			if (event.type === "agent_end") afterRun(sessionId);
		},

		/** 人开口了：之后这个会话发出去的信是一条新链，不再接着别人的那条。 */
		personSpoke(sessionId: string): void {
			runs.personSpoke(sessionId);
		},

		/** 会话要被卸载了：问它的、还没拿到答复的，替它说一句「关了」；它自己问出去的不再等。 */
		forget(sessionId: string): void {
			const toIt = outstanding.filter((one) => one.target.id === sessionId);
			if (toIt.length > 0) answerEach(toIt, "closed", "That session was closed before it answered.");
			settle(outstanding.filter((one) => one.asker === sessionId));
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

/**
 * 它清单上正在做的那一项：最近一次 `todo_write` 里 `in_progress` 的那条。`list_sessions` 据此说对方在做什么，
 * 不必为一句「你在做哪一步」叫醒它。
 */
function currentStep(session: AgentSession): string | undefined {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index]!;
		if (message.role !== "assistant") continue;
		for (let part = message.content.length - 1; part >= 0; part--) {
			const block = message.content[part]!;
			if (block.type !== "toolCall" || block.name !== "todo_write") continue;
			const todos = (block.arguments as { todos?: unknown }).todos;
			if (!Array.isArray(todos)) return undefined;
			const step = todos.find((todo): todo is { content: string } => typeof todo === "object" && todo !== null && (todo as { status?: unknown }).status === "in_progress" && typeof (todo as { content?: unknown }).content === "string");
			return step?.content;
		}
	}
	return undefined;
}

/** 太长的截掉，说明截了多少、怎么拿到其余的部分。 */
function clip(text: string): string {
	if (text.length <= REPLY_LIMIT) return text;
	return `${text.slice(0, REPLY_LIMIT)}\n[cut after ${REPLY_LIMIT} characters; ${text.length - REPLY_LIMIT} more not shown. Read the rest with read_session.]`;
}

/** 一封信开头的一截，够认出是哪封。 */
function excerpt(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return [...line].length > 60 ? `${[...line].slice(0, 60).join("")}…` : line;
}
