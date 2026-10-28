/**
 * 每个会话的运行在事件流里的样子：哪一封信进了哪一次运行、那次运行最后说了什么、怎么收的场、
 * 此刻有没有卡在等人回答上。问别的会话的一方据此等「收到我那封信的那一次运行」。
 *
 * 为什么不是「等对方下一次空闲、取它最后一句」：对方正忙着人交代的事、或同时有别的会话找它时，
 * 下一次空闲之前它可能跑了好几次运行，最后一句回答的是别人。照 synara 的 `wait_for_threads`，
 * 钉住具体的那一次。
 *
 * 一次运行 = `agent_start` 到 `agent_end`。插进来的消息发 `message_start` 时那次运行已经开始，
 * 就算进它；闲着时进来的消息先于 `agent_start` 落盘，算进下一次。开轮之前就被停下的，只有
 * `agent_end` 没有 `agent_start`，当作一次刚开就结束的运行。
 *
 * 请求总是自己开一次（core 排队时一个发件会话一轮），所以那一次最后说的话就是它的回答。通知不开轮、
 * 没人等它的回答，它进了哪一次记下了也没人来取，有用的只是它的链。往来链记在运行上：这一次运行里发出去的信，接的是把它
 * 叫起来的那几封信的链，不是这个会话最近收到的那一封。插进一次已经在跑的运行的信不接：那一次
 * 不是它叫起来的，几个会话各跑一个长回合、互相递通知时，每封都给链加一跳，正常协作半小时就撞上
 * 链长上限，被当成原地来回拦下（2026-10 实测链长 18，其中同一会话出现 8 次）。
 */

import type { AgentEvent } from "@plume/core";

type EndReason = Extract<AgentEvent, { type: "agent_end" }>["reason"];

export interface RunEnd {
	reason: EndReason;
	/** 这次运行里最后一段 assistant 文本。 */
	reply: string;
}

/** 等着人回答的一件事：审批，或模型问人的问题。 */
export interface Pending {
	requestId: string;
	title: string;
	question: boolean;
}

/** 留多少次已结束的运行：够正在等的人取，旧的不再有人问。 */
const KEEP_RUNS = 32;

interface Track {
	seq: number;
	active: boolean;
	replies: Map<number, string>;
	ended: Map<number, EndReason>;
	/** 每封请求进了哪一次运行。 */
	letters: Map<string, number>;
	/** 每次运行接着的往来链：进了这一次的信里最长的那条；人在这一次里开口之后清空。 */
	chains: Map<number, string[]>;
	pending: Map<string, Pending>;
}

export class PeerRuns {
	private readonly tracks = new Map<string, Track>();
	private readonly listeners = new Map<string, Set<() => void>>();

	/** 会话的每一个事件都过这里一遍；只记上面说的那几样。 */
	observe(sessionId: string, event: AgentEvent): void {
		const track = this.track(sessionId);
		switch (event.type) {
			case "agent_start":
				track.seq += 1;
				track.active = true;
				break;
			case "agent_end":
				if (!track.active) track.seq += 1;
				track.active = false;
				track.ended.set(track.seq, event.reason);
				this.prune(track);
				break;
			case "message_start": {
				if (event.message.role !== "user" || !event.message.peer) return;
				const run = track.active ? track.seq : track.seq + 1;
				for (const letter of event.message.peer) {
					if (letter.id) track.letters.set(letter.id, run);
					// 只有叫起这一次的信接链，见文件头。取最长的那条：链是防两边原地来回的，宁可多算一跳。
					if (!track.active && letter.chain && letter.chain.length > (track.chains.get(run)?.length ?? 0)) track.chains.set(run, letter.chain);
				}
				break;
			}
			case "message_end":
				if (event.message.role !== "assistant" || !track.active) return;
				{
					const text = event.message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
					if (text) track.replies.set(track.seq, text);
				}
				break;
			case "approval_request":
				track.pending.set(event.requestId, { requestId: event.requestId, title: event.title, question: Boolean(event.options) });
				break;
			case "approval_settled":
				track.pending.delete(event.requestId);
				break;
			default:
				return;
		}
		this.pulse(sessionId);
	}

	/** 正在跑的那一次（没在跑则为 null）。 */
	current(sessionId: string): number | null {
		const track = this.tracks.get(sessionId);
		return track?.active ? track.seq : null;
	}

	/** 下一次运行的编号：闲着时送进去的东西会开的那一次。 */
	next(sessionId: string): number {
		return (this.tracks.get(sessionId)?.seq ?? 0) + 1;
	}

	/** 这一封进了哪一次运行；还没进对话则为 undefined。 */
	entry(sessionId: string, letterId: string): number | undefined {
		return this.tracks.get(sessionId)?.letters.get(letterId);
	}

	/** 正在跑的那一次接着的往来链；没在跑、或这一次不是信叫起来的，就是空的。 */
	chain(sessionId: string): string[] {
		const track = this.tracks.get(sessionId);
		return (track?.active && track.chains.get(track.seq)) || [];
	}

	/** 人在这个会话里开口了：这一次运行之后发出去的信是一条新链。 */
	personSpoke(sessionId: string): void {
		const track = this.tracks.get(sessionId);
		if (track?.active) track.chains.delete(track.seq);
	}

	/** 这一次运行结束了吗；结束了就带上它怎么收的场、最后说了什么。 */
	ended(sessionId: string, run: number): RunEnd | null {
		const track = this.tracks.get(sessionId);
		const reason = track?.ended.get(run);
		return reason ? { reason, reply: track!.replies.get(run) ?? "" } : null;
	}

	/** 此刻等着人回答的那些。 */
	pending(sessionId: string): Pending[] {
		return [...(this.tracks.get(sessionId)?.pending.values() ?? [])];
	}

	/** 下一次这个会话有动静。 */
	changed(sessionId: string): Promise<void> {
		return new Promise((resolve) => {
			const set = this.listeners.get(sessionId) ?? new Set();
			set.add(resolve);
			this.listeners.set(sessionId, set);
		});
	}

	/** 会话卸载了：等它的人醒来，自己发现它不在了。 */
	forget(sessionId: string): void {
		this.tracks.delete(sessionId);
		this.pulse(sessionId);
	}

	private pulse(sessionId: string): void {
		const set = this.listeners.get(sessionId);
		if (!set) return;
		this.listeners.delete(sessionId);
		for (const resolve of set) resolve();
	}

	private track(sessionId: string): Track {
		let track = this.tracks.get(sessionId);
		if (!track) {
			track = { seq: 0, active: false, replies: new Map(), ended: new Map(), letters: new Map(), chains: new Map(), pending: new Map() };
			this.tracks.set(sessionId, track);
		}
		return track;
	}

	private prune(track: Track): void {
		const floor = track.seq - KEEP_RUNS;
		for (const map of [track.replies, track.ended, track.chains]) for (const run of map.keys()) if (run <= floor) map.delete(run);
		for (const [id, run] of track.letters) if (run <= floor) track.letters.delete(id);
	}
}
