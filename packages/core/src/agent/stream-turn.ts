/**
 * Streaming one assistant reply: one request, its retries, and how it ends.
 *
 * Separate from the loop because it answers a different question. The loop decides whether there is
 * another round; this turns one request into one settled message and the events the window draws.
 * Why each exit is shaped the way it is: docs/architecture/agent-loop.md.
 */

import type { AgentEventSink } from "./events.ts";
import type { AgentModelContext } from "./run-config.ts";
import { streamAssistant } from "../ai/index.ts";
import { comparePrefix, payloadSegments, type PrefixSegment } from "../ai/prefix-fingerprint.ts";
import { lastSegments, recordSegments, recordSent } from "./lineage.ts";
import { contextMaxTokens, requestPrompt } from "../tokens.ts";
import type { AssistantMessage, LlmContext } from "../types.ts";

/** One assistant turn. */
export interface TurnResult {
	message: AssistantMessage;
	/** The model was switched before this request said anything; redo it from the same point. */
	switched?: boolean;
	/**
	 * A reply the far end rejected (`rejectedContent`), not yet committed (no `message_end`).
	 *
	 * The caller either recovers and `discard`s it, or gives up and `commit`s it. Committing first
	 * puts a failed reply in the log that the loop's view does not have, and the compaction
	 * boundary — counted from the log's tail — lands one message off.
	 */
	held?: { commit(): Promise<void>; discard(): Promise<void> };
}

/**
 * Whether a reply failed because the far end would not accept the request as posted.
 *
 * Narrow on purpose: a 401, 404 or 429 does not improve with a smaller history. Reads the failure
 * classification, never the wording of `errorMessage` — that line is for people and changes.
 */
export function rejectedContent(assistant: AssistantMessage): boolean {
	if (assistant.stopReason !== "error" || assistant.errorRetryable) return false;
	return assistant.failure?.hint === "check-request";
}

/**
 * What the request borrows from outside the `model` group: the run's stop signal, and the session
 * state the previous request's prefix is kept in (none, no comparison).
 */
export interface StreamScope {
	signal: AbortSignal | undefined;
	state: Map<string, unknown> | undefined;
}

export async function streamTurn(modelConfig: AgentModelContext, context: LlmContext, scope: StreamScope, emit: AgentEventSink): Promise<TurnResult> {
	modelConfig.onContext?.(context, modelConfig.model);
	const requested = modelConfig.maxTokens;
	// Recalculate after compaction, model switches and payload recovery, for injected streams too.
	modelConfig = { ...modelConfig, maxTokens: contextMaxTokens(modelConfig.model, context, modelConfig.maxTokens) };
	const { state } = scope;
	await emit({ type: "request", provider: modelConfig.provider.id, model: modelConfig.model.modelId, thinking: modelConfig.thinking, messageCount: context.messages.length });
	// 压缩从这一次分叉：记下请求头，折算前的输出上限（分叉时按同一算法再折一次），见 `lineage.ts`。
	if (state) recordSent(state, {
		providerId: modelConfig.provider.id, modelId: modelConfig.model.id,
		systemPrompt: context.systemPrompt, tools: context.tools,
		thinking: modelConfig.thinking, temperature: modelConfig.temperature, maxTokens: requested,
		cacheKey: modelConfig.cacheKey, at: Date.now(),
	});

	/*
	 * A model switch has its own controller: it means "redo with someone else", not "stop", so it
	 * must not be confused with `scope.signal`. Only a request that has not said anything yet
	 * (connecting, retrying) is let go — that is exactly when a person switches away from a broken
	 * upstream. See ADR-0025.
	 */
	const switchAbort = new AbortController();
	let said = false;
	const unsubscribe = modelConfig.liveModel?.onChange(() => {
		const wanted = modelConfig.liveModel?.current();
		if (!said && wanted && wanted.model.id !== modelConfig.model.id) switchAbort.abort();
	});
	const switched = () => switchAbort.signal.aborted && !scope.signal?.aborted;
	const signal = AbortSignal.any([...(scope.signal ? [scope.signal] : []), switchAbort.signal]);

	if (modelConfig.streamFn) {
		try {
			// The stand-in gets the same switch-aware signal, so switching is testable through it.
			const { provider, model, thinking, maxTokens, temperature, cacheKey } = modelConfig;
			const message = await modelConfig.streamFn(context, { provider, model, thinking, maxTokens, temperature, cacheKey, signal });
			if (switched()) return { message, switched: true };
			if (rejectedContent(message)) {
				const commit = async () => {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
				};
				return { message, held: { commit, discard: async () => {} } };
			}
			await emit({ type: "message_start", message });
			await emit({ type: "message_end", message });
			return { message };
		} finally {
			unsubscribe?.();
		}
	}

	/*
	 * Retries of *this request*. The two nested retry layers (`fetchWithRetry`, `retryStream`) each
	 * number from 1, and passing theirs through made the line on screen count 1, 2, 1, 1, 2.
	 */
	let retries = 0;
	/*
	 * 最近那次重试还没有下文。接上以后第一段内容一到就说「恢复了」，不等这条回复写完：长回复要写好几
	 * 分钟，那段时间里屏幕一直说「正在重试」，而连接早就好了。之后再断，就是新的一次。
	 */
	let pending = false;
	/*
	 * 这一次中断开始时 `retries` 是多少。界面上「第 N 次」「重试 N 次后恢复」说的是这一次中断，
	 * 接上过又断，就从 1 数起——按整个请求累计，第二次断线只重试了一回，屏幕上却说「重试 2 次后恢复」。
	 */
	let base = 0;
	const attempts = () => retries - base;

	/*
	 * Where the prefix first differs from the previous request, stamped on the reply as evidence for
	 * cache misses (`ai/prefix-fingerprint.ts`). The baseline only advances on requests the cache
	 * diagnostics also count (`requestPrompt`), so both compare the same pair.
	 */
	let sent: PrefixSegment[] | undefined;
	let prefix: AssistantMessage["prefix"] | null = null;
	const stamp = (message: AssistantMessage): AssistantMessage => {
		if (prefix === null && sent && state) {
			const previous = lastSegments(state);
			prefix = previous ? comparePrefix(previous, sent) : undefined;
			if (requestPrompt(message) > 0) recordSegments(state, sent);
		}
		if (prefix) message.prefix = prefix;
		return message;
	};
	const stream = stamped(streamAssistant(modelConfig.provider, modelConfig.model, context, {
		onPayload: state ? (body) => { sent = payloadSegments(body); } : undefined,
		signal,
		thinking: modelConfig.thinking,
		maxTokens: modelConfig.maxTokens,
		temperature: modelConfig.temperature,
		retryAttempts: modelConfig.retryAttempts,
		retryPolicy: modelConfig.retryPolicy,
		cacheKey: modelConfig.cacheKey,
		// Said out loud: seconds of silence while retrying are indistinguishable from a hang.
		onRetry: ({ delayMs, reason, failure }) => {
			if (!pending) base = retries;
			retries += 1;
			pending = true;
			/*
			 * 重试从头再来（`retryStream` 先 `reset`），上一次尝试写出的那截不会留下，这个请求又回到「还
			 * 什么都没说」：这时人换模型，就该放手。不复位的话，流中途断过一次之后切模型永远不生效，
			 * 而网络重试默认没有上限。
			 */
			said = false;
			void emit({ type: "retry", attempt: attempts(), delayMs, reason, failure });
		},
	}), stamp);

	let started = false;

	/*
	 * 写完了的正文块，和最近一份流式快照。
	 *
	 * `text_end` 不带快照，也从来没转发过：正文写完到这条回复收尾之间，界面收不到任何东西，分不清是写完了
	 * 还是停住了（有的网关在这里空一两秒）。所以拿最近那份快照转发一次，之后每次转发都给这些块标上
	 * `ended`。只标在发出去的副本上：适配器原地改块、快照是浅拷贝，块的身份一路不变，用它认；
	 * 适配器手里那份和最终消息不带这个标记，存盘、回放都照旧。
	 */
	const ended = new WeakSet<object>();
	let latest: AssistantMessage | undefined;
	const marked = (message: AssistantMessage): AssistantMessage =>
		message.content.some((block) => ended.has(block))
			? { ...message, content: message.content.map((block) => (block.type === "text" && ended.has(block) ? { ...block, ended: true as const } : block)) }
			: message;

	/*
	 * How the interruption ended. Only a clean success with no retry still pending has nothing to
	 * say (a recovery already reported on the first delta is not reported twice) — a failure
	 * that was never retried (bad key, wrong model name) must still be reported, or the window is
	 * left silent with no record of what happened.
	 */
	const settle = async (message: AssistantMessage) => {
		const failed = message.stopReason === "error";
		if (!pending && !failed) return;
		pending = false;
		await emit({
			type: "retry_settled",
			// 等重试的时候被人停下：既没接上也没放弃，说成「已恢复」是在报一件没发生的事。
			outcome: failed ? "gave_up" : message.stopReason === "aborted" ? "stopped" : "recovered",
			attempts: attempts(),
			failure: message.failure,
		});
	};

	/*
	 * Let go of the request for a model switch. Nothing reaches the transcript — an empty "stopped"
	 * bubble would read as the person pressing stop. A stream that had started (headers in, nothing
	 * said yet, or only a retried attempt's discarded text) is withdrawn with `message_discarded`,
	 * not committed: the loop does not keep a switched reply, and a log one message longer than the
	 * loop's view puts the compaction boundary one message off (see `TurnResult.held`). The
	 * reconnect line is closed honestly: not recovered, switched.
	 */
	const letGo = async (message: AssistantMessage): Promise<TurnResult> => {
		if (started) await emit({ type: "message_discarded", message });
		if (pending) {
			const to = modelConfig.liveModel?.current()?.model.name;
			await emit({ type: "retry_settled", outcome: "switched", attempts: attempts(), ...(to ? { switchedTo: to } : {}) });
		}
		return { message, switched: true };
	};

	try {
	while (true) {
		const next = await stream.next();
		if (next.done) {
			if (switched()) return await letGo(next.value);
			await settle(next.value);
			return { message: next.value };
		}
		const event = next.value;

		switch (event.type) {
			case "start":
				started = true;
				await emit({ type: "message_start", message: event.partial });
				break;
			case "text_delta":
			case "thinking_delta":
			case "toolcall_delta":
			case "toolcall_end":
				said = true;
				latest = event.partial;
				if (pending) {
					pending = false;
					await emit({ type: "retry_settled", outcome: "recovered", attempts: attempts() });
				}
				await emit({ type: "message_update", message: marked(event.partial), delta: event });
				break;
			case "text_end": {
				// 同一时刻只有一段正文在写，写完的就是最后那段。
				const block = latest?.content.findLast((candidate) => candidate.type === "text");
				if (!latest || !block) break;
				ended.add(block);
				await emit({ type: "message_update", message: marked(latest), delta: event });
				break;
			}
			case "done":
			case "error": {
				const message = event.message;
				if (switched()) {
					const tail = await stream.next();
					return await letGo(tail.done ? tail.value : message);
				}
				if (rejectedContent(message)) {
					const tail = await stream.next();
					const settled = tail.done ? tail.value : message;
					return {
						message: settled,
						held: {
							commit: async () => {
								if (!started) await emit({ type: "message_start", message: settled });
								await emit({ type: "message_end", message: settled });
								await settle(settled);
							},
							// The resend that follows is the outcome; a never-retried rejection reports nothing.
							discard: async () => {
								if (started) await emit({ type: "message_discarded", message: settled });
								if (pending) await settle(settled);
							},
						},
					};
				}
				if (!started) await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				// Drain the generator so its `return` value is the authoritative final message.
				const tail = await stream.next();
				const settled = tail.done ? tail.value : message;
				await settle(settled);
				return { message: settled };
			}
			default:
				break;
		}
	}
	} finally {
		unsubscribe?.();
	}
}

/** Run the closing messages (in `done`/`error` events and the return value) through `stamp`. */
async function* stamped(
	stream: ReturnType<typeof streamAssistant>,
	stamp: (message: AssistantMessage) => AssistantMessage,
): ReturnType<typeof streamAssistant> {
	while (true) {
		const next = await stream.next();
		if (next.done) return stamp(next.value);
		if (next.value.type === "done" || next.value.type === "error") stamp(next.value.message);
		yield next.value;
	}
}
