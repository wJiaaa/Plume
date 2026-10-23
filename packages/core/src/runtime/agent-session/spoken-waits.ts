/**
 * 会话的工具在干等别的事时，有人找它就放手。
 *
 * 宿主的工具在等另一个会话做完（`ask_session` / `wait_for_session`，经 `ctx.untilSpokenTo`）：
 * 那件事不归这个会话管，可能要十几分钟，而这期间人说的话、另一个会话的通知都要等它等完才读得到。
 * 所以人一开口就交回 `null`，要不要再等由模型决定。见 ADR-0029。
 *
 * 子代理不走这里：它们派出即放手，本来就不等（`sub-agent/detached-dispatches.ts`）。
 */
export class SpokenWaits {
	/** 正等着的事，每个对应一个「放手」的办法。 */
	private readonly held = new Set<() => void>();
	/** 有人找的话已经排着、还没被读到：这时开始的等待当场放手。 */
	private readonly spoken: () => boolean;

	constructor(spoken: () => boolean) {
		this.spoken = spoken;
	}

	/** 等 `run`；有人找这个会话时放手，交回 `null`。 */
	until<T>(run: Promise<T>): Promise<T | null> {
		return new Promise<T | null>((resolve, reject) => {
			const release = () => {
				if (this.held.delete(release)) resolve(null);
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
			if (this.spoken()) release();
		});
	}

	/** 人开口了：正在等的全部放手。返回放了几个。 */
	release(): number {
		const all = [...this.held];
		for (const release of all) release();
		return all.length;
	}
}
