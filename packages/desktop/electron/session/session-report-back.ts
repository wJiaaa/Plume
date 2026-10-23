/**
 * 从建议卡片上开出来、被要求交回的会话（`SpawnedFrom.reportBack`）：第一轮结束时把它最后那段回复
 * 送回提建议的那个对话，和子代理的结果走同一条送达（core 的 `receiveSessionReport`）。
 *
 * 交，要等交给它的那件事做完：第一次 `agent_end` 之后，会话还得闲下来。派了子代理的那一轮当场就
 * 收尾（ADR-0051），那时最后那段话是「已派出，等结果」；从前就在这一刻交回，真正的结论在之后送达的
 * 那几轮里写出来，再也到不了提建议的那个对话。闲下来再送，送的是最后那一轮的话，收场也按最后那一轮
 * 算。边界：这段时间里人在它里面说的话也算进这件事。
 *
 * 交不交、撕条子，仍在第一次 `agent_end` 当场定下，只有「送」往后推：撕条子挪到闲下来之后，那段时间
 * 里退出应用，重启后条子还在，人在里面随便聊的下一轮就会被交回去。
 *
 * 只交第一轮。那是卡片交给它的那件事；之后人在它里面接着聊，每说完一轮都往回送，就是拿别人的对话
 * 去叫醒提建议的那个。所以第一轮无论怎么收场都记一笔 `settled`、撕掉 `reportBack`，重启后也不再交。
 * 被人停下的不交——停下是人的决定，叫醒父会话去处理半截结果是在和这个决定争。出错、跑到上限的照样交，
 * 标成没跑完：父会话在等它，该知道它没做成。
 *
 * 默认关，由模型在 `spawn_session` 里按需打开、人在卡片上改；开始以后、第一轮还在跑时也能改（`set`）。
 * 见 ADR-0049。
 */

import type { AgentEvent, SessionMeta, SpawnedFrom } from "@plume/core";

export interface SessionReport {
	sessionId: string;
	title: string;
	status: "done" | "failed";
	reply: string;
}

export interface ReportBackDeps {
	/** 这个会话此刻的 meta；不在内存里的没有。 */
	meta(sessionId: string): SessionMeta | undefined;
	/** 它此刻在不在跑。 */
	running(sessionId: string): boolean;
	/** 它最后那段回复。 */
	reply(sessionId: string): string;
	/** 它手上什么都没有了（core 的 `AgentSession.whenIdle`）；不在内存里的立刻兑现。 */
	whenIdle(sessionId: string): Promise<void>;
	/** 写一条换了 `spawnedFrom` 的 meta。 */
	write(sessionId: string, from: SpawnedFrom): Promise<void>;
	/** 送到父会话；父会话删了、归档了就不送。 */
	deliver(parentId: string, report: SessionReport): Promise<void>;
}

export interface ReportBack {
	observe(sessionId: string, event: AgentEvent): void;
	/**
	 * 开始以后改主意：第一轮还在跑时打开或关上交回。第一轮已经结束（或根本不是从建议开出来的、
	 * 此刻没在跑）就答 false——那时改什么都不会再交了。
	 */
	set(sessionId: string, on: boolean): Promise<boolean>;
}

export function reportBackAfterFirstTurn(deps: ReportBackDeps): ReportBack {
	// 第一轮在这个进程里已经收过尾的。`write` 是异步的，写下 `settled` 之前同一个会话的下一轮也可能结束。
	const handled = new Set<string>();
	/*
	 * 中途改过的那一份，以内存为准：写 meta 要等一拍，第一轮恰好在这一拍里结束的话，读 meta 会读到改之前的。
	 * 有这一项就听它的，没有才看 meta。
	 */
	const changed = new Map<string, boolean>();
	/** 第一轮结束、在等会话闲下来的，和这段时间里最近那一轮的收场。 */
	const ending = new Map<string, Extract<AgentEvent, { type: "agent_end" }>["reason"]>();
	const plain = (from: SpawnedFrom): SpawnedFrom => ({ sessionId: from.sessionId, toolCallId: from.toolCallId });

	/** 第一轮结束：撕条子，定下交不交。 */
	const settle = async (sessionId: string, from: SpawnedFrom): Promise<boolean> => {
		const wanted = changed.get(sessionId) ?? from.reportBack === true;
		changed.delete(sessionId);
		await deps.write(sessionId, { ...plain(from), settled: true });
		return wanted;
	};

	/** 会话闲下来了：按最后那一轮的收场送出去。被人停下的不送。 */
	const deliver = async (sessionId: string, meta: SessionMeta, from: SpawnedFrom) => {
		const reason = ending.get(sessionId);
		ending.delete(sessionId);
		if (!reason || reason === "aborted") return;
		// 标题可能是这段时间里才起好的。
		const title = deps.meta(sessionId)?.title ?? meta.title;
		await deps.deliver(from.sessionId, { sessionId, title, status: reason === "done" ? "done" : "failed", reply: deps.reply(sessionId) });
	};

	return {
		observe(sessionId, event) {
			if (event.type !== "agent_end") return;
			if (ending.has(sessionId)) {
				ending.set(sessionId, event.reason);
				return;
			}
			if (handled.has(sessionId)) return;
			const meta = deps.meta(sessionId);
			const from = meta?.spawnedFrom;
			if (!meta || !from || from.settled) return;
			handled.add(sessionId);
			// 当场登记：写 meta 那一拍里结束的送达轮也要记到。
			ending.set(sessionId, event.reason);
			const report = async () => {
				if (!(await settle(sessionId, from))) {
					ending.delete(sessionId);
					return;
				}
				await deps.whenIdle(sessionId);
				await deliver(sessionId, meta, from);
			};
			void report().catch((error: unknown) => console.error("[session-report-back] report failed", error));
		},
		async set(sessionId, on) {
			const from = deps.meta(sessionId)?.spawnedFrom;
			if (!from || from.settled || handled.has(sessionId) || !deps.running(sessionId)) return false;
			changed.set(sessionId, on);
			await deps.write(sessionId, on ? { ...plain(from), reportBack: true } : plain(from));
			return true;
		},
	};
}
