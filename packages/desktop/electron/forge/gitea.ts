/**
 * Gitea and Forgejo, which are the same API and therefore one driver.
 *
 * The friendliest of the four to a screen like this: `/repos/issues/search` answers all three
 * buckets by name — `review_requested`, `created`, `reviewed` — so the list is three small
 * requests with no client-side guessing, and `.diff` hands over a patch the app already parses.
 *
 * The one thing it will not do is decorate a row. That search returns issues, and an issue knows
 * nothing about branches, line counts or CI even when it happens to be a pull request. Those
 * arrive when the row is opened, which is the same trade every host makes — just drawn at a
 * different line.
 */

import { parseUnifiedDiff } from "./diff-parse.ts";
import type {
	PullRequestCheck,
	PullRequestDetail,
	PullRequestSummary,
	ReviewVerdict,
	WorkspaceDiffFile,
} from "@plume/contract";
import { dedupe, PER_BUCKET, type Relation, summarizeChecks } from "./pr-summary.ts";
import { DIFF_TIMEOUT_MS, identifyUser, json, text } from "./http.ts";
import { splitRepo } from "./accounts.ts";
import { type RawComment, type RawCommit, toCommits, toThreads } from "./rest-v3.ts";
import type { ForgeConnection, ForgeDriver } from "./types.ts";

/** The three buckets, each a flag this search already has. */
const BUCKETS: { relation: Relation; flag: string }[] = [
	{ relation: "reviewing", flag: "review_requested" },
	{ relation: "authored", flag: "created" },
	{ relation: "reviewed", flag: "reviewed" },
];

interface RawIssue {
	number: number;
	title: string;
	state?: string;
	html_url: string;
	created_at: string;
	updated_at: string;
	comments?: number;
	user?: { login?: string; avatar_url?: string } | null;
	repository?: { full_name?: string; owner?: string; name?: string } | null;
	pull_request?: { draft?: boolean; merged?: boolean } | null;
}

interface RawPull {
	number: number;
	title: string;
	body?: string;
	state?: string;
	draft?: boolean;
	merged?: boolean;
	mergeable?: boolean;
	html_url: string;
	created_at: string;
	updated_at: string;
	comments?: number;
	additions?: number;
	deletions?: number;
	changed_files?: number;
	user?: { login?: string; avatar_url?: string } | null;
	head?: { ref?: string; sha?: string } | null;
	base?: { ref?: string } | null;
	labels?: { name?: string }[] | null;
	requested_reviewers?: ({ login?: string } | null)[] | null;
}

function repoOf(issue: RawIssue): string {
	const full = issue.repository?.full_name;
	if (full) return full;
	const { owner, name } = issue.repository ?? {};
	if (owner && name) return `${owner}/${name}`;
	// Last resort, and it holds for every Gitea URL: /owner/name/pulls/12.
	try {
		const parts = new URL(issue.html_url).pathname.split("/").filter(Boolean);
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "";
	} catch {
		return "";
	}
}

function toSummary(issue: RawIssue, repo: string, relation: Relation, accountId: string): PullRequestSummary {
	return {
		accountId,
		repo,
		number: issue.number,
		title: issue.title,
		author: issue.user?.login ?? "unknown",
		avatarUrl: issue.user?.avatar_url ?? null,
		state: (issue.state ?? "open").toUpperCase(),
		isDraft: issue.pull_request?.draft === true,
		url: issue.html_url,
		createdAt: issue.created_at,
		updatedAt: issue.updated_at,
		comments: issue.comments ?? 0,
		relation,
		// The search answers about issues; a pull request's numbers arrive with the detail.
		additions: null,
		deletions: null,
		headRefName: null,
		checkState: null,
		reviewDecision: null,
	};
}

export const gitea: ForgeDriver = {
	kind: "gitea",

	identify: (conn) => identifyUser(conn, { login: "login", name: "full_name" }),

	async list(conn: ForgeConnection): Promise<PullRequestSummary[]> {
		const buckets = await Promise.all(
			BUCKETS.map(({ relation, flag }) =>
				json<RawIssue[]>(conn, "/repos/issues/search", {
					query: { type: "pulls", state: "open", [flag]: true, limit: PER_BUCKET },
				}).then((list) => ({ relation, list: list ?? [] })),
			),
		);

		// The first bucket to claim a pull request keeps it — the order is the order of urgency.
		return dedupe(
			buckets.map(({ relation, list }) =>
				list.flatMap((issue) => {
					const repo = repoOf(issue);
					return repo ? [toSummary(issue, repo, relation, conn.account.id)] : [];
				}),
			),
		);
	},

	async detail(conn: ForgeConnection, repo: string, number: number): Promise<PullRequestDetail> {
		const { owner, name } = splitRepo(repo);
		const at = `/repos/${owner}/${name}`;
		const pull = await json<RawPull>(conn, `${at}/pulls/${number}`);

		const [comments, reviews, commits, status] = await Promise.all([
			json<RawComment[]>(conn, `${at}/issues/${number}/comments`, { query: { limit: 100 } }).catch(() => []),
			json<RawReview[]>(conn, `${at}/pulls/${number}/reviews`, { query: { limit: 50 } }).catch(() => []),
			json<RawCommit[]>(conn, `${at}/pulls/${number}/commits`, { query: { limit: 100 } }).catch(() => []),
			pull.head?.sha
				? json<RawStatus>(conn, `${at}/commits/${pull.head.sha}/status`).catch(() => null)
				: Promise.resolve(null),
		]);

		// A review with no verdict is a comment on the conversation, and Gitea files those here as
		// well as under comments — counting both would double every reviewer who typed something.
		const verdicts = (reviews ?? []).filter((review) => review.state && review.state !== "PENDING");

		return {
			accountId: conn.account.id,
			repo,
			number: pull.number,
			title: pull.title,
			author: pull.user?.login ?? "unknown",
			avatarUrl: pull.user?.avatar_url ?? null,
			state: (pull.state ?? "open").toUpperCase(),
			isDraft: pull.draft === true,
			url: pull.html_url,
			createdAt: pull.created_at,
			updatedAt: pull.updated_at,
			relation: "authored",
			reviewDecision: verdictOf(verdicts),
			...summarizeChecks((status?.statuses ?? []).map(toCheck)),
			body: pull.body ?? "",
			additions: pull.additions ?? null,
			deletions: pull.deletions ?? null,
			changedFiles: pull.changed_files ?? null,
			headRefName: pull.head?.ref ?? "",
			baseRefName: pull.base?.ref ?? "",
			comments: comments?.length ?? pull.comments ?? 0,
			threads: toThreads(comments ?? []),
			reviews: verdicts.map((review) => ({
				author: review.user?.login ?? "unknown",
				state: review.state ?? "COMMENT",
				body: review.body ?? "",
				submittedAt: review.submitted_at ?? "",
			})),
			reviewers: [
				...(pull.requested_reviewers ?? []).map((r) => ({ login: r?.login ?? "", state: "REQUESTED" })),
				...verdicts.map((r) => ({ login: r.user?.login ?? "", state: r.state ?? "COMMENT" })),
			].filter((r) => r.login),
			mergeable: pull.merged ? "MERGED" : pull.mergeable === false ? "CONFLICTING" : "MERGEABLE",
			labels: (pull.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
			commits: toCommits(commits ?? []),
		};
	},

	async diff(conn: ForgeConnection, repo: string, number: number): Promise<WorkspaceDiffFile[]> {
		const { owner, name } = splitRepo(repo);
		const raw = await text(conn, `/repos/${owner}/${name}/pulls/${number}.diff`, {
			accept: "text/plain",
			timeoutMs: DIFF_TIMEOUT_MS,
		});
		return parseUnifiedDiff(raw);
	},

	async comment(conn: ForgeConnection, repo: string, number: number, body: string): Promise<void> {
		const { owner, name } = splitRepo(repo);
		await json(conn, `/repos/${owner}/${name}/issues/${number}/comments`, { method: "POST", body: { body } });
	},

	async review(conn: ForgeConnection, repo: string, number: number, verdict: ReviewVerdict, body: string): Promise<void> {
		const { owner, name } = splitRepo(repo);
		const event = verdict === "approve" ? "APPROVED" : verdict === "request-changes" ? "REQUEST_CHANGES" : "COMMENT";
		await json(conn, `/repos/${owner}/${name}/pulls/${number}/reviews`, { method: "POST", body: { event, body } });
	},
};

/**
 * The overall verdict, from the reviews that carry one.
 *
 * A rejection outranks an approval regardless of order, because that is what it means to the
 * person who has to act on it: one outstanding change request is a pull request that is not going
 * anywhere, however many approvals sit beside it.
 */
function verdictOf(reviews: RawReview[]): string | null {
	if (reviews.some((r) => r.state === "REQUEST_CHANGES")) return "CHANGES_REQUESTED";
	if (reviews.some((r) => r.state === "APPROVED")) return "APPROVED";
	return null;
}

/** One commit status, in the three outcomes a reviewer acts on. */
function toCheck(entry: RawStatusEntry): PullRequestCheck {
	const raw = (entry.status ?? "").toLowerCase();
	const state = raw === "success" ? "pass" : raw === "failure" || raw === "error" ? "fail" : "pending";
	return { name: entry.context?.trim() || "检查", state, ...(entry.target_url ? { url: entry.target_url } : {}) };
}

interface RawReview {
	state?: string;
	body?: string;
	submitted_at?: string;
	user?: { login?: string } | null;
}

interface RawStatusEntry {
	context?: string;
	status?: string;
	target_url?: string;
}

interface RawStatus {
	statuses?: RawStatusEntry[];
}
