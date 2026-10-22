/**
 * Reading git's `-z` output.
 *
 * Both formats here give a rename two paths as their own NUL-terminated fields, so a record is not
 * one field long and the walk has to look at what it just read. Each reader used to do that walk
 * itself, and the two that forgot took a rename's old path for another row — a phantom file in the
 * panel, a second file on the change bar. One walk, used by all of them.
 */

/** One row of `status --porcelain=v1 -z`. */
export interface StatusEntry {
	/** The two status letters: index, then working tree. */
	code: string;
	path: string;
	/** Where a rename or copy came from; the same as `path` otherwise. */
	source: string;
}

/**
 * `status --porcelain=v1 -z`, with or without `--branch`.
 *
 * The `## …` header, when asked for, is the first field and is returned on its own.
 */
export function parseStatusZ(out: string): { header: string; entries: StatusEntry[] } {
	const fields = out.split("\0");
	let header = "";
	const entries: StatusEntry[] = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (!field) continue;
		if (i === 0 && field.startsWith("## ")) {
			header = field.slice(3);
			continue;
		}
		const code = field.slice(0, 2);
		const path = field.slice(3);
		// A rename's source is the next field, not another status row.
		const source = /[RC]/.test(code) ? (fields[++i] ?? path) : path;
		if (path) entries.push({ code, path, source });
	}
	return { header, entries };
}

/**
 * The branch named by `status --branch`'s header, and whether it has a first commit yet.
 *
 * The forms git writes: `main...origin/main [ahead 1]`, `main`, `No commits yet on main` (`Initial
 * commit on main` before git 2.15) and `HEAD (no branch)`. Null on a detached HEAD, which is what
 * `gitBranch` answers there too. A branch name cannot contain `..`, so the first `...` ends it.
 */
export function statusBranch(header: string): { branch: string | null; born: boolean } {
	const unborn = /^(?:No commits yet|Initial commit) on (.+)$/.exec(header);
	if (unborn) return { branch: unborn[1]!, born: false };
	if (!header || header.startsWith("HEAD (no branch)")) return { branch: null, born: true };
	return { branch: header.split("...")[0]!.split(" ")[0]!, born: true };
}

/**
 * Line counts per path, from `--numstat -z`.
 *
 * The format writes `added\tremoved\tpath\0` for an ordinary change, and for a rename writes the
 * counts followed by an empty path field and then the two paths as their own fields. A binary file
 * has `-` for both counts, which is git saying there is no line to count rather than zero of them.
 *
 * Keyed by the destination path, which is what `status` and `--name-status` report.
 */
export function parseNumstat(stats: string): Map<string, { added: number; removed: number; binary: boolean }> {
	const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
	const fields = stats.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (!field) continue;
		const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(field);
		if (!match) continue;
		const [, addedRaw, removedRaw, inline] = match;
		// An empty trailing path means the two rename paths follow as their own fields.
		const path = inline || fields[i + 2];
		if (!inline) i += 2;
		if (!path) continue;
		counts.set(path, {
			added: addedRaw === "-" ? 0 : Number(addedRaw),
			removed: removedRaw === "-" ? 0 : Number(removedRaw),
			binary: addedRaw === "-",
		});
	}
	return counts;
}

/** One checkout from `worktree list --porcelain`. */
export interface WorktreeRecord {
	/** As git printed it: resolved, forward slashes on Windows. Compare through `path-key.ts`. */
	path: string;
	/** The short branch name, or null on a detached checkout. */
	branch: string | null;
}

/**
 * `worktree list --porcelain`: one blank-line separated record per checkout, the main one first.
 */
export function parseWorktreeList(out: string): WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) records.push({ path: line.slice("worktree ".length), branch: null });
		else if (line.startsWith("branch ") && records.length > 0) {
			records[records.length - 1].branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		}
	}
	return records;
}
