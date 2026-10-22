import type { Message } from "@plume/core";

/**
 * How the last turn ended, when it ended somewhere short of the end.
 *
 * `"user"` is the stop button: the work is fine, it is just not moving. `"interrupt"` is
 * everything that took the turn away without being asked — a crash, a quit, a machine going to
 * sleep. `"error"` is a request that failed: the relay was out of credentials, the key was
 * refused, the model was gone. `null` is a turn that finished.
 *
 * Three states rather than one because the offer reads differently in each. Being told
 * 「上次执行被中断」 about a pause you performed yourself a second ago is the app describing your
 * own click back to you as an accident; being told it about an HTTP 503 says nothing about the one
 * thing worth knowing, which is that the work is still there.
 */
export type TurnStop = "user" | "interrupt" | "error" | null;

/**
 * Whether the conversation was left mid-turn.
 *
 * Two shapes mean the same thing. A reply still marked `pending` never reached its end; a
 * finished reply whose tool calls have no results was cut off between asking for the tools and
 * running them. Either way the work stopped somewhere it did not choose to.
 *
 * Exported because the tests drive it directly.
 */
export function wasCutShort(transcript: readonly Message[]): boolean {
	const messages = beforePlanTick(transcript);
	/*
	 * A finished turn always ends with the agent saying something.
	 *
	 * Stopping between a tool's result and the reply to it leaves the result as the last message:
	 * the tools all ran, nothing is unanswered, and the old rules below therefore called it
	 * complete — while the one thing the turn was for, the answer, never arrived.
	 */
	if (messages[messages.length - 1]?.role === "toolResult") {
		/*
		 * 除非是工具自己结束了这一轮（`terminate`）：计划交给新会话、不带话地拒绝计划、归档自己。循环有意
		 * 不再要正文，没有回答不是没说完——这时给「继续」，交出计划的会话就会把交出去的活在原地再做一遍。
		 */
		const asked = messages.findLastIndex((message) => message.role === "assistant");
		return !messages.slice(asked + 1).some((message) => message.role === "toolResult" && message.terminate === true);
	}

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "pending") return true;
		const calls = message.content.filter((block) => block.type === "toolCall");
		if (calls.length === 0) return false;
		const answered = new Set(
			messages.slice(i + 1).flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
		);
		return calls.some((call) => call.type === "toolCall" && !answered.has(call.id));
	}
	return false;
}

/**
 * Why a turn ended, as the UI should describe it.
 *
 * The reason lives in two places, and both are needed. `agent_end` carries it exactly, but only
 * while it is happening; the transcript carries it afterwards, in a `stopReason` that survives being
 * written to disk and read back next week. The event wins where they differ, because a turn stopped
 * while a tool was running has already had its last reply settled as `toolUse` and leaves nothing in
 * the log to say who stopped it.
 *
 * A failed request is the case this used to miss entirely, and it was the most common one: the turn
 * ends with an assistant message carrying `stopReason: "error"` and no tool calls, which
 * `wasCutShort` reads as a turn that finished — so nothing was offered.
 */
export function howItStopped(transcript: readonly Message[], reason?: string): TurnStop {
	if (reason === "aborted") return "user";
	/*
	 * A refusal on content ended the turn for good, not halfway: carrying on asks the provider the same
	 * thing and is refused the same way. The refusal row says what happened; nothing offers to resume.
	 */
	const last = transcript.findLast((message) => message.role === "assistant");
	if (last?.role === "assistant" && last.stopReason === "error" && last.failure?.hint === "blocked") return null;
	if (reason === "error") return "error";
	const messages = beforePlanTick(transcript);
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "aborted") return "user";
		if (message.stopReason === "error") return "error";
		break;
	}
	return wasCutShort(messages) ? "interrupt" : null;
}

/**
 * 去掉回答之后补勾清单的那一段：[回答] [运行时问清单（core 的 `openPlanNote`）] [只调 todo_write] [它的结果]。
 *
 * 这一轮停在工具结果上，却不是没说完——回答在它前面已经说完了，循环在补勾之后有意不再要一段正文。
 * 只认这一种形状：同样停在 todo_write 结果上、前面却没有那句运行时的话，仍是真被打断（比如勾完清单
 * 正要写回答时退了应用），回答确实没来。
 */
export function beforePlanTick(messages: readonly Message[]): readonly Message[] {
	let at = messages.length - 1;
	while (ticked(messages[at])) at--;
	if (at === messages.length - 1 || !isPlanTick(messages, at)) return messages;
	return messages.slice(0, at - 1);
}

const ticked = (message: Message | undefined) => message?.role === "toolResult" && message.toolName === "todo_write";

/**
 * `messages[at]` 是不是回答之后补勾清单的那条回复，形状见 `beforePlanTick`。
 *
 * 转录分组也用它：补勾不该在回答下面再画一行。所以它不只在末尾成立——补勾之后人又说了话也算，
 * 但补勾之后模型接着干了活就不算：那是在回答 `openPlanNote` 的「真是漏做了，就接着做完」，
 * 这次 todo_write 是新一段工作的开头。
 */
export function isPlanTick(messages: readonly Message[], at: number): boolean {
	const tick = messages[at];
	if (tick?.role !== "assistant" || !tick.content.some((part) => part.type === "toolCall")) return false;
	if (!tick.content.every((part) => (part.type === "toolCall" ? part.name === "todo_write" : part.type !== "text" || !part.text.trim()))) return false;
	const asked = messages[at - 1];
	const answer = messages[at - 2];
	if (asked?.role !== "user" || !asked.synthetic) return false;
	if (answer?.role !== "assistant" || answer.content.some((part) => part.type === "toolCall")) return false;
	let next = at + 1;
	while (ticked(messages[next])) next++;
	return messages[next]?.role !== "assistant";
}
