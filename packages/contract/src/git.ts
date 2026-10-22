/**
 * The repository on disk: its status, history and branches, the operations that write to it, and
 * the diffs every review view draws.
 *
 * `window.plume.git` also carries the pull request and release calls, because that is where they
 * were put; their shapes live with the host they talk to, in `forge.ts` and `release.ts`.
 */

import type { DiffHunk } from "@plume/core/contract-types";
import type { PullRequestsApi } from "./forge.ts";
import type { ReleaseApi } from "./release.ts";

/** The shape every diff view consumes, whatever produced it. */
export interface RefDiff {
	files: WorkspaceDiffFile[];
	added: number;
	removed: number;
}

export interface WorkspaceDiffFile {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed" | "untracked";
	added: number;
	removed: number;
	hunks: DiffHunk[];
	/**
	 * Not text, so there are no hunks and the counts are zero.
	 *
	 * A PNG has changed or it has not; there is no third answer and no line to point at. Saying so
	 * is what lets the panel show the picture instead of the bytes — and, just as importantly, what
	 * keeps the file *listed*. Before this, a changed image was silently dropped from the review
	 * entirely, because the only way the reader knew a file was binary was that it had failed to
	 * produce text.
	 */
	binary?: boolean;
	/** Size in bytes of whichever side exists, so a binary row can say something concrete. */
	bytes?: number;
}

export interface GitStatusFile {
	path: string;
	status: WorkspaceDiffFile["status"];
	/** Both can be true: a file edited after part of it was staged. */
	staged: boolean;
	unstaged: boolean;
	added: number;
	removed: number;
}

export interface GitStatus {
	branch: string | null;
	upstream: string | null;
	/**
	 * Commits this branch has that its upstream does not, and the reverse.
	 *
	 * Both are 0 whenever there is no upstream, because that is all `git status` reports — which is
	 * why nothing should read them without looking at `remoteState` first. `unpushed` is the number
	 * to show.
	 */
	ahead: number;
	behind: number;
	staged: GitStatusFile[];
	unstaged: GitStatusFile[];
	/** Which of the situations in `git-remote-state.ts` this checkout is in. */
	remoteState: RemoteState;
	/** Where a push would go. Null when no remote could be chosen — see `defaultRemote`. */
	remote: string | null;
	/** The unfinished rebase / merge / …, when `remoteState` is `in-progress`. */
	operation: GitOperation | null;
	/**
	 * Commits that exist here and not on the remote.
	 *
	 * Null means the question has no answer rather than that the answer is zero: a branch the remote
	 * has never seen has nothing to be counted against. The panel says "还没有发布过" there instead
	 * of a number, because `rev-list --count HEAD` would answer with the length of the whole branch
	 * — accurate, and no use to anyone.
	 */
	unpushed: number | null;
	/** The short sha a detached HEAD is sitting on. Null whenever a branch is checked out. */
	head: string | null;
}

export interface GitCommit {
	sha: string;
	shortSha: string;
	subject: string;
	/** Every parent, so the renderer can draw where lines split and rejoin. */
	parents: string[];
	author: string;
	/** ISO 8601, formatted for display in the renderer where the locale lives. */
	date: string;
	/** Branch and tag names pointing at this commit, already stripped of their prefixes. */
	refs: string[];
}

export interface BranchList {
	current: string | null;
	local: string[];
	/** Remote-tracking branches, minus the ones that already have a local counterpart. */
	remote: string[];
}

/** A repository or worktree the Git panel can switch to. */
export interface RepoRef {
	/** Absolute path to the working directory of this repository. */
	path: string;
	/** Path relative to the workspace, or the folder name for the workspace root itself. */
	label: string;
	branch: string | null;
	/** True when this is a linked worktree rather than the main checkout. */
	worktree: boolean;
}

export interface RemoteResult {
	ok: boolean;
	error?: string;
	/** The caller stopped it. Not a failure, and nothing should be said about it. */
	cancelled?: boolean;
}

/**
 * Anything that suspends normal work: git will refuse to push or pull, and offering the buttons is
 * offering an error.
 *
 * `bisect` is in here for the same reason as the rest even though git would technically allow a
 * push: you are in the middle of a search, and the commit checked out is not one you chose.
 */
export type GitOperation = "rebase" | "merge" | "cherry-pick" | "revert" | "bisect";

export type RemoteState =
	/** No commit exists yet, so there is nothing that could be pushed. */
	| "no-commits"
	/** A rebase / merge / … is unfinished. Finish or abort it before anything else. */
	| "in-progress"
	/** Not on a branch. There is no "here" for a push to mean. */
	| "detached"
	/** A repository with no remotes at all — a perfectly ordinary way to work. */
	| "none"
	/** Remotes exist, this branch tracks none of them. */
	| "no-upstream"
	/** The ordinary case: a branch with an upstream. */
	| "tracking";

export interface GitApi extends PullRequestsApi, ReleaseApi {
	/** The shared scratch directory for 「不在项目中工作」. */
	generalScratch(): Promise<string>;
	/**
	 * Every directory those conversations live under, so the sidebar can tell them from real
	 * projects. More than one because the directory has been renamed and stored sessions still
	 * record the old path.
	 */
	scratchRoots(): Promise<string[]>;
	/** Local and remote branches, for the composer's branch switcher. */
	branches(cwd: string): Promise<BranchList>;
	switchBranch(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }>;
	removeWorktree(cwd: string, worktreePath: string): Promise<{ ok: boolean; error?: string }>;
	/**
	 * How much is uncommitted, as three numbers.
	 *
	 * Deliberately separate from `diff.workspaceDiff`: this one is on screen the whole
	 * session and re-runs after every turn, so it counts without building any diffs.
	 */
	stat(cwd: string): Promise<{ branch: string | null; added: number; removed: number; files: number }>;
	/** Commits the checked-out branch has that its upstream lacks, and the reverse; null with no upstream. */
	upstream(cwd: string): Promise<{ upstream: string; ahead: number; behind: number } | null>;

	/* The Git panel's surface. Reading first, then the operations that write. */

	/** Every repository under the workspace — people keep more than one side by side. */
	repos(root: string): Promise<RepoRef[]>;
	/** Linked checkouts of one repository, each on its own branch. */
	worktrees(cwd: string): Promise<RepoRef[]>;
	init(cwd: string): Promise<{ ok: boolean; error?: string }>;
	/** Working tree split by index, with upstream distance. */
	status(cwd: string): Promise<GitStatus>;
	log(cwd: string, limit?: number, ref?: string): Promise<GitCommit[]>;
	/** What one commit changed, against its parent. */
	commitDiff(cwd: string, sha: string): Promise<RefDiff>;
	/** A commit's file list without its contents, for showing the list before the diffs arrive. */
	commitDiffSummary(cwd: string, sha: string): Promise<{ files: WorkspaceDiffFile[] }>;
	/** Any two points in history; `head` of null diffs the index against `base`. */
	diffRefs(cwd: string, base: string, head: string | null): Promise<RefDiff>;

	stage(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }>;
	unstage(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }>;
	/** Irreversible: untracked paths are deleted, not restored. */
	discard(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }>;
	/** Commits exactly what the panel shows as staged. */
	commitStaged(cwd: string, message: string): Promise<{ ok: boolean; error?: string }>;
	/** A commit message from the configured model, about the staged (or unstaged) patch. */
	generateCommitMessage(cwd: string): Promise<{ ok: boolean; message?: string; error?: string }>;
	createBranch(cwd: string, name: string, from?: string): Promise<{ ok: boolean; error?: string }>;
	deleteBranch(cwd: string, name: string, force?: boolean): Promise<{ ok: boolean; error?: string }>;
	/**
	 * The three calls that touch a remote.
	 *
	 * Each takes a `token` the renderer makes up, and `cancelRemote` stops whichever call is
	 * holding it. An `AbortSignal` cannot cross the IPC boundary, so the identity of the running
	 * operation has to, and the renderer is the side that knows which button was pressed twice.
	 *
	 * They answer with `cancelled` alongside `error` because the panel treats them differently:
	 * a cancellation says nothing, a timeout says so plainly, and a failure gets whatever
	 * `explainGitFailure` made of git's own words.
	 */
	push(cwd: string, token?: string): Promise<RemoteResult>;
	pull(cwd: string, token?: string): Promise<RemoteResult>;
	/** `fetch --prune`, so `ahead` / `behind` describe the remote as it is now. */
	fetch(cwd: string, token?: string, quiet?: boolean): Promise<RemoteResult>;
	/** Stop the push / pull / fetch running under this token. Unknown tokens are ignored. */
	cancelRemote(token: string): Promise<void>;
}

export interface DiffApi {
	/** Uncommitted changes for the review panel. */
	workspaceDiff(cwd: string, base?: "head" | "index"): Promise<{ files: WorkspaceDiffFile[]; added: number; removed: number; branch: string | null }>;
	/**
	 * One side of a binary file, as a data URL, for the review to draw rather than describe.
	 *
	 * Null when there is nothing worth drawing — a `.zip`, a file too large to move, or a side
	 * that does not exist (the working copy of a deleted file). See `readDiffBlob`.
	 */
	blob(cwd: string, path: string, side: "head" | "work"): Promise<{ dataUrl: string; bytes: number } | null>;
}
