/**
 * Git worktree management, creation, auto-creation and cleanup.
 *
 * Provides dedicated worktrees so that AI sessions can run in clean, isolated checkouts
 * without interfering with the user's primary working tree or active branch.
 */

import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { SessionMeta, Settings } from "@plume/core";
import { git } from "./git-exec.ts";
import { gitBranch, isGitRepo, worktreeRecords } from "./git-probe.ts";
import { canonicalPath } from "../path-key.ts";
import { removeLinkedWorktree, repoRoot } from "./worktree-lifecycle.ts";

export interface WorktreeCreateOptions {
	/**
	 * Where the worktree goes. Required: the location is the caller's decision, made from settings
	 * through `resolveWorktreesRoot`, because the IPC guard admits exactly that directory and
	 * nothing beside the repository. A default here once put worktrees next to the repo, where
	 * every write from the Git panel was then refused as outside any opened project.
	 */
	targetDir: string;
	/** Whether to fetch upstream before creating */
	fetchUpstream?: boolean;
}

export interface WorktreeResult {
	ok: boolean;
	path?: string;
	branch?: string;
	error?: string;
}

/**
 * Resolves the configured root directory for worktrees.
 * Supports "~" expansion and defaults to "~/.plume/worktrees". Creation and the IPC guard in
 * `main.ts` both read it, so a worktree always lands where the Git panel is allowed to write.
 */
export function resolveWorktreesRoot(customRootDir?: string): string {
	if (customRootDir && customRootDir.trim()) {
		const trimmed = customRootDir.trim();
		if (trimmed.startsWith("~")) {
			return join(homedir(), trimmed.slice(1));
		}
		return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
	}
	return join(process.env.PLUME_HOME || join(homedir(), ".plume"), "worktrees");
}

/**
 * Fetch updates from remotes if git repository has remotes configured.
 */
async function fetchUpstreamQuietly(cwd: string): Promise<void> {
	try {
		await git(cwd, ["fetch", "--all", "--prune"]);
	} catch {
		// Fetch failure (e.g. offline) shouldn't block worktree creation
	}
}

/**
 * Creates a git worktree for a specific repository at `options.targetDir`.
 */
export async function createWorktree(
	cwd: string,
	branch: string,
	options: WorktreeCreateOptions,
): Promise<WorktreeResult> {
	if (!(await isGitRepo(cwd))) return { ok: false, error: "当前项目不是 Git 仓库" };

	const safe = branch.trim().replace(/[^\w.\-/]/g, "-");
	if (!safe) return { ok: false, error: "分支名不能为空" };

	if (options.fetchUpstream) {
		await fetchUpstreamQuietly(cwd);
	}

	const target = options.targetDir;

	try {
		// Ensure parent directory exists
		await mkdir(join(target, ".."), { recursive: true });
		// `-B` so re-running with the same name resets or creates branch cleanly
		await git(cwd, ["worktree", "add", "-B", safe, target]);
		/*
		 * The canonical spelling, not the one that was passed in.
		 *
		 * `target` is whatever the caller joined together, so it carries whatever separators, `..`
		 * segments and short names came in with it. Callers keep this path and later compare it
		 * against `git worktree list`, which prints the resolved long form — and a comparison that
		 * cannot match is what let the cleanup delete a worktree that was in use.
		 */
		return { ok: true, path: canonicalPath(target), branch: safe };
	} catch (cause) {
		const message = cause instanceof Error && "stderr" in cause ? String(cause.stderr) : String(cause);
		return { ok: false, error: message.trim() || "创建工作树失败" };
	}
}

/**
 * A worktree of its own, for a conversation that asked for one (`SessionMeta.workspaceSetup`).
 *
 * The marker is the decision. It is made per conversation — in the composer, starting from
 * `worktrees.autoCreateOnNewSession` (`create-session.ts`) — and asking the setting again here is
 * what used to make a choice in the composer impossible: off in settings meant never, whatever the
 * conversation had been told.
 *
 * `worktree` is what the conversation's meta records once it has one. `error` says why when there is
 * none, for the conversation to be told: it then runs in the project itself, and the person who asked
 * for a separate copy has to know it did not get one.
 */
export async function autoCreateSessionWorktree(
	projectCwd: string,
	settings: Settings,
	sessionId: string,
): Promise<{ cwd: string; worktree?: NonNullable<SessionMeta["worktree"]>; error?: string }> {
	if (!(await isGitRepo(projectCwd))) {
		return { cwd: projectCwd, error: "not a git repository" };
	}

	const branchName = `plume/session-${sessionId.slice(0, 8)}`;
	const root = (await repoRoot(projectCwd)) ?? projectCwd;
	const repoName = basename(root) || "repo";

	const targetDir = join(resolveWorktreesRoot(settings.worktrees?.rootDir), `${repoName}-${sessionId.slice(0, 8)}`);
	// What the copy is cut from, so merging it back has somewhere to go; nothing from a detached HEAD.
	const base = (await gitBranch(projectCwd)) ?? undefined;

	const result = await createWorktree(projectCwd, branchName, {
		targetDir,
		fetchUpstream: settings.worktrees?.fetchUpstreamBeforeCreate ?? false,
	});
	if (!result.ok || !result.path) return { cwd: projectCwd, error: result.error };
	/*
	 * The same folder inside the copy: a project that is one package of a repository keeps running in
	 * that package. Only if the copy has it — a folder never committed is not checked out there.
	 */
	const inside = relative(canonicalPath(root), canonicalPath(projectCwd));
	const nested = inside && !inside.startsWith("..") && !isAbsolute(inside) ? join(result.path, inside) : null;
	return {
		cwd: nested && existsSync(nested) ? nested : result.path,
		worktree: { project: projectCwd, root: result.path, branch: branchName, ...(base ? { base } : {}) },
	};
}

/**
 * Make room when the worktrees Plume made for conversations pass `keepLimit`, oldest first.
 *
 * Only Plume's own — linked worktrees on a `plume/session-` (once `lyra/session-`) branch — and of those only ones safe to take
 * back: none a conversation still uses (`inUse`: every conversation not archived, not only the ones
 * running), none holding uncommitted changes, never `--force`. The branch stays, so a conversation that
 * comes back checks its worktree out again (`restoreWorktree`). This used to count every linked worktree,
 * a person's own among them, spare only the conversations alive in memory, and force the removal — so it
 * could delete a worktree someone was working in by hand, uncommitted changes and all. See ADR-0050.
 */
export async function cleanOldWorktrees(
	repoCwd: string,
	settings: Settings,
	inUse: Set<string> = new Set(),
): Promise<number> {
	if (!settings.worktrees?.autoCleanOld) return 0;
	if (!(await isGitRepo(repoCwd))) return 0;
	const keepLimit = Math.max(1, settings.worktrees.keepLimit ?? 15);
	// The first is the main checkout, which is never ours to remove. `lyra/` is the same prefix from
	// before the rename to Plume.
	const ours = (await worktreeRecords(repoCwd))
		.slice(1)
		.filter((tree) => /^(plume|lyra)\/session-/.test(tree.branch ?? ""))
		.map((tree) => tree.path);
	if (ours.length <= keepLimit) return 0;

	/*
	 * Canonical spellings on both sides: git prints its own (forward slashes on Windows, `/private/var`
	 * on macOS), the callers pass theirs, and a guard comparing the two raw never fires. A conversation's
	 * folder may also be a package inside its worktree, so "uses" means at or under it.
	 */
	const using = [...inUse].map((cwd) => canonicalPath(cwd));
	const held = (tree: string) => {
		const root = canonicalPath(tree);
		return using.some((cwd) => {
			const inside = relative(root, cwd);
			return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
		});
	};
	const aged = await Promise.all(ours.map(async (path) => ({ path, mtime: await stat(path).then((s) => s.mtimeMs, () => 0) })));
	aged.sort((a, b) => a.mtime - b.mtime);

	let cleaned = 0;
	for (const tree of aged) {
		if (cleaned >= ours.length - keepLimit) break;
		// Not forced, so git itself refuses one holding uncommitted changes.
		if (!held(tree.path) && (await removeLinkedWorktree(repoCwd, tree.path)).ok) cleaned++;
	}
	return cleaned;
}
