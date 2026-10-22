/**
 * The two GraphQL questions this app asks GitHub, and what the answers mean.
 *
 * GraphQL rather than REST for both, and for the same reason each time: the detail pane wants
 * eight things about one pull request — description, comments, reviews, requested reviewers, CI,
 * commits, labels, mergeability — and REST answers each of those from a different endpoint. That
 * was seven round trips per row you clicked, against a hosted API with an hourly budget. This is
 * one, and it costs a single point of five thousand.
 *
 * The search half lives in `pr-summary.ts` next door, which predates this file and has the tests.
 */

import type { PullRequestCheck, PullRequestDetail } from "@plume/contract";

/**
 * Everything the detail pane draws, for one pull request.
 *
 * `commits` appears twice under two aliases because two different questions need it: the last one
 * carries CI's verdict, and the first hundred are the timeline. Asking for a hundred and reading
 * the rollup off the end would work and would also transfer a hundred check rollups to use one.
 *
 * `reviewRequests` is spelled out as a union because `RequestedReviewer` is one:
 * `Bot | EnterpriseTeam | Mannequin | Team | User`. Three of them carry `login` and one carries
 * `name`; a member left unhandled comes back as an empty object, and the reviewer list quietly
 * grows a blank row. Bots are not the exotic case here — a repository with a review bot has one on
 * every pull request.
 */
export const DETAIL_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title body url state isDraft createdAt updatedAt
      additions deletions changedFiles headRefName baseRefName
      mergeable reviewDecision
      author { login avatarUrl(size: 64) }
      labels(first: 20) { nodes { name } }
      comments(last: 100) { totalCount nodes { author { login } body createdAt } }
      reviews(last: 50) { nodes { author { login } state body submittedAt } }
      reviewRequests(first: 20) {
        nodes {
          requestedReviewer {
            ... on User { login }
            ... on Bot { login }
            ... on Mannequin { login }
            ... on Team { name }
            ... on EnterpriseTeam { name }
          }
        }
      }
      history: commits(last: 100) {
        nodes { commit { oid messageHeadline committedDate author { name user { login } } } }
      }
      checks: commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  ... on CheckRun { name conclusion status detailsUrl }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/** The shape of `data.repository.pullRequest`, as far as anything here reads it. */
export interface DetailNode {
	number: number;
	title: string;
	body?: string;
	url: string;
	state?: string;
	isDraft?: boolean;
	createdAt: string;
	updatedAt: string;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	headRefName?: string;
	baseRefName?: string;
	mergeable?: string;
	reviewDecision?: string | null;
	author?: { login?: string; avatarUrl?: string } | null;
	labels?: { nodes?: { name?: string }[] } | null;
	comments?: { totalCount?: number; nodes?: { author?: { login?: string }; body?: string; createdAt?: string }[] } | null;
	reviews?: { nodes?: { author?: { login?: string }; state?: string; body?: string; submittedAt?: string }[] } | null;
	reviewRequests?: { nodes?: { requestedReviewer?: { login?: string; name?: string } | null }[] } | null;
	history?: {
		nodes?: ({ commit?: { oid?: string; messageHeadline?: string; committedDate?: string; author?: { name?: string; user?: { login?: string } | null } } } | null)[];
	} | null;
	checks?: { nodes?: ({ commit?: { statusCheckRollup?: { contexts?: { nodes?: RawContext[] } } | null } } | null)[] } | null;
}

/** One entry of the check rollup, which is either a check run or an old-style commit status. */
interface RawContext {
	name?: string;
	conclusion?: string;
	status?: string;
	detailsUrl?: string;
	context?: string;
	state?: string;
	targetUrl?: string;
}

/**
 * CI's answer, as a count and as the list behind it.
 *
 * Three outcomes, not GitHub's dozen. `NEUTRAL` and `SKIPPED` count as passing because neither
 * blocks anything, and a reviewer scanning for red does not want them drawing the eye. The list
 * matters the moment the answer is red: which check, and a link to go read it, rather than a trip
 * to the website to find out the name of the one that failed.
 */
function summariseChecks(contexts: RawContext[] | undefined): PullRequestDetail["checks"] {
	if (!contexts || contexts.length === 0) return null;

	const items = contexts.map((check) => {
		const raw = (check.conclusion || check.state || check.status || "").toUpperCase();
		const state: PullRequestCheck["state"] =
			raw === "SUCCESS" || raw === "NEUTRAL" || raw === "SKIPPED"
				? "pass"
				: raw === "FAILURE" || raw === "ERROR" || raw === "TIMED_OUT" || raw === "CANCELLED"
					? "fail"
					: "pending";
		const url = check.detailsUrl || check.targetUrl;
		return { name: (check.name || check.context || "").trim() || "检查", state, ...(url ? { url } : {}) };
	});

	return {
		total: items.length,
		passed: items.filter((c) => c.state === "pass").length,
		failed: items.filter((c) => c.state === "fail").length,
		pending: items.filter((c) => c.state === "pending").length,
		items,
	};
}

/** One GraphQL node, as the detail pane's shape. */
export function toDetail(accountId: string, repo: string, node: DetailNode): PullRequestDetail {
	const reviews = (node.reviews?.nodes ?? []).map((review) => ({
		author: review.author?.login ?? "unknown",
		state: review.state ?? "COMMENTED",
		body: review.body ?? "",
		submittedAt: review.submittedAt ?? "",
	}));
	const checks = summariseChecks(node.checks?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes);

	return {
		accountId,
		repo,
		number: node.number,
		title: node.title,
		author: node.author?.login ?? "unknown",
		avatarUrl: node.author?.avatarUrl ?? null,
		state: (node.state ?? "open").toUpperCase(),
		isDraft: node.isDraft === true,
		url: node.url,
		createdAt: node.createdAt,
		updatedAt: node.updatedAt,
		/** Meaningless for a single pull request; the list is where a relation decides anything. */
		relation: "authored",
		reviewDecision: node.reviewDecision || null,
		// The same three outcomes the list draws, from the same numbers the section below reports.
		checkState: checks ? (checks.failed > 0 ? "fail" : checks.pending > 0 ? "pending" : "pass") : null,
		body: node.body ?? "",
		additions: node.additions ?? 0,
		deletions: node.deletions ?? 0,
		changedFiles: node.changedFiles ?? 0,
		headRefName: node.headRefName ?? "",
		baseRefName: node.baseRefName ?? "",
		comments: node.comments?.totalCount ?? 0,
		threads: (node.comments?.nodes ?? []).map((comment) => ({
			author: comment.author?.login ?? "unknown",
			body: comment.body ?? "",
			createdAt: comment.createdAt ?? "",
		})),
		reviews,
		/*
		 * Everyone whose opinion is outstanding or already given.
		 *
		 * Requested reviewers and past reviewers are two lists in the API and one question to a
		 * person: who is looking at this.
		 */
		reviewers: [
			...(node.reviewRequests?.nodes ?? []).map((r) => ({
				login: r.requestedReviewer?.login || r.requestedReviewer?.name || "",
				state: "REQUESTED",
			})),
			...reviews.map((r) => ({ login: r.author, state: r.state })),
		].filter((r) => r.login),
		checks,
		/*
		 * Commits, so the timeline can say what was pushed and not only what was said about it.
		 *
		 * Trimmed to what a row shows: headline, who, when, and a short sha. A commit's body belongs
		 * in the diff view — carrying it here would put a screen of text into a cache entry for a
		 * line nobody expanded.
		 */
		commits: (node.history?.nodes ?? []).map((entry) => ({
			sha: (entry?.commit?.oid ?? "").slice(0, 7),
			headline: entry?.commit?.messageHeadline ?? "",
			author: entry?.commit?.author?.user?.login || entry?.commit?.author?.name || "",
			at: entry?.commit?.committedDate ?? "",
		})),
		mergeable: node.mergeable ?? "UNKNOWN",
		labels: (node.labels?.nodes ?? []).map((l) => l.name ?? "").filter(Boolean),
	};
}
