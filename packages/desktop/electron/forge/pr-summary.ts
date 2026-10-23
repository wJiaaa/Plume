/**
 * What one row of the pull request list is, and how a GitHub search result becomes one.
 *
 * Separated from the driver that produces it because everything here has a rule in it — which
 * relation a pull request keeps when it matches two searches, what CI's dozen states mean to
 * somebody scanning for red, which of the numbers on a row are real — and a rule that can only be
 * exercised by reaching GitHub is a rule nobody tests.
 */

import type { PullRequestCheck, PullRequestDetail, PullRequestSummary } from "@plume/contract";
import { rowId } from "../../shared/pull-request-id.ts";

/** Enough to see everything current without turning the list into an archive. */
export const PER_BUCKET = 30;

/**
 * How a pull request relates to you, which is the only sensible way to group the list.
 *
 * `reviewing` is what is being asked of you now; `authored` is what you are waiting on; `reviewed`
 * is what you have already had a say in and may want to check back on. The order is the order of
 * urgency, and it decides which relation a pull request keeps when it qualifies for two.
 */
export const BUCKETS = [
	{ relation: "reviewing", query: "is:pr is:open review-requested:@me" },
	{ relation: "authored", query: "is:pr is:open author:@me" },
	{ relation: "reviewed", query: "is:pr is:open reviewed-by:@me" },
] as const;

export type Relation = (typeof BUCKETS)[number]["relation"];

/**
 * All three buckets in one GraphQL query, which is the whole reason this is not `gh search prs`.
 *
 * `gh search prs` goes to the REST search endpoint, and GitHub rate-limits that one far harder
 * than the rest of the API: **30 requests per minute**, separate from and much smaller than the
 * ordinary hourly budget. Three buckets meant three of those thirty spent on every refresh, so a
 * few visits to this screen in quick succession — open it, refresh, come back — ran the list into
 * "API rate limit exceeded" while nothing else on the machine was anywhere near a limit.
 *
 * GraphQL charges against the hourly budget instead (5,000 points an hour; measured, this query
 * costs **1**), and aliases let all three searches travel in a single request. That headroom is
 * what makes the list able to refresh itself on a timer at all.
 *
 * Every field a row draws is asked for here, on purpose. The line counts, the branch, the author's
 * picture and CI's verdict used to arrive only with the detail — so a list showed none of them
 * until you clicked, and filling them in beforehand would have meant one `gh pr view` per row,
 * thirty processes and thirty round trips to decorate rows nobody opened. In a search they are
 * fields on a node that is already being returned, and they cost nothing extra to ask for.
 */
export const SEARCH_QUERY = `
query($reviewing: String!, $authored: String!, $reviewed: String!, $n: Int!) {
  reviewing: search(query: $reviewing, type: ISSUE, first: $n) { nodes { ...row } }
  authored:  search(query: $authored,  type: ISSUE, first: $n) { nodes { ...row } }
  reviewed:  search(query: $reviewed,  type: ISSUE, first: $n) { nodes { ...row } }
}
fragment row on PullRequest {
  number
  title
  url
  state
  isDraft
  createdAt
  updatedAt
  additions
  deletions
  headRefName
  reviewDecision
  author { login avatarUrl(size: 64) }
  repository { nameWithOwner }
  comments { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

/** One row as GraphQL returns it, before the nested counts are flattened. */
export interface SearchNode {
	number: number;
	title: string;
	url: string;
	state?: string;
	isDraft?: boolean;
	createdAt: string;
	updatedAt: string;
	additions?: number;
	deletions?: number;
	headRefName?: string;
	reviewDecision?: string | null;
	author?: { login?: string; avatarUrl?: string } | null;
	repository?: { nameWithOwner?: string } | null;
	comments?: { totalCount?: number } | null;
	commits?: { nodes?: ({ commit?: { statusCheckRollup?: { state?: string } | null } } | null)[] } | null;
}

/**
 * The three buckets out of the search's `data`.
 *
 * Errors are not looked for here: `graphql()` in `github.ts` has already turned an `errors` array
 * delivered with a 200 into a thrown error before there is any `data` to read.
 */
export function parseSearch(data: Record<string, { nodes?: (SearchNode | null)[] } | null> | undefined): Record<Relation, SearchNode[]> {
	const out = {} as Record<Relation, SearchNode[]>;
	for (const { relation } of BUCKETS) {
		// `type: ISSUE` also matches issues, which come back as empty nodes and are dropped.
		out[relation] = (data?.[relation]?.nodes ?? []).filter(
			(node): node is SearchNode => Boolean(node && typeof node.number === "number"),
		);
	}
	return out;
}

/**
 * CI's answer, reduced to what a reviewer scanning a list acts on.
 *
 * Three outcomes, not GitHub's dozen, and the same three the detail pane uses. `EXPECTED` is a
 * check that has been announced and not started, which to a reader is indistinguishable from one
 * that is running.
 */
export function checkStateOf(state: string | null | undefined): PullRequestCheck["state"] | null {
	const raw = (state ?? "").toUpperCase();
	if (!raw) return null;
	if (raw === "SUCCESS") return "pass";
	if (raw === "FAILURE" || raw === "ERROR") return "fail";
	return "pending";
}

export function toSummary(node: SearchNode, relation: Relation, accountId: string): PullRequestSummary {
	const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;

	return {
		accountId,
		repo: node.repository?.nameWithOwner ?? "",
		number: node.number,
		title: node.title,
		author: node.author?.login ?? "unknown",
		avatarUrl: node.author?.avatarUrl ?? null,
		state: (node.state ?? "open").toUpperCase(),
		isDraft: node.isDraft === true,
		url: node.url,
		createdAt: node.createdAt,
		updatedAt: node.updatedAt,
		comments: node.comments?.totalCount ?? 0,
		relation,
		additions: typeof node.additions === "number" ? node.additions : null,
		deletions: typeof node.deletions === "number" ? node.deletions : null,
		headRefName: node.headRefName || null,
		checkState: checkStateOf(rollup),
		reviewDecision: node.reviewDecision || null,
	};
}

/**
 * One row per pull request.
 *
 * The buckets overlap by design — your own can also be one you reviewed — so the first bucket to
 * claim a pull request keeps it, which is what makes `BUCKETS` order meaningful rather than
 * incidental. Every host with more than one bucket goes through here.
 */
export function dedupe(buckets: PullRequestSummary[][]): PullRequestSummary[] {
	const seen = new Map<string, PullRequestSummary>();
	for (const bucket of buckets) {
		for (const pr of bucket) {
			const key = rowId(pr);
			if (!seen.has(key)) seen.set(key, pr);
		}
	}
	return [...seen.values()];
}

/** The order the list is drawn in, across every account: by when each one last moved. */
export function newestFirst(rows: PullRequestSummary[]): PullRequestSummary[] {
	return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * A host's checks, as the detail pane's counts and the one mark a row draws.
 *
 * Which raw state means pass, fail or pending is each host's own table and stays in its driver;
 * counting the three and picking the mark is the same everywhere. No checks at all is null, which
 * is a different thing from "none have finished".
 */
export function summarizeChecks(items: PullRequestCheck[]): Pick<PullRequestDetail, "checks" | "checkState"> {
	if (items.length === 0) return { checks: null, checkState: null };
	const count = (state: PullRequestCheck["state"]) => items.filter((check) => check.state === state).length;
	const failed = count("fail");
	const pending = count("pending");
	return {
		checks: { total: items.length, passed: count("pass"), failed, pending, items },
		checkState: failed > 0 ? "fail" : pending > 0 ? "pending" : "pass",
	};
}
