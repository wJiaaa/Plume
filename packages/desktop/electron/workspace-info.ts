/**
 * Reading a directory as a project.
 *
 * Its name, whether it is a repository, and which branch is checked out. Nothing more: this is the
 * record the window is pointed at, and it is read on a path the user is waiting on.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { gitBranch, probeRepo } from "./git-probe.ts";
import type { WorkspaceInfo } from "./ipc-types.ts";

/**
 * Two git calls, both of which answer instantly.
 *
 * This used to call `collectWorkspaceDiff` — which reads both sides of every changed file and
 * computes hunks for them — to fill in two line counts that nothing on screen ever read. The
 * counter above the composer polls `git.stat` for its own numbers and always did. So the whole
 * 1.6 seconds this call took on a repository with a couple of hundred uncommitted files was spent
 * building a diff, and then throwing it away.
 *
 * It would be waste anywhere. Here it was the window's response time, because every caller is
 * something the user is waiting on with nothing on screen: opening a project, switching between
 * conversations, coming back from a branch switch. Measured after: 15ms on the same repository.
 */
export async function workspaceInfo(path: string): Promise<WorkspaceInfo | null> {
	if (!existsSync(path)) return null;
	const { repo: git, problem } = await probeRepo(path);
	return {
		path,
		/*
		 * `basename`, not the last `/`-separated segment.
		 *
		 * Splitting on a literal slash is right on macOS and Linux and wrong on Windows, where the
		 * separator is `\` — there, every project was named after its entire absolute path.
		 */
		name: basename(path) || path,
		isGitRepo: git,
		branch: git ? await gitBranch(path) : null,
		// Only when git could not answer. A directory that simply has no repository in it is not a
		// problem to report — it is the ordinary case the panel already has words for.
		gitProblem: problem,
	};
}
