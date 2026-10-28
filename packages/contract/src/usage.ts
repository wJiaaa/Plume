/**
 * What has been spent and what is being kept: the usage page's numbers, the disk the session logs
 * take and clearing them, and the gallery of generated pictures.
 */

import type { CacheCause, Gallery, UsageReplayRow } from "@plume/core/contract-types";

/**
 * 本该从缓存读到、却按全价重算的那部分，见 core 的 `runtime/record/cache-diagnostics.ts`。
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

/** 一天里最后活动过的那些会话：几条，占多少。 */
export interface StorageDay {
	day: string;
	sessions: number;
	bytes: number;
}

export interface StorageUse {
	/** 会话记录占的字节数。 */
	bytes: number;
	/** 有几条会话。 */
	sessions: number;
	/** 最早、最晚那条会话的最后活动日（本地 `YYYY-MM-DD`）。没有会话时都是 null。 */
	earliest: string | null;
	latest: string | null;
	/**
	 * 按天摊开，好让「选了这一段会删掉什么」在按下去之前就算得出来。
	 *
	 * 不给这个，界面只能拿总数去问「删除全部 303 条？」——而实际上落在所选范围里的可能只有 1 条。
	 * 一个说 4 条却删 1 条的确认框已经够糟；反过来那次就是灾难，而它们是同一个 bug 的两个方向。
	 *
	 * 一天一行而不是一条会话一行：三百条会话摊在六十天里，六十行传过去是几 KB，而按天足够精确
	 * ——范围本来就是按天选的。
	 */
	days: StorageDay[];
}

/**
 * 要删哪一段，两头都含当天。
 *
 * 两个都是 null 就是全部——这是「一键清空」，而不是一个退化的区间。
 */
export interface ClearRange {
	from: string | null;
	to: string | null;
}

export interface ClearResult {
	/** 删掉了几条会话。 */
	removed: number;
	/** 释放了多少字节（按删之前量到的记录大小算）。 */
	freed: number;
	/** 正在跑、所以没动的那几条。 */
	skipped: number;
}

export interface UsageApi {
	/**
	 * Everything spent, by day and by model, read from the session logs.
	 *
	 * Cached between calls against each log's size and mtime, so this is expensive once and
	 * cheap afterwards. The page does its own slicing; see `usage-requests.ts`.
	 */
	scan(): Promise<UsageScan>;
	/** 这些日志在磁盘上占了多少，有几条会话，最早和最晚那条是哪天。 */
	storage(): Promise<StorageUse>;
	/**
	 * 把一段时间里最后活动过的会话删掉，连同它们的聊天记录。
	 *
	 * `{ from: null, to: null }` 是全部。正在跑的会话跳过并在 `skipped` 里报出来——不打断一个
	 * 正在写东西的 agent，也不假装它被删掉了。**没有回收站**，调用方负责在此之前问过。
	 */
	clear(range: ClearRange): Promise<ClearResult>;
	/**
	 * 把整个会话库另存为一个 SQLite 文件：所有会话、连同花销表。
	 *
	 * 存到哪由主进程的保存对话框问，渲染进程不递路径。返回写到的路径，取消了是 null。
	 */
	export(): Promise<string | null>;
}

export interface GalleryApi {
	/**
	 * Every picture `image_generate` drew, in every conversation, with what each was drawn from.
	 *
	 * A conversation is read again only after it has been written to, so asking twice is cheap.
	 */
	list(): Promise<Gallery>;
}
