/**
 * 压缩用到的每一条线，按窗口和开销在这一处算。
 *
 * 从前散在三个文件里各算各的：触发线、只剪枝够不够的余量、保留尾部、尾部删到哪、按条丢弃落到哪、
 * 摘要回复留多少——同一个「8000 / 四分之一窗口」写了三遍。单位也不统一，有的含开销、有的不含，
 * 改一条要同时推演三处。`CompactionBudget` 里除 `trigger` 以外都是历史本身的 token，开销已扣掉。
 *
 * 估算的校准（实测 usage 与字符估算之比）不在这里：两处校准的分母有意不同，见 `compactIfNeeded`。
 */

import type { ModelConfig } from "../../types.ts";

/**
 * Start compacting at this fraction of the context window.
 *
 * 从 80% 提到 90%：一次压缩要付摘要输出、还要整段重写缓存，线靠后压得少。代价是线上方只剩一成——
 * 200k 窗口剩 20k，一步里几个大工具结果就可能越过窗口，那时走超长恢复（`loop.ts`），而超长恢复不分叉。
 */
export const COMPACTION_RATIO = 0.9;
/**
 * OpenCode's leftover-token buffer. Kept as documentation of the A5 decision, not as a trigger.
 *
 * A 20k leftover fires at 37% of a 32k window and spends the rest of a short-context model on
 * summaries. The ratio stays a constant fraction of whatever window the model actually has.
 */
export const COMPACTION_BUFFER_TOKENS = 20_000;
/**
 * How far under the threshold a compaction has to land to count as done.
 *
 * Pruning alone is enough once it lands here, and the tail beside a summary is trimmed only until
 * it does. The number being compared is a product of two estimates and the failure it guards
 * against is silent: a turn that believes it is inside the window, is not, and arrives at the next
 * turn no smaller than before.
 */
const PRUNE_MARGIN = 0.1;
/**
 * How much of the window the verbatim recent tail may occupy.
 *
 * By size rather than by count, because six messages is a small tail in a conversation of short
 * replies and an enormous one when a single tool result is a whole file.
 *
 * This is the number that decides whether recent work survives compaction intact, so it is not
 * pushed lower to win compression: the summary can describe what happened three hours ago, but the
 * file being edited right now has to be there in full or the next turn re-reads it. Everything
 * older is recoverable through `recall`; the current task is what must not need recovering.
 */
const KEEP_BUDGET = 0.12;
/** Never fewer than this, however big they are: the agent cannot work without its last exchange. */
export const KEEP_MIN = 4;
/**
 * Where dropping the oldest turns stops, when there is no summary to keep beside the tail.
 *
 * Well under the threshold that triggers it, and that gap is the point: landing just below the
 * trigger means the next few messages cross it again, so a long run spends its time dropping
 * instead of working. Beside a summary the tail is trimmed to `settled` instead, because what it
 * would cut is the current work: on a 64k window with 17k of prompt and schemas, 30% less the
 * overhead is barely 2k, and the tail used to be cut to its last message.
 */
const SAFE_AFTER = 0.3;
/**
 * How much of the window the summary request itself may occupy.
 *
 * The history being summarised is by definition close to the window — sending it whole asks the
 * model to read more than it can hold, and the request fails. It fails silently, too: a failed
 * summary means "do not compact", so the one mechanism for staying inside the window switched
 * itself off exactly when it was needed. The older turns are condensed to fit this budget first.
 */
export const SUMMARY_INPUT = 0.4;
/** 摘要回复最多要多少：交接用不了四分之一窗口以上，小模型也让不出更多。 */
const SUMMARY_REPLY_MAX = 8000;
const SUMMARY_REPLY_SHARE = 0.25;

/** 摘要请求要给回复留的位置，独立请求和分叉请求是同一个数，发前核对也按它算。 */
export function summaryReplyTokens(model: Pick<ModelConfig, "contextWindow" | "maxOutputTokens">): number {
	return Math.min(SUMMARY_REPLY_MAX, model.maxOutputTokens, Math.floor(model.contextWindow * SUMMARY_REPLY_SHARE));
}

/**
 * 触发线还得给摘要请求留出位置：分叉请求是完整历史加一条指令，摘要要写在窗口剩下的地方。
 *
 * 大窗口上 90% 留下的比这多，这一项不起作用；只在小窗口上把线往前挪——32k 的 90% 只剩 3.2k，
 * 放不下一份 8k 的摘要，分叉请求必然超长，每次都白发一遍再退回独立请求。
 *
 * 大窗口不再往后推到「窗口减固定预留」（opencode、pi 的做法）：每一轮都要按缓存价重读整段前缀，
 * 线越靠后，两次压缩之间的每一轮越贵。推导见 docs/architecture/agent-cost-and-stopping.md 的 A5。
 */
export function summaryHeadroom(contextWindow: number): number {
	return Math.min(SUMMARY_REPLY_MAX, Math.floor(contextWindow * SUMMARY_REPLY_SHARE)) + Math.min(2000, Math.floor(contextWindow / 20));
}

export function compactionTriggerTokens(contextWindow: number): number {
	return Math.max(0, Math.floor(Math.min(contextWindow * COMPACTION_RATIO, contextWindow - summaryHeadroom(contextWindow))));
}

/**
 * 压缩按多大的窗口算：模型有价格分档时，第一条分档线以上不当作可用的窗口。
 *
 * 一次请求的输入越过分档线，这一整次都按高一档计（gpt-6.1-sol 过 272k 输入和缓存读翻倍），之后每一轮
 * 都在线上方，多付的那一倍是确定的；压缩一次的代价是一次摘要。本机 5 天里越线的请求 72 次、$8.12。
 * 把线换算成窗口（触发线正好落在线上），尾部、余量、按条丢弃都跟着按比例缩，不必各自再改一遍。
 * 越线只剩摘要请求本身那一次：它带着触发压缩的那段历史再加一条指令。
 */
export function compactionWindow(model: Pick<ModelConfig, "contextWindow" | "pricing">): number {
	const line = model.pricing?.tiers?.reduce((lowest, tier) => Math.min(lowest, tier.aboveTokens), Infinity) ?? Infinity;
	return line < model.contextWindow * COMPACTION_RATIO ? Math.floor(line / COMPACTION_RATIO) : model.contextWindow;
}

export interface CompactionBudget {
	/** 整份请求（开销加历史）到这里就压。 */
	trigger: number;
	/** 历史落到这以下算压完了：只剪枝落到这里就不摘要，摘要旁的尾部也只删到这里。 */
	settled: number;
	/** 历史最多能占多少还不越线。光开销就占满触发线时不大于 0。 */
	room: number;
	/** 原样保留的尾部最多占多少。 */
	keep: number;
	/** 按条丢弃落到哪。 */
	dropped: number;
}

/**
 * `retiring`：手动压缩时这段对话本身的大小。`/compact` 是要把做完的事收起来，哪怕窗口还很空，
 * 尾部预算按对话而不是窗口算。
 */
export function compactionBudget(model: Pick<ModelConfig, "contextWindow" | "pricing">, overhead: number, retiring?: number): CompactionBudget {
	const contextWindow = compactionWindow(model);
	const trigger = compactionTriggerTokens(contextWindow);
	const keep = contextWindow * KEEP_BUDGET;
	return {
		trigger,
		settled: Math.max(0, trigger - contextWindow * PRUNE_MARGIN - overhead),
		room: trigger - overhead,
		keep: retiring === undefined ? keep : Math.min(keep, retiring * KEEP_BUDGET),
		dropped: Math.max(0, contextWindow * SAFE_AFTER - overhead),
	};
}
