/**
 * Is this a repository, and which branch is it on.
 *
 * The questions every other git module asks before doing its own work. They sit in a module of
 * their own, depending on nothing but `git-exec`, so any git module can ask them without closing a
 * cycle through another.
 */

import { git } from "./git-exec.ts";
import { parseWorktreeList, type WorktreeRecord } from "./git-parse.ts";

/**
 * Whether this directory is inside a working tree — and if git would not say, why not.
 *
 * The catch used to swallow everything, and that is a different claim than it looks: `git` missing
 * from `PATH`, a directory that cannot be read, a repository git refuses to touch — all of them
 * came back as `false`, and the window said 「不是 Git 仓库，这个目录还没有版本控制」 about a
 * directory with a perfectly good `.git` in it. The one answer nobody could act on, because it
 * describes a state that is not the one they are in.
 *
 * Naming it in a log was not enough either: the log is somewhere the user cannot see, so the window
 * still showed the same wrong sentence with an 「初始化仓库」 button under it — offering to run
 * `git init` inside a repository. So the reason comes back with the answer and is put on screen.
 *
 * Three of these are worth telling apart, because the fix for each is different:
 *
 *     fatal: detected dubious ownership in repository at '…'   — a checkout owned by another user
 *     spawn git ENOENT                                          — no git on PATH at all
 *     fatal: not a git repository                               — git answering the question
 */
export interface RepoProbe {
	repo: boolean;
	/** What stopped git from answering, in the user's language. Absent when it did answer. */
	problem?: string;
}

export async function probeRepo(cwd: string): Promise<RepoProbe> {
	try {
		return { repo: (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() === "true" };
	} catch (error) {
		const said = String((error as { stderr?: string })?.stderr ?? (error as Error)?.message ?? error).trim();
		const first = said.split("\n")[0] ?? said;

		// git's own way of saying no — the only case where "not a repository" is the truth.
		if (/not a git repository/i.test(said)) return { repo: false };

		if (/ENOENT/.test(said) && /spawn git/i.test(said)) {
			return { repo: false, problem: "找不到 git 命令。请确认已安装 git，并且它在系统 PATH 里。" };
		}
		if (/dubious ownership/i.test(said)) {
			const match = /repository at '(.+?)'/.exec(said);
			const where = match?.[1] ?? cwd;
			return {
				repo: false,
				problem: `git 拒绝读取这个仓库，因为它属于另一个用户。可以执行：git config --global --add safe.directory ${where}`,
			};
		}
		return { repo: false, problem: `git 没能读取这个目录：${first}` };
	}
}

/** The same question, for the callers that only branch on the answer. */
export async function isGitRepo(cwd: string): Promise<boolean> {
	return (await probeRepo(cwd)).repo;
}

/**
 * The branch that is checked out, or null when none is.
 *
 * `symbolic-ref` and nothing else, for two reasons that pull the same way.
 *
 * It is the only one that answers the question. `rev-parse --abbrev-ref HEAD` returns the *string*
 * `"HEAD"` on a detached checkout rather than failing — so every caller that wrote `if (!branch)`
 * was reading "not on a branch" as "on a branch called HEAD". `pushBranch` was one of them, and it
 * went on to run `push -u origin HEAD`, which git refuses with `not a full refname`. A checkout at
 * a tag, a bisect, and every rebase in progress all land here.
 *
 * And it is right about a repository with no commits, which is why `rev-parse` was paired with it
 * to begin with: there is no commit to resolve, but HEAD already names the branch the first commit
 * will land on, and `symbolic-ref` reads that name. So one call answers both cases where two used
 * to, and the one it drops is the one that was lying.
 */
export async function gitBranch(cwd: string): Promise<string | null> {
	return git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])
		.then((out) => out.trim() || null)
		.catch(() => null);
}

/**
 * Every checkout of this repository, the main one first; empty when git will not say.
 *
 * Asked of git rather than inferred from folder names: only what git lists is a worktree, and
 * removing anything else is deleting a directory.
 */
export async function worktreeRecords(cwd: string): Promise<WorktreeRecord[]> {
	return parseWorktreeList(await git(cwd, ["worktree", "list", "--porcelain"]).catch(() => ""));
}
