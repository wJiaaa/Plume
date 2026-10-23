/**
 * The comments and commits of a pull request, as Gitee and Gitea both return them.
 *
 * Both copied GitHub's v3 REST shapes field for field, so these two mappings are one. Listing,
 * diffs and reviews stay in each driver: there the two really differ — Gitee has no search and a
 * single review verb, Gitea has both.
 */

import type { PullRequestDetail } from "@plume/contract";

export interface RawComment {
	body?: string;
	created_at?: string;
	user?: { login?: string } | null;
}

export interface RawCommit {
	sha?: string;
	author?: { login?: string } | null;
	commit?: { message?: string; author?: { name?: string; date?: string } } | null;
}

export function toThreads(comments: RawComment[]): PullRequestDetail["threads"] {
	return comments.map((comment) => ({
		author: comment.user?.login ?? "unknown",
		body: comment.body ?? "",
		createdAt: comment.created_at ?? "",
	}));
}

/** Headline, who, when and a short sha — what a timeline row shows. */
export function toCommits(commits: RawCommit[]): PullRequestDetail["commits"] {
	return commits.map((commit) => ({
		sha: (commit.sha ?? "").slice(0, 7),
		headline: (commit.commit?.message ?? "").split("\n")[0],
		author: commit.author?.login || commit.commit?.author?.name || "",
		at: commit.commit?.author?.date ?? "",
	}));
}
