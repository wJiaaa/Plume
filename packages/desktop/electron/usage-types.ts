/** Data returned by the main-process usage scanner. */

import type { CacheCause, UsageReplayRow } from "@plume/core";

/**
 * 本该从缓存读到、却按全价重算的那部分，见 core 的 `runtime/cache-diagnostics.ts`。
 *
 * 只记有未命中的原因；一次都没漏过的桶不带这一项。
 */
export interface UsageCacheMiss {
	tokens: number;
	/** 有费率的那部分多花的美元，按请求当时存下的费率算。 */
	cost: number;
	/** 没存费率、算不出钱的未命中 token。 */
	unpriced: number;
	byCause: Partial<Record<CacheCause, number>>;
}

/** One day's spend on one model. The unit the page slices every way. */
export interface UsageBucket {
	/** `YYYY-MM-DD`, local. A turn at 23:00 belongs to the day you had it. */
	day: string;
	/** `${provider}/${model}` as the message recorded it, using wire names. */
	key: string;
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number;
	inputCost: number;
	outputCost: number;
	cacheReadCost: number;
	cacheWriteCost: number;
	/** The same request priced as if every cached token were ordinary input. */
	rawCost: number;
	cacheSavings: number;
	providerPricedTokens: number;
	catalogPricedTokens: number;
	manualPricedTokens: number;
	recordedPricedTokens: number;
	unpricedTokens: number;
	/** Replies, which is what token counts belong to. */
	replies: number;
	cacheMiss?: UsageCacheMiss;
}

/**
 * 一小时里、同一个供应商的同一个模型的请求，合在一起。用量页的单位。
 *
 * 不逐条下发：一个月一万多次请求，每次刷新整张表过一遍 IPC，而页面上没有一处要读单独某一次。
 * 按小时合起来，「今天」能按小时画、任意区间能按天画，筛选的每一个维度也都还在键上。子智能体和
 * 标题、摘要这类后台调用也在里面，只是不再单分一维——页面上没有按它们看的地方。
 */
export interface UsageRequestBucket {
	/** `YYYY-MM-DD HH`, local. */
	hour: string;
	provider: string;
	model: string;
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** 查不到价的请求数：页面上的费用因此只能写「≈」。 */
	unpriced: number;
	/** 量得出生成速度的请求数，以及它们的输出 token 与生成耗时之和。见 `usage-scan.ts` 的 `MIN_STREAM_MS`。 */
	timed: number;
	timedOutput: number;
	streamMs: number;
	/** 量得出首字时间的请求数与总毫秒。 */
	firstTokens: number;
	firstTokenMs: number;
	/** 同 `UsageBucket.cacheMiss`，按小时记，好让它也跟着页面上的区间和筛选走。 */
	cacheMiss?: UsageCacheMiss;
}

/** One day, across every model. */
interface UsageDay {
	day: string;
	/** Conversations that said or heard anything that day. */
	sessions: number;
	/** Messages on both sides. */
	messages: number;
}

/** 一个会话一天里在一个模型上做的事，见 core 的 `UsageReplayRow`；归档与否是扫描那一刻的。 */
export interface UsageActivity extends UsageReplayRow {
	archived: boolean;
}

export interface UsageScan {
	days: UsageDay[];
	buckets: UsageBucket[];
	requests: UsageRequestBucket[];
	/** 来自会话记录，删掉的会话不在里面；上面三项来自 spend，删了也在。 */
	activity: UsageActivity[];
	/** How many spend rows were read this time: what the cache saved is what this leaves out. */
	scanned: number;
}
