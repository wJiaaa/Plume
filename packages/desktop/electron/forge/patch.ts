/**
 * Turning a host's per-file change list back into a unified diff.
 *
 * GitHub and Gitea will hand over a pull request as the patch `git diff` would print, which the
 * app already knows how to read. GitLab and Gitee will not: they return an array of files, each
 * carrying its hunks as a fragment with no `diff --git` header, no `---`/`+++` lines, and — for a
 * rename with no edits — no content at all.
 *
 * Rather than teach the diff viewer a second input shape, the fragments are reassembled into the
 * one format there already is. That keeps a single parser, a single renderer and a single set of
 * edge cases (binary files, renames, new and deleted files), and it means a GitLab review and a
 * GitHub review are the same screen rather than two that drifted apart.
 *
 * Everything here is a string transformation, which is the point: it is testable without a host.
 */

/** One changed file, in the shape both GitLab and Gitee describe one. */
export interface PatchFile {
	oldPath: string;
	newPath: string;
	/** The hunks, starting at `@@`. Empty for a pure rename, a mode change or a binary file. */
	patch: string;
	added?: boolean;
	deleted?: boolean;
	renamed?: boolean;
	binary?: boolean;
}

/**
 * A list of changed files as one patch.
 *
 * The headers are written the way git writes them, because that is what the parser on the other
 * side recognises — in particular `new file mode` and `deleted file mode`, which are the only
 * reliable signal of what happened to a file: a new file's hunks look exactly like an edit that
 * happens to start at line 1.
 */
export function assembleDiff(files: PatchFile[]): string {
	const out: string[] = [];

	for (const file of files) {
		const from = file.oldPath || file.newPath;
		const to = file.newPath || file.oldPath;
		if (!from && !to) continue;

		out.push(`diff --git a/${from} b/${to}`);
		if (file.added) out.push("new file mode 100644");
		else if (file.deleted) out.push("deleted file mode 100644");
		// After the mode line, so a renamed *and* edited file still reports the rename — the parser
		// takes the path from here and keeps reading hunks afterwards.
		if (file.renamed && from !== to) {
			out.push(`rename from ${from}`);
			out.push(`rename to ${to}`);
		}

		if (file.binary) {
			out.push(`Binary files a/${from} and b/${to} differ`);
			continue;
		}

		const body = file.patch.replace(/\n+$/, "");
		if (!body) continue;

		/*
		 * `/dev/null` on the side that does not exist.
		 *
		 * Not decoration: a diff whose `---` names a real path for a file being created is a diff
		 * that `git apply` rejects, and someone will eventually copy one of these out of the app.
		 */
		out.push(file.added ? "--- /dev/null" : `--- a/${from}`);
		out.push(file.deleted ? "+++ /dev/null" : `+++ b/${to}`);
		out.push(body);
	}

	return out.length ? `${out.join("\n")}\n` : "";
}
