/**
 * Branches, and the door to everything else git-related.
 *
 * Branch operations live here because they are what the panel opens on. The rest — status, diffs,
 * history, repositories — is re-exported from the modules that own it, so a caller says
 * `from "./git.ts"` and does not have to know which file a function moved to.
 */

import { git } from "./git-exec.ts";
import { gitBranch, isGitRepo } from "./git-probe.ts";
import type { BranchList } from "./ipc-shapes.ts";

export { type RemoteResult } from "./git-exec.ts";
export { type GitOperation, type RemoteState } from "./git-remote-state.ts";
export { collectWorkspaceDiff, readDiffBlob, type DiffBlob } from "./git-diff.ts";
export {
	discardPaths,
	gitStatus,
	stagePaths,
	unstagePaths,
	upstreamDistance,
	workspaceStat,
	type GitCommit,
	type GitStatus,
	type GitStatusFile,
} from "./git-status.ts";
export {
	commitDiff,
	commitDiffSummary,
	commitStaged,
	createBranch,
	deleteBranch,
	diffRefs,
	gitLog,
	fetchRemotes,
	pullBranch,
	pushBranch,
	FETCH_TIMEOUT_MS,
	QUIET_FETCH_TIMEOUT_MS,
} from "./git-history.ts";
export {
	initRepo,
	listRepos,
	listWorktrees,
	removeWorktree,
	type RepoRef,
} from "./git-repos.ts";
export {
	bumpVersionFiles,
	getReleaseInfo,
	getWorkflowRunStatus,
	listWorkflowRuns,
	publishReleaseTag,
	triggerReleaseDryRun,
	type ReleaseInfo,
	type WorkflowRunStatus,
	type WorkflowRunSummary,
} from "./git-release.ts";
export { generateCommitMessage } from "./git-commit-message.ts";
export { gitBranch } from "./git-probe.ts";
export type { BranchList };

/** Local and remote branches, for the switcher in the composer. */
export async function listBranches(cwd: string): Promise<BranchList> {
	if (!(await isGitRepo(cwd))) return { current: null, local: [], remote: [] };

	const [current, refs] = await Promise.all([
		gitBranch(cwd),
		/*
		 * The full ref path, not the short name, because the short name cannot be classified.
		 *
		 * `%(refname:short)` is ambiguous in both directions. `refs/remotes/origin/HEAD` shortens to
		 * plain `origin` — no slash — so a "does it contain a slash" test filed the remote's own
		 * symbolic pointer under local branches, and it appeared in the switcher as a branch called
		 * `origin` that cannot be checked out. And a local branch is very often `feat/something`,
		 * which has a slash and was therefore filed under remotes: on a repository that names its
		 * branches that way, nearly every local branch showed up in the wrong half of the menu.
		 *
		 * The prefix says which it is, exactly, and costs nothing to read.
		 */
		git(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).catch(() => ""),
	]);

	const local: string[] = [];
	const remote: string[] = [];
	for (const line of refs.split("\n")) {
		const ref = line.trim();
		if (!ref) continue;
		if (ref.startsWith("refs/heads/")) {
			local.push(ref.slice("refs/heads/".length));
		} else if (ref.startsWith("refs/remotes/")) {
			const name = ref.slice("refs/remotes/".length);
			// `origin/HEAD` is a symbolic pointer, not somewhere you can check out.
			if (name.endsWith("/HEAD")) continue;
			remote.push(name);
		}
	}

	const known = new Set(local);
	return {
		current,
		local: local.sort(),
		// A remote branch whose short name already exists locally would just check out the local one.
		remote: remote.filter((r) => !known.has(r.split("/").slice(1).join("/"))).sort(),
	};
}

/**
 * Switch branches, refusing rather than clobbering.
 *
 * `git switch` stops on its own when uncommitted work would be overwritten; the message it
 * prints is more useful than anything this layer could invent, so it is passed straight
 * through to the user.
 */
export async function switchBranch(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }> {
	try {
		/*
		 * A remote branch is not a place you can stand, so switching to one means creating a local
		 * branch that follows it.
		 *
		 * `git switch origin/main` fails outright — "a branch is expected, got remote branch" — and
		 * that error went straight to the user as if they had done something wrong, from a menu that
		 * had just offered them the entry. `--track` makes the local branch, names it after the
		 * remote's own short name, and sets the upstream in one step.
		 *
		 * Decided by looking rather than by parsing the name: `feat/x` is a perfectly ordinary local
		 * branch, and telling the two apart by counting slashes is what produced the bug above.
		 */
		const isLocal = await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
			.then(() => true)
			.catch(() => false);
		await git(cwd, isLocal ? ["switch", branch] : ["switch", "--track", branch]);
		return { ok: true };
	} catch (cause) {
		const message = cause instanceof Error && "stderr" in cause ? String(cause.stderr) : String(cause);
		return { ok: false, error: message.trim() || "切换分支失败" };
	}
}
