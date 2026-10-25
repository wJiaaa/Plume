/**
 * 主会话派出去的子代理：派出即放手，跑完一个送回一个。
 *
 * `task` 当场交回一句「已经派出去了」，这一轮接着走——手上还有不依赖它的事就做，没有就把这一轮
 * 收掉。子代理在后台跑完，结果由运行时作为一条消息送回主会话（`SessionDeliveries`：忙着就插进
 * 这一轮，闲着就开一个新回合），主智能体就这一份说清它带来了什么、还在等谁；全部回来之后再合并。
 *
 * 从前是反过来的：`task` 同步等到子代理交差，只有人插话时才放手（理由是「平时的路一步都不多」）。
 * 换掉它是一次明确的取舍——人要的是每回来一路就看到一路的结论、等的时候能直接跟主智能体说话，
 * 代价是每次送达多一轮请求、多读一遍前缀。攒送达的那 400ms 会把前后脚回来的几份合成一轮。
 * 取舍见 docs/adr/0051-sub-agents-report-one-by-one.md。
 *
 * 「这个会话闲了没有」、送达里点名「还在等谁」，都只认这里的 `outstanding`（见 `AgentSession.idle`）：
 * 派完那一轮收尾时，活其实刚开始。
 *
 * 只管主会话派出去的那一层：子代理手里没有 `task`（见 `dispatch-guard.ts`）。
 */

import type { SubAgentAnswer } from "../../types.ts";

/** 一个放了手的派发跑完了。 */
export interface SettledDispatch {
	id: string;
	answer?: SubAgentAnswer;
	/** 跑到一半抛了——`task` 本来会把它变成一次工具错误，现在只能随结果一起送回去。 */
	error?: string;
}

export class DetachedDispatches {
	/** 放了手、还在后台跑的，按登记 id。跑完了要送回去的就是这些。 */
	private readonly detached = new Set<string>();
	private readonly settled: (report: SettledDispatch) => void;

	/** `settled`：放了手的那个跑完了，把结果送回主会话。 */
	constructor(settled: (report: SettledDispatch) => void) {
		this.settled = settled;
	}

	/** 还在后台跑、跑完要送回来的那些。 */
	get outstanding(): ReadonlySet<string> {
		return this.detached;
	}

	/**
	 * 派出去，当场放手：交回一句「已派出」，结果跑完后经 `settled` 送回。
	 *
	 * `runSubAgent` 在第一个 await 之前就登记了，所以这时 `id()` 已经有了。没有的，是还没上名单
	 * 就被拒了（不认识的类型、续跑不了的 id）或派发时会话已经停了——那就照旧等它，拒绝的理由当场
	 * 作为工具错误交回，而不是晚一轮才送到。
	 */
	dispatch(run: Promise<SubAgentAnswer>, id: () => string | undefined): Promise<SubAgentAnswer> {
		const dispatched = id();
		if (!dispatched) return run;
		this.detached.add(dispatched);
		const settle = (report: Omit<SettledDispatch, "id">) => {
			// 放手之后会话被停过（`forget`）或派发被撤回了（`forgetUnless`），就不再送。
			if (this.detached.delete(dispatched)) this.settled({ id: dispatched, ...report });
		};
		run.then(
			(answer) => settle({ answer }),
			(error: unknown) => settle({ error: error instanceof Error ? error.message : String(error) }),
		);
		return Promise.resolve(dispatchedAnswer(dispatched));
	}

	/** 会话停下了：已经放手的那些不再送回来。它们自己由登记簿停下。 */
	forget(): void {
		this.detached.clear();
	}

	/** 历史被截回去了：派发那一步已经不在历史里的，不再送回来。返回这些 id，它们由登记簿停下。 */
	forgetUnless(kept: (id: string) => boolean): string[] {
		const cut = [...this.detached].filter((id) => !kept(id));
		for (const id of cut) this.detached.delete(id);
		return cut;
	}
}

/**
 * 派出去时交给父会话的那句话。
 *
 * 写给模型的，所以三件事都要说到：它在后台跑（不是失败，也不是结论）；结果会自己回来——不用等、
 * 不用查、不用 `resume`，更不要重派或自己把它的活做一遍；这一轮接下来该怎么收。最要紧的是第二条：
 * 模型只知道「这个任务还没拿到结果」时，最顺手的一步是再派一个、或者自己去读同一批文件。
 *
 * 末尾带上 id，但不提 `resume`：结果会自己送回来，这时候说「用 resume 追问它」正好把模型往重复
 * 派活上引。
 *
 * 「结论也依赖它」要明说：只说「手上还有不依赖它的事就接着做」，模型会把写最终回答也算进去，读完
 * 自己那份就交结论（`awaiting.ts` 顶上的两个会话）。
 */
function dispatchedAnswer(id: string): SubAgentAnswer {
	return {
		text:
			"（已派出，在后台跑。它跑完后，结果会作为一条消息自动送到你这里——不用等它、不用查它的进度、不用 resume，" +
			"也不要重派或自己去做它正在做的事。结论和总结都依赖它的结果：派出去的都回来之前，不要给用户写结论。" +
			"手上还有不依赖它结果的事就接着做，但不要改它负责的文件；做完了或者没有，就用一两句话告诉用户派出去做什么、还在等谁，结束这一轮。）" +
			`\n\n（子代理 id：\`${id}\`。）`,
		id,
		detached: true,
	};
}
