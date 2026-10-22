/** Validation for the incremental usage cache. Invalid or old caches are simply rebuilt. */

import { readFile } from "node:fs/promises";
import type { CacheDiagnosisState } from "@plume/core";
import type { UsageBucket, UsageRequestBucket } from "@plume/contract";

/** Everything folded in so far, and where the next pass picks up. */
export interface UsageTally {
	/** The last spend row folded in; the next pass reads what comes after it. */
	afterId: number;
	/** How many rows that was. */
	rows: number;
	buckets: UsageBucket[];
	requests: UsageRequestBucket[];
	/** Per request sequence (`<session>\0main`, `<session>\0sub:<id>`), where diagnosis left off. */
	streams: Record<string, CacheDiagnosisState>;
}

interface UsageCache extends UsageTally {
	version: typeof USAGE_CACHE_VERSION;
	pricingKey: string;
	/** The database `afterId` points into (`SessionStorage.storeId`). */
	source: string;
}

/**
 * 缓存的格式版本。**改了「扫什么」就要加一。**
 *
 * 这张缓存按「读过的行不再读」工作，快是快在这里，代价是它记的是**上一版扫描器的结论**。所以凡是
 * 改变了从一行里读出什么的改动，都必须在这里加一，否则数字永远停在旧口径上——读过的行不会再被重算。
 */
export const USAGE_CACHE_VERSION = 13 as const;

/**
 * Whether this file is a cache this build wrote, for these prices and this database.
 *
 * Only the header and the shape are checked, not every field of every bucket: the file is this
 * process's own output, a format change bumps `USAGE_CACHE_VERSION`, and a write cut short fails at
 * `JSON.parse`. Each of those ends in a rebuild.
 */
function isUsageCache(value: unknown, expectedPricingKey: string, expectedSource: string): value is UsageCache {
	if (typeof value !== "object" || value === null) return false;
	const cache = value as Partial<Record<keyof UsageCache, unknown>>;
	return (
		cache.version === USAGE_CACHE_VERSION &&
		cache.pricingKey === expectedPricingKey &&
		cache.source === expectedSource &&
		typeof cache.afterId === "number" &&
		typeof cache.rows === "number" &&
		Array.isArray(cache.buckets) &&
		Array.isArray(cache.requests) &&
		typeof cache.streams === "object" &&
		cache.streams !== null
	);
}

/** The cached tally, or an empty one to read the table from the top. `source` is the database the cursor must belong to. */
export async function readUsageCache(path: string, expectedPricingKey: string, source: string): Promise<UsageTally> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (isUsageCache(parsed, expectedPricingKey, source)) return { afterId: parsed.afterId, rows: parsed.rows, buckets: parsed.buckets, requests: parsed.requests, streams: parsed.streams };
	} catch {
		// Missing or unreadable: start over.
	}
	return { afterId: 0, rows: 0, buckets: [], requests: [], streams: {} };
}
