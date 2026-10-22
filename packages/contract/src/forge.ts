/**
 * The code hosts this app is signed in to, and the pull requests it reads from them.
 *
 * Only what crosses the boundary is here. The driver each host implements, and the token that goes
 * with an account, stay in the main process (`electron/forge/types.ts`).
 */

import type { WorkspaceDiffFile } from "./git.ts";

/** The hosts this app knows how to talk to. Self-hosted instances reuse the kind they run. */
export type ForgeKind = "github" | "gitlab" | "gitee" | "gitea";

/** What a review can say. `approve` and `request-changes` are decisions; `comment` is not. */
export type ReviewVerdict = "approve" | "request-changes" | "comment";

/**
 * One signed-in identity, minus the secret.
 *
 * Free of the token on purpose — this object is what crosses IPC and lands in the renderer, and a
 * token that travels to a page is a token that ends up in a screenshot. The secret lives in the
 * main process's vault (`electron/forge/vault.ts`), keyed by `id`, and only the main process ever
 * reads it.
 *
 * `baseUrl` is the *server*, as a person would type it — `https://github.com`,
 * `https://git.corp.example`. Where each host hangs its API off that is the driver's business and
 * is derived, never stored: asking someone to know that GitHub answers on `api.github.com`, GitHub
 * Enterprise on `/api/v3`, GitLab on `/api/v4` and Gitea on `/api/v1` is asking them to do the
 * app's homework.
 */
export interface ForgeAccount {
	id: string;
	kind: ForgeKind;
	/** What the user typed, or `login · host` when they typed nothing. Shown on the tab. */
	label: string;
	/** The server's root, no trailing slash. Web pages live here; the API is derived from it. */
	baseUrl: string;
	login: string;
	avatarUrl: string | null;
	/**
	 * Off means "skip me", not "forget me".
	 *
	 * Someone with four accounts is usually working in one of them. Switching an account off keeps
	 * the token and stops it being fetched, which is the difference between quieting a list and
	 * having to find the token again next week.
	 */
	enabled: boolean;
	/** Last failure from this account, kept so a tab can say why it is empty. */
	lastError?: string;
}

/**
 * What the "add an account" form needs to know about a host before it has one.
 *
 * `tokenUrl` matters more than it looks: every one of these hosts buries token creation somewhere
 * different, and three of the four accept the scopes as query parameters — so the link can land on
 * a form that is already filled in, and the step that loses people becomes one click.
 */
export interface ForgeKindInfo {
	kind: ForgeKind;
	name: string;
	/** Suggested server address for the hosted instance. Empty for hosts that are always self-run. */
	baseUrl: string;
	/** Where to go create a token on the hosted instance, scopes pre-filled where possible. */
	tokenUrl: string;
	/** Which permissions the token needs, said the way that host says it. */
	scopes: string;
	/** One line about what is different here, shown under the name while choosing. */
	note: string;
}

/**
 * A pull request as the list shows it.
 *
 * `relation` is why it is in the list at all, and what decides which group it appears under. The
 * three nullable fields come from a second request: search does not return them, and fetching
 * them per row would mean thirty round trips to decorate a list nobody has clicked yet.
 */
export interface PullRequestSummary {
	/**
	 * Which signed-in account this row came from.
	 *
	 * Carried on the row rather than looked up from the repository, because the repository is not
	 * enough to answer it: the same `owner/name` can exist on github.com and on a company's own
	 * GitHub Enterprise, and two accounts on one host is the ordinary case for anyone with a work
	 * identity. Everything done to a pull request afterwards — reading it, commenting, approving —
	 * goes back through the account it arrived on.
	 */
	accountId: string;
	repo: string;
	number: number;
	title: string;
	author: string;
	/**
	 * Where the author's picture is, as GitHub named it — not the picture.
	 *
	 * The page never fetches this itself; the main process turns it into a data URL on request.
	 * Carried per row rather than derived from the login because `github.com/<login>.png` is wrong
	 * for the accounts that post the most: a bot's picture belongs to the app, not to a user of the
	 * same name.
	 */
	avatarUrl: string | null;
	state: string;
	isDraft: boolean;
	url: string;
	createdAt: string;
	updatedAt: string;
	comments: number;
	relation: "reviewing" | "authored" | "reviewed";
	additions: number | null;
	deletions: number | null;
	headRefName: string | null;
	/**
	 * What CI says about the head commit, in the three outcomes a reviewer acts on.
	 *
	 * Null when the repository runs no checks at all, which is a different thing from "none have
	 * finished" — one draws nothing, the other draws a pending mark.
	 */
	checkState: PullRequestCheck["state"] | null;
	/** GitHub's verdict: `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null when unasked. */
	reviewDecision: string | null;
}

/** One review already left on a pull request. */
interface PullRequestReview {
	author: string;
	state: string;
	body: string;
	submittedAt: string;
}

/** A top-level comment. Line comments live on the diff and are not part of this. */
interface PullRequestComment {
	author: string;
	body: string;
	createdAt: string;
}

/** Everything the detail pane shows, which is one request for the row that was opened. */
export interface PullRequestDetail extends PullRequestSummary {
	body: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	headRefName: string;
	baseRefName: string;
	threads: PullRequestComment[];
	reviews: PullRequestReview[];
	reviewers: { login: string; state: string }[];
	/** Null when the repository runs no checks at all, which is different from "none passed". */
	checks: { total: number; passed: number; failed: number; pending: number; items: PullRequestCheck[] } | null;
	mergeable: string;
	labels: string[];
	/** What was pushed, oldest first — the other half of the timeline. */
	commits: PullRequestCommit[];
}

/** One commit on the branch, trimmed to what a timeline row shows. */
interface PullRequestCommit {
	sha: string;
	headline: string;
	author: string;
	at: string;
}

/** One CI check, reduced to the three outcomes a reviewer acts on. */
export interface PullRequestCheck {
	name: string;
	state: "pass" | "fail" | "pending";
	/** Where to go read it. Absent for checks GitHub reports without a details page. */
	url?: string;
}

/**
 * The code hosts this app is signed in to.
 *
 * Note what is not here: there is no way to read a token back. They go in through `signIn`,
 * are verified before they are stored, and are only ever used by the main process — a channel
 * that returned one would put every one of the user's credentials one devtools panel away.
 */
export interface ForgeApi {
	/** The hosts that can be added, and whether this machine can encrypt what it stores. */
	kinds(): Promise<{ kinds: ForgeKindInfo[] }>;
	accounts(): Promise<ForgeAccount[]>;
	/**
	 * Check a token against its host, and keep it if it works.
	 *
	 * Verified first, always: a token stored without being checked is an account that looks
	 * settled on the settings page and produces an empty list somewhere else entirely.
	 */
	signIn(input: { kind: ForgeKind; baseUrl: string; token: string; label?: string }): Promise<{
		account?: ForgeAccount;
		error?: string;
	}>;
	signOut(id: string): Promise<void>;
	/** Stop fetching this one without forgetting it. */
	setEnabled(id: string, enabled: boolean): Promise<ForgeAccount | null>;
	rename(id: string, label: string): Promise<ForgeAccount | null>;
}

/** The pull request half of `window.plume.git`. */
export interface PullRequestsApi {
	/**
	 * Every pull request that concerns you, across every repository and every account.
	 *
	 * Not scoped to the open folder: what is waiting on you on a Monday morning is spread
	 * across everything you work in, and these days across more than one host.
	 *
	 * `errors` is per account, and separate from `error` on purpose — one unreachable
	 * self-hosted instance must not empty a list the other accounts answered.
	 */
	myPullRequests(): Promise<{
		pullRequests: PullRequestSummary[];
		errors: Record<string, string>;
		error?: string;
	}>;
	pullRequest(accountId: string, repo: string, number: number): Promise<{ detail?: PullRequestDetail; error?: string }>;
	pullRequestDiff(accountId: string, repo: string, number: number): Promise<{ files: WorkspaceDiffFile[]; error?: string }>;
	/**
	 * A scratch directory for talking about this pull request, with `PR.md` written into it.
	 *
	 * Only used when the repository is not one of the user's projects. Stable across launches
	 * — sessions are keyed by their directory — so reopening the same review months later
	 * finds the same conversation.
	 */
	scratchForPullRequest(pr: {
		repo: string;
		number: number;
		title: string;
		author: string;
		url: string;
		headRefName: string;
		baseRefName: string;
		state: string;
		body: string;
	}): Promise<string>;
	/**
	 * Which of `candidates` has this repository as its `origin`, or null.
	 *
	 * Candidates are the user's own project paths. Matching is on the remote rather than the
	 * directory name, and a fork does not count: `origin` is what a working copy pushes to.
	 */
	findLocalCheckout(repo: string, candidates: string[]): Promise<string | null>;
	/**
	 * The same, for every face a list is about to draw.
	 *
	 * One call rather than one per row: the main process has most of them cached already, and
	 * the cost that was actually being paid was the IPC round trips, one per avatar per mount.
	 * `url` is what the search result said; without one the login is turned into an address.
	 */
	avatars(people: { login: string; url?: string | null }[]): Promise<Record<string, string | null>>;
	commentOnPullRequest(accountId: string, repo: string, number: number, body: string): Promise<{ error?: string }>;
	reviewPullRequest(
		accountId: string,
		repo: string,
		number: number,
		verdict: "approve" | "request-changes" | "comment",
		body: string,
	): Promise<{ error?: string }>;
}
