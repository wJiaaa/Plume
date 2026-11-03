import type { DiffHunk } from "@plume/core";
import type { WorkspaceDiffFile } from "@plume/contract";

/**
 * The listed files, with contents filled in wherever they arrived.
 *
 * A commit's files are fetched twice: the list first, which is fast, and the diffs after, which are
 * not. Replacing one result with the other wholesale would undo the point of splitting them, for
 * two reasons.
 *
 * The list is the one that decides the layout, so it has to be the one that survives. The reader
 * only pays for the split once — when the list appears — and would pay again if the second answer
 * resized everything.
 *
 * And the second answer is not a superset. `diffRefs` drops a file whose blob is too large to read,
 * so a commit touching a lockfile lists more files than it can show diffs for. Taking the list as
 * the roster means those rows stay, saying they have nothing to compare line by line, which is both
 * true and better than the file vanishing from a review with no explanation.
 */
export function withContents(
	listed: WorkspaceDiffFile[],
	loaded: WorkspaceDiffFile[],
): WorkspaceDiffFile[] {
	// Nothing listed yet: the diffs beat the list here, which happens on a small commit.
	if (listed.length === 0) return loaded;
	const byPath = new Map(loaded.map((file) => [file.path, file]));
	return listed.map((file) => byPath.get(file.path) ?? file);
}

/**
 * A re-read diff, keeping the hunks already held for every file whose diff did not change.
 *
 * Every status change re-reads the whole working-tree diff, and every answer is new objects. The
 * syntax colours are cached by the hunks' identity (`useDiffHighlight`), so an expanded file that
 * nobody touched lost them: drawn uncoloured for a frame, then tokenized again — about 16ms for 880
 * lines, on every refresh, for a file that had not moved.
 */
export function keepUnchangedHunks(held: WorkspaceDiffFile[], next: WorkspaceDiffFile[]): WorkspaceDiffFile[] {
	if (held.length === 0) return next;
	const byPath = new Map(held.map((file) => [file.path, file]));
	return next.map((file) => {
		const before = byPath.get(file.path);
		return before && before.hunks !== file.hunks && sameHunks(before.hunks, file.hunks) ? { ...file, hunks: before.hunks } : file;
	});
}

function sameHunks(a: DiffHunk[], b: DiffHunk[]): boolean {
	return a.length === b.length && a.every((hunk, index) => {
		const other = b[index];
		return hunk.oldStart === other.oldStart && hunk.newStart === other.newStart && hunk.lines.length === other.lines.length
			&& hunk.lines.every((line, at) => {
				const twin = other.lines[at];
				return line.type === twin.type && line.text === twin.text && line.oldLine === twin.oldLine && line.newLine === twin.newLine;
			});
	});
}
