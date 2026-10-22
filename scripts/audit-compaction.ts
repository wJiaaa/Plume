/**
 * 压缩之后丢了多少，以及缓存隔多久还读得到。`session-audit.ts` 第 13、14 节。
 *
 * 第 12 节量的是压缩花了多少；第 13 节量它丢了多少。折叠掉的那段里读过、之后没改过的文件，压缩后
 * 又被 `read` 一遍，说明摘要和保留的尾部都没让模型确信它已经知道——这是摘要质量里唯一不靠人工判读
 * 的信号。`recall` 是另一面：原文还在，模型知道去取。都只量主会话，子代理的调用不在 `calls` 里。
 *
 * 第 14 节给分叉的「缓存还热」那条线（`FORK_HOT_MS`）找依据：同一前缀隔了多久，服务商还读得到。
 */

import { CACHE_NOISE_FLOOR_TOKENS, type CacheRequestDiagnosis } from "../packages/core/src/runtime/record/cache-diagnostics.ts";
import { KEEP_MIN } from "../packages/core/src/runtime/compaction/compaction-budget.ts";
import { estimateTokens } from "../packages/core/src/tokens.ts";
import type { Message } from "../packages/core/src/types.ts";

interface AuditCall {
	id: string;
	name: string;
	args: unknown;
	/** 发出它的那条助手消息在 `messages` 里的下标。 */
	at: number;
}

/** 一次写下边界的压缩：`at` 是写下时已有多少条消息，`kept` 是从新往旧数留下的条数。 */
export interface AuditBoundary {
	at: number;
	kept: number;
}

export interface AuditStream {
	messages: Message[];
	/** 按日志顺序。 */
	calls: AuditCall[];
	boundaries: AuditBoundary[];
	resultChars(callId: string): number;
}

const median = (values: number[]) => (values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length / 2) - 1] : 0);

function pathOf(call: AuditCall): string | undefined {
	const args = call.args as { path?: unknown; filePath?: unknown } | undefined;
	const path = args?.path ?? args?.filePath;
	return typeof path === "string" ? path : undefined;
}

export function afterCompaction(streams: AuditStream[]) {
	const kept: number[] = [];
	const tailTokens: number[] = [];
	let reads = 0;
	let foldedRereads = 0;
	let foldedRereadChars = 0;
	let recalls = 0;
	for (const stream of streams) {
		const edits = stream.calls.filter((call) => call.name === "edit" || call.name === "write");
		stream.boundaries.forEach((boundary, index) => {
			const keptFrom = Math.max(0, boundary.at - boundary.kept);
			const until = stream.boundaries[index + 1]?.at ?? Number.POSITIVE_INFINITY;
			kept.push(boundary.kept);
			tailTokens.push(estimateTokens(stream.messages.slice(keptFrom, boundary.at)));
			// 折叠掉的那段里每个文件最后一次读在哪；保留的尾部里读过的，压缩后还看得见，不算。
			const lastFolded = new Map<string, number>();
			const visible = new Set<string>();
			for (const call of stream.calls) {
				if (call.at >= boundary.at) break;
				const path = call.name === "read" ? pathOf(call) : undefined;
				if (path === undefined) continue;
				if (call.at < keptFrom) lastFolded.set(path, call.at);
				else visible.add(path);
			}
			const decided = new Set<string>();
			for (const call of stream.calls) {
				if (call.at < boundary.at || call.at >= until) continue;
				if (call.name === "recall") recalls++;
				if (call.name !== "read") continue;
				reads++;
				const path = pathOf(call);
				const last = path === undefined ? undefined : lastFolded.get(path);
				// 每个文件只看压缩后的第一次读；再往后的重读归第 3 节。
				if (path === undefined || last === undefined || visible.has(path) || decided.has(path)) continue;
				decided.add(path);
				// 中间改过的，内容确实变了，重读是对的。
				if (edits.some((edit) => pathOf(edit) === path && edit.at > last && edit.at < call.at)) continue;
				foldedRereads++;
				foldedRereadChars += stream.resultChars(call.id);
			}
		});
	}
	return {
		boundaries: kept.length,
		keptMedian: median(kept),
		keptMin: kept.length ? Math.min(...kept) : 0,
		keptBelowMin: kept.filter((count) => count < KEEP_MIN).length,
		tailTokensMedian: median(tailTokens),
		reads,
		foldedRereads,
		foldedRereadChars,
		recalls,
	};
}

/** 分桶的上沿（毫秒）。第二道线就是 `FORK_HOT_MS`，桶要照着它切才看得出线两侧的差别。 */
export const LIFETIME_BUCKETS = [
	{ label: "≤1m", to: 60_000 },
	{ label: "1m–4.5m", to: 270_000 },
	{ label: "4.5m–10m", to: 600_000 },
	{ label: "10m–1h", to: 3_600_000 },
	{ label: ">1h", to: Number.POSITIVE_INFINITY },
] as const;

interface LifetimeCell {
	hit: number;
	/** 本地前缀核对过没变，服务商没读到。 */
	lost: number;
	/** 旧日志没有前缀记录，分不清是谁的问题。 */
	unproven: number;
}

/**
 * 每个模型、每个间隔桶里，本该命中的请求有几次真的命中。
 *
 * 按模型而不是服务商分：走本地中转时服务商只有一个，缓存寿命取决于中转背后的上游。
 *
 * 只数前缀有理由命中的那些：冷启动、压缩、撤回、换模型和本地改写都不算，它们没命中不说明缓存寿命。
 */
export function cacheLifetime(diagnoses: readonly CacheRequestDiagnosis[]): Map<string, LifetimeCell[]> {
	const byModel = new Map<string, LifetimeCell[]>();
	for (const diagnosis of diagnoses) {
		if (diagnosis.idleMs === undefined || diagnosis.expected <= CACHE_NOISE_FLOOR_TOKENS) continue;
		const kind = diagnosis.cause === "hit" ? "hit" : diagnosis.cause === "provider" ? "lost" : diagnosis.cause === "unknown" ? "unproven" : undefined;
		if (!kind) continue;
		let cells = byModel.get(diagnosis.model);
		if (!cells) byModel.set(diagnosis.model, (cells = LIFETIME_BUCKETS.map(() => ({ hit: 0, lost: 0, unproven: 0 }))));
		cells[LIFETIME_BUCKETS.findIndex((bucket) => diagnosis.idleMs! <= bucket.to)][kind]++;
	}
	return byModel;
}
