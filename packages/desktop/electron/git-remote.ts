/**
 * Which local checkout, if any, is the repository this pull request is against.
 *
 * The point is that a review should land you where the code is. If the repository is already on
 * this machine, the conversation should start in it — with the files, the history and the branch
 * switcher all pointing at the right thing. If it is not, there is nothing to pretend about and
 * the conversation starts without a project at all.
 *
 * Matching is on the remote's `owner/name`, not on the directory name, because a checkout can be
 * called anything. A fork is deliberately not a match: `origin` is what this working copy pushes
 * to, and answering questions about someone else's branch from a directory that tracks a fork of
 * it would be quietly wrong in exactly the way that is hard to notice.
 */

import { git } from "./git-exec.ts";

/** Where a remote lives and which repository it is. */
export interface RemoteRepo {
	host: string;
	owner: string;
	name: string;
}

/**
 * Host, owner and name from a remote URL, or null if it is not one we recognise.
 *
 * Both forms git hands out, plus the `ssh://` spelling that some hosts use:
 *
 *   git@github.com:owner/name.git
 *   https://github.com/owner/name.git
 *   ssh://git@github.com:2222/owner/name
 *
 * The last two path segments are owner and name; anything before them is a hosting path (GitLab
 * subgroups). A local path is not a remote: it has no owner to match, and guessing one from the
 * directory name is exactly the wrong answer. A one-letter "host" is a Windows drive, not scp.
 */
export function parseRemote(url: string): RemoteRepo | null {
	const trimmed = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
	// scp-like: [user@]host:owner/name, which is not a URL and cannot be parsed as one.
	const located =
		/^(?:[^/@\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/.exec(trimmed) ??
		/^[a-z+]+:\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
	if (!located) return null;
	const parts = located[2].split("/").filter(Boolean);
	if (parts.length < 2) return null;
	return { host: located[1], owner: parts[parts.length - 2], name: parts[parts.length - 1] };
}

/**
 * `owner/name`, for matching against a pull request.
 *
 * Case is preserved but comparison is not — GitHub treats owner and repository names
 * case-insensitively, and a remote written in the other case is the same repository.
 */
export function repoFromRemote(url: string): string | null {
	const remote = parseRemote(url);
	return remote ? `${remote.owner}/${remote.name}` : null;
}

/** The `origin` of a checkout, or null when there is none or it is not a repository. */
async function originOf(dir: string): Promise<string | null> {
	return git(dir, ["remote", "get-url", "origin"], { timeoutMs: 3000 }).then(repoFromRemote, () => null);
}

/**
 * The first of `candidates` whose `origin` is `repo`.
 *
 * Candidates are the user's own project list, so this is a handful of directories at most and
 * each answer is one cheap `git` call. Checked in the order given — the caller sorts by most
 * recently opened, which is the right tiebreaker when someone keeps two checkouts of one
 * repository.
 */
export async function findLocalCheckout(repo: string, candidates: string[]): Promise<string | null> {
	const want = repo.trim().toLowerCase();
	if (!want) return null;

	for (const dir of candidates) {
		const origin = await originOf(dir);
		if (origin && origin.toLowerCase() === want) return dir;
	}
	return null;
}
