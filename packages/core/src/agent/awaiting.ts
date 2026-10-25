/**
 * 派出去的子代理还没回来时，别让模型抢先交结论。
 *
 * 派出即放手（ADR-0051）之后，`task` 当场交回「已派出」，模型接着做手上的事。量过本机的真实会话：
 * 它接着读上六到八次请求，就把那句话忘了——`b5e6826b` 派完 7 次请求后交了 5580 字的「总体架构」，
 * 31 秒后子代理才回来；`c7cabf5b` 交了 10500 字的结论，两分半后子代理回来，又重写了 5765 字。
 * 结论要等派出去的都回来、合并之后才写，所以这里做三件事：
 *
 * - 隔几次请求把「还在等谁」再说一遍（`AWAIT_EVERY`），话夹在两轮之间跟着下一次请求走，不单独占请求；
 * - 收尾问清单的那一句不问（`turn-checks.ts`）：那一项没勾是因为在等子代理，问了只会逼它把结论提前写出来；
 * - 空回复的催促换一种说法：要的是一句「在等谁」，不是「请给出回答」。
 *
 * 只有主会话给 `AgentControlContext.awaiting`：子代理手里没有 `task`。
 */

import type { AwaitedDispatch } from "./run-config.ts";

/**
 * 多少次带工具的请求没听到「还在等谁」就说一遍。
 *
 * 本机七次「子代理没回来就收尾」里，抢先交结论的那三次分别在派出或送达后的第 6、7、8 次请求。
 * 第 4 次之后说，下一次请求就带上它，最早那次也赶得上；同一批会话里子代理在外面时一共 416 次带
 * 工具的请求，按 4 次一句约一百句，每句几十个 token。
 */
export const AWAIT_EVERY = 4;

export function awaitingNote(pending: readonly AwaitedDispatch[]): string {
	return `（自动提示）派出去的子代理还有 ${pending.length} 个没回来：${names(pending)}。` +
		"在它们回来之前不要给用户写结论或总结：你手上的只是一部分，最终回答等它们都送到、合并之后再写。" +
		"手上还有不依赖它们的事就接着做；做完了就用一两句话告诉用户还在等谁，结束这一轮——它们回来时会自动送到。";
}

export function awaitingEmptyNudge(pending: readonly AwaitedDispatch[]): string {
	return `（自动继续）上一条回复没有正文。派出去的子代理还有 ${pending.length} 个没回来：${names(pending)}。` +
		"用一两句话告诉用户现在在等谁，然后结束这一轮；不要写结论，它们回来时会自动送到。";
}

function names(pending: readonly AwaitedDispatch[]): string {
	return pending.map((one) => `${one.agent}（${one.description}）`).join("、");
}

/** 一次运行一只。名单变了（派了新的、回来了一个）模型当场就看到了，从那儿重新数。 */
export class AwaitWatch {
	private readonly list: () => AwaitedDispatch[];
	private seen = "";
	private since = 0;

	constructor(list: () => AwaitedDispatch[]) {
		this.list = list;
	}

	/** 还在等的那些；没有就是空的。 */
	pending(): AwaitedDispatch[] {
		return this.list();
	}

	/**
	 * 一次带工具的请求跑完了：该不该把「还在等谁」再说一遍。
	 *
	 * 名单变了不说：派出的那一轮工具结果里就是「已派出」，回来的那一份送达里点了名还在等谁。
	 */
	afterTools(): string | undefined {
		const pending = this.list();
		const key = pending.map((one) => one.id).join("\n");
		if (key !== this.seen) {
			this.seen = key;
			this.since = 0;
			return undefined;
		}
		if (pending.length === 0) return undefined;
		this.since += 1;
		if (this.since < AWAIT_EVERY) return undefined;
		this.since = 0;
		return awaitingNote(pending);
	}
}
