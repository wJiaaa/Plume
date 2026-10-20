/**
 * What was actually spent, by day and by model.
 *
 * The session list already carries a total per conversation, and that is the wrong shape for
 * every question worth asking: it is stamped with `updatedAt`, so a refactor spread over three
 * days lands entirely on the third, and it has no idea which model did the spending — which is
 * the one thing you want to know when four relays are configured and one of them is expensive.
 *
 * So every billed call is read from the session database's `spend` table, which is written in the
 * same transaction as the reply that incurred it and is never touched by deleting a conversation —
 * the total here is what was billed, not what happens to still be on disk. The table only grows, so
 * a pass reads just the rows after the last one it folded in (`usage-cache.json`).
 *
 * Side chats need nothing of their own: each is a session (`SessionMeta.parentId`), and its replies
 * are rows here like any other conversation's.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	diagnoseRequest,
	plumeHome,
	markCacheBoundary,
	newCacheDiagnosisState,
	type AssistantMessage,
	type CacheDiagnosisState,
	type ProviderConfig,
	type ReplyTiming,
	type SessionStorage,
	type SpendRow,
} from "@plume/core";
import { freshTokens } from "@plume/core/tokens";
import { readUsageCache, USAGE_CACHE_VERSION, type UsageTally } from "./usage-cache.ts";
import { priceUsage, usagePricingKey, type TokenUsage } from "./usage-pricing.ts";
import type { UsageBucket, UsageRequestBucket, UsageScan } from "./usage-types.ts";

export type { UsageCacheMiss, UsageRequestBucket, UsageScan } from "./usage-types.ts";

/** Local date key, deliberately not ISO/UTC. Mirrors `dayKey` in the settings page. */
function dayKey(ms: number): string {
	const date = new Date(ms);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** `YYYY-MM-DD HH`, local — the request view's unit. */
function hourKey(ms: number): string {
	return `${dayKey(ms)} ${`${new Date(ms).getHours()}`.padStart(2, "0")}`;
}

/**
 * 生成耗时短于这个数的，不拿来算速度。
 *
 * 不流式的中转会把整段回答塞进一个包里，「第一个 token 到最后一个」量出来只有几毫秒，500 个
 * token 除以 3ms 是十几万 token/秒——一条这样的请求就能把一整天的平均速度抬到没法读。它们仍然
 * 算请求、算 token，只是不算「速度」这一项，页面上的「N 次计时」说的就是剩下的那些。
 */
const MIN_STREAM_MS = 100;

/** What the scan knows about a call beyond its usage: how long it took. */
interface CallFacts {
	durationMs?: number;
	sseDurationMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : null;
}

function numberAt(record: Record<string, unknown> | null, key: string): number {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bucketFor(tally: UsageTally, day: string, key: string, provider: string, model: string): UsageBucket {
	const found = tally.buckets.find((each) => each.day === day && each.key === key);
	if (found) return found;
	const fresh: UsageBucket = {
		day,
		key,
		provider,
		model,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		cost: 0,
		inputCost: 0,
		outputCost: 0,
		cacheReadCost: 0,
		cacheWriteCost: 0,
		rawCost: 0,
		cacheSavings: 0,
		providerPricedTokens: 0,
		catalogPricedTokens: 0,
		manualPricedTokens: 0,
		recordedPricedTokens: 0,
		unpricedTokens: 0,
		replies: 0,
	};
	tally.buckets.push(fresh);
	return fresh;
}

type RequestShape = Pick<UsageRequestBucket, "hour" | "provider" | "model">;

const requestKey = (shape: RequestShape) => [shape.hour, shape.provider, shape.model].join("\u0000");

function requestBucketFor(tally: UsageTally, index: Map<string, UsageRequestBucket>, shape: RequestShape): UsageRequestBucket {
	const key = requestKey(shape);
	const found = index.get(key);
	if (found) return found;
	const fresh: UsageRequestBucket = { ...shape, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0, timed: 0, timedOutput: 0, streamMs: 0, firstTokens: 0, firstTokenMs: 0 };
	tally.requests.push(fresh);
	index.set(key, fresh);
	return fresh;
}

function requestIndex(tally: UsageTally): Map<string, UsageRequestBucket> {
	return new Map(tally.requests.map((bucket) => [requestKey(bucket), bucket]));
}

/**
 * The call's timing. Rows written before spend carried it are looked up in `timings`
 * (`${sessionId}\0${timestamp}` → that reply), which is only loaded on a full rebuild.
 */
function factsOf(row: SpendRow, timings: Map<string, ReplyTiming> | null): CallFacts {
	const call = row.call;
	const legacy = call && call.durationMs === undefined && row.sessionId ? timings?.get(`${row.sessionId}\u0000${call.timestamp}`) : undefined;
	return {
		durationMs: call?.durationMs ?? legacy?.durationMs ?? undefined,
		sseDurationMs: call?.sseDurationMs ?? legacy?.sseDurationMs ?? undefined,
	};
}

/**
 * One request sequence's diagnosis state: the main conversation and each sub-agent are separate
 * sequences whose prefixes have nothing to do with each other — the same split `pnpm audit:sessions`
 * makes in its section 10.
 */
function streamOf(tally: UsageTally, row: SpendRow): CacheDiagnosisState {
	return (tally.streams[`${row.sessionId}\u0000${row.stream}`] ??= newCacheDiagnosisState());
}

/** Fold one spend row into the tally. */
function fold(tally: UsageTally, row: SpendRow, providers: ProviderConfig[], facts: CallFacts | null, index: Map<string, UsageRequestBucket>): void {
	if (row.kind !== "call") {
		// A prefix rewritten on purpose — compaction or a rewind — is not a cache miss to explain.
		if (row.stream !== null) markCacheBoundary(streamOf(tally, row), row.kind);
		return;
	}
	const call = row.call;
	if (!call) return;
	const at = call.timestamp || row.ts;
	const usage = asRecord(call.usage);
	const provider = String(row.provider ?? call.provider ?? "unknown");
	const model = String(row.model ?? call.model ?? "unknown");
	const bucket = bucketFor(tally, dayKey(at), `${provider}/${model}`, provider, model);
	const tokens: TokenUsage = {
		input: numberAt(usage, "input"),
		output: numberAt(usage, "output"),
		cacheRead: numberAt(usage, "cacheRead"),
		cacheWrite: numberAt(usage, "cacheWrite"),
	};
	const priced = priceUsage(tokens, usage, providers, provider, model);
	// Fresh tokens, matching what the page reports as its total — these figures are shown as
	// percentages *of* that total, and counting cache reads in one but not the other would
	// put 「未计价」 over 100%.
	const tokenTotal = freshTokens(tokens);
	bucket.input += tokens.input;
	bucket.output += tokens.output;
	bucket.cacheRead += tokens.cacheRead;
	bucket.cacheWrite += tokens.cacheWrite;
	bucket.reasoning += numberAt(usage, "reasoning");
	bucket.cost += priced.cost.total;
	bucket.inputCost += priced.cost.input;
	bucket.outputCost += priced.cost.output;
	bucket.cacheReadCost += priced.cost.cacheRead;
	bucket.cacheWriteCost += priced.cost.cacheWrite;
	bucket.rawCost += priced.rawCost;
	bucket.cacheSavings += priced.cacheSavings;
	if (priced.source === "provider") bucket.providerPricedTokens += tokenTotal;
	else if (priced.source === "catalog") bucket.catalogPricedTokens += tokenTotal;
	else if (priced.source === "manual") bucket.manualPricedTokens += tokenTotal;
	else if (priced.source === "recorded") bucket.recordedPricedTokens += tokenTotal;
	else bucket.unpricedTokens += tokenTotal;
	bucket.replies += 1;
	const request = facts ? requestBucketFor(tally, index, { hour: hourKey(at), provider, model }) : null;
	if (request && facts) foldRequest(request, tokens, priced, call, facts);
	// Side calls (titles, summaries) belong to no request sequence and are not diagnosed.
	if (row.stream === null) return;
	const message = { ...call, provider, model, timestamp: at, usage: { ...tokens, cost: asRecord(usage?.cost) ?? {} } };
	const diagnosis = diagnoseRequest(streamOf(tally, row), message as unknown as AssistantMessage, 0);
	if (diagnosis && diagnosis.missed > 0) {
		for (const target of request ? [bucket, request] : [bucket]) {
			const miss = (target.cacheMiss ??= { tokens: 0, cost: 0, unpriced: 0, byCause: {} });
			miss.tokens += diagnosis.missed;
			if (diagnosis.extraCost === undefined) miss.unpriced += diagnosis.missed;
			else miss.cost += diagnosis.extraCost;
			miss.byCause[diagnosis.cause] = (miss.byCause[diagnosis.cause] ?? 0) + diagnosis.missed;
		}
	}
}

function foldRequest(bucket: UsageRequestBucket, tokens: TokenUsage, priced: ReturnType<typeof priceUsage>, call: NonNullable<SpendRow["call"]>, facts: CallFacts): void {
	bucket.requests += 1;
	bucket.input += tokens.input;
	bucket.output += tokens.output;
	bucket.cacheRead += tokens.cacheRead;
	bucket.cacheWrite += tokens.cacheWrite;
	bucket.cost += priced.cost.total;
	if (priced.source === null) bucket.unpriced += 1;
	// 速度看的是最后成功那一次：`usage` 里还加着前几次失败尝试吐出的 token，而计时只属于最后一次。
	const output = numberAt(asRecord(call.lastAttemptUsage ?? call.usage), "output");
	const stream = facts.sseDurationMs;
	if (stream !== undefined && stream >= MIN_STREAM_MS && output > 0) {
		bucket.timed += 1;
		bucket.timedOutput += output;
		bucket.streamMs += stream;
	}
	if (stream !== undefined && facts.durationMs !== undefined && facts.durationMs >= stream) {
		bucket.firstTokens += 1;
		bucket.firstTokenMs += facts.durationMs - stream;
	}
}

/**
 * Everything spent, by day and by model; and, per day, how many conversations were active.
 *
 * The cache is an optimisation and never a source of truth: one written for other prices or an
 * older version of this reader is discarded and the table read from the top.
 */
export async function scanUsage(store: SessionStorage, home = plumeHome(), providers: ProviderConfig[] = []): Promise<UsageScan> {
	const cachePath = join(home, "usage-cache.json");
	const pricingKey = usagePricingKey(providers);
	const source = await store.storeId();
	const tally = await readUsageCache(cachePath, pricingKey, source);

	/*
	 * 整张重建时才去会话记录里补旧行的计时：增量那几行都是新写的，自己带着。
	 *
	 * 补不到的（会话已删）就是没有——它们照样算请求、算失败与否（按成功算），只是不进「速度」。
	 */
	const index = requestIndex(tally);
	const timings = tally.afterId === 0 ? new Map((await store.replyTimings().catch(() => [])).map((each) => [`${each.sessionId}\u0000${each.timestamp}`, each])) : null;

	// A page at a time: with the cache gone, the whole table would otherwise be one array.
	let scanned = 0;
	for (;;) {
		const rows = await store.readSpend(tally.afterId);
		if (rows.length === 0) break;
		for (const row of rows) fold(tally, row, providers, row.kind === "call" && row.call ? factsOf(row, timings) : null, index);
		tally.afterId = rows.at(-1)?.id ?? tally.afterId;
		scanned += rows.length;
	}
	tally.rows += scanned;

	/*
	 * Best effort: a cache that cannot be written costs a re-read, which is not worth failing over.
	 * 没读到新行就不写：页面开着自动刷新时每几秒扫一次，大多数时候什么都没变。
	 */
	if (scanned > 0) await writeFile(cachePath, JSON.stringify({ version: USAGE_CACHE_VERSION, pricingKey, source, ...tally }), "utf8").catch(() => {});

	return {
		days: await store.activeDays(),
		buckets: [...tally.buckets].sort((a, b) => a.day.localeCompare(b.day)),
		requests: tally.requests,
		scanned,
	};
}
