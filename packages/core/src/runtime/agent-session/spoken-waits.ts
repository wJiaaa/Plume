/**
 * 会话的工具在干等别的事时，有人找它就放手。
 *
 * 宿主的工具在等另一个会话做完（`ask_session` / `wait_for_session`，经 `ctx.untilSpokenTo`）：
 * 那件事不归这个会话管，可能要十几分钟，而这期间人说的话、另一个会话的通知都要等它等完才读得到。
 * 所以有人找就交回 `{ spokenTo }`，要不要再等由模型决定。见 ADR-0029。
 *
 * 交回时说清是谁找：人开口和另一个会话递来通知是两回事。不分的时候，被通知打断的等待一律告诉模型
 * 「你的用户说话了」，它就去回应一个没说话的人。
 *
 * 子代理不走这里：它们派出即放手，本来就不等（`sub-agent/detached-dispatches.ts`）。
 */
export type SpokenBy = "person" | "notice";

/** 等待被打断：谁找了这个会话。 */
export interface SpokenTo {
	spokenTo: SpokenBy;
}

export class SpokenWaits {
	/** 正等着的事，每个对应一个「放手」的办法。 */
	private readonly held = new Set<(by: SpokenBy) => void>();
	/** 有人找的话已经排着、还没被读到：这时开始的等待当场放手。人的话优先于通知。 */
	private readonly spoken: () => SpokenBy | null;

	constructor(spoken: () => SpokenBy | null) {
		this.spoken = spoken;
	}

	/** 等 `run`；有人找这个会话时放手，交回是谁找的。 */
	until<T>(run: Promise<T>): Promise<T | SpokenTo> {
		return new Promise<T | SpokenTo>((resolve, reject) => {
			const release = (by: SpokenBy) => {
				if (this.held.delete(release)) resolve({ spokenTo: by });
			};
			this.held.add(release);
			run.then(
				(value) => {
					if (this.held.delete(release)) resolve(value);
				},
				(error: unknown) => {
					if (this.held.delete(release)) reject(error);
				},
			);
			const by = this.spoken();
			if (by) release(by);
		});
	}

	/** 有人找：正在等的全部放手。返回放了几个。 */
	release(by: SpokenBy): number {
		const all = [...this.held];
		for (const release of all) release(by);
		return all.length;
	}
}
