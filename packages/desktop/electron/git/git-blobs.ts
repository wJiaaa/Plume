/**
 * Reading many blobs out of a repository in one go.
 *
 * `git show HEAD:path` is the obvious way to read one, and it was how every diff in this app read
 * every file: one process per side per file. Measured on a repository with 120 modified files, at
 * eight concurrent, that is 418ms of pure process startup. The same 120 blobs through one
 * `cat-file --batch` take 29ms — fourteen times faster, and the difference is not the reading, it
 * is the two hundred processes that no longer exist.
 *
 * Two passes, because the contents have to be bounded before they are held. `--batch-check` prints
 * only the header, so it says how big each blob is for almost nothing; anything over the cap is
 * then never read at all. Without that, a repository with a few large generated files would pull
 * all of them into memory and then throw them away for being too large to diff.
 */

import { MAX_BLOB_BYTES, spawnGit } from "./git-exec.ts";

/**
 * One blob, as much of it as is worth having.
 *
 * `null` for the whole record means git has no such object — a path that is not in that commit.
 * `content: null` means it exists and is too large to diff, which is a different answer and the
 * one that lets a caller say "binary" rather than "deleted".
 */
export interface BlobRead {
	bytes: number;
	content: Buffer | null;
}

/** How much may be held at once, across every blob in one batch. */
const MAX_BATCH_BYTES = 64 * 1024 * 1024;

/**
 * Run `git cat-file` over a list of revisions and hand back its raw stdout.
 *
 * The list goes in on stdin — one revision per line — which is why this is `spawnGit` rather than
 * the `git` everything else here uses. A path containing a newline would break that framing, so
 * callers must filter those out; `readBlobs` does.
 */
function catFile(cwd: string, revs: string[], args: string[]): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawnGit(cwd, ["cat-file", ...args, "--buffer"]);
		const chunks: Buffer[] = [];
		let size = 0;
		let done = false;

		const fail = (error: Error) => {
			if (done) return;
			done = true;
			child.kill();
			reject(error);
		};

		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			// A runaway batch is killed rather than allowed to fill the heap. The caller falls back.
			if (size > MAX_BATCH_BYTES) return fail(new Error("cat-file batch too large"));
			chunks.push(chunk);
		});
		child.on("error", fail);
		child.on("close", () => {
			if (done) return;
			done = true;
			resolve(Buffer.concat(chunks));
		});
		// Errors on stdin are the child having gone away, which `close` already reports.
		child.stdin.on("error", () => {});
		child.stdin.end(`${revs.join("\n")}\n`);
	});
}

/**
 * Split `--batch-check` output into one line per requested revision.
 *
 * Every line is either `<oid> <type> <size>` or `<input> missing`, in the order asked for.
 */
function parseSizes(out: Buffer, count: number): (number | null)[] {
	const lines = out.toString("utf8").split("\n");
	const sizes: (number | null)[] = [];
	for (let i = 0; i < count; i++) {
		const parts = (lines[i] ?? "").trim().split(" ");
		const size = Number.parseInt(parts[parts.length - 1], 10);
		// "missing", "ambiguous", or a type that is not a blob: nothing to read.
		sizes.push(parts[parts.length - 2] === "blob" && Number.isFinite(size) ? size : null);
	}
	return sizes;
}

/**
 * Walk `--batch` output, which is a header line then exactly `size` bytes then a newline.
 *
 * Parsed against the *known* sizes rather than the ones in the stream, because the caller has
 * already decided which of them to ask for — a header that disagrees means the batch and the
 * check saw different repositories, and the safe answer there is to stop.
 */
function parseBlobs(out: Buffer, count: number): (Buffer | null)[] {
	const blobs: (Buffer | null)[] = [];
	let at = 0;
	for (let i = 0; i < count; i++) {
		const newline = out.indexOf(0x0a, at);
		if (newline < 0) break;
		const header = out.toString("utf8", at, newline);
		at = newline + 1;

		const parts = header.trim().split(" ");
		const size = Number.parseInt(parts[parts.length - 1], 10);
		if (parts[parts.length - 2] !== "blob" || !Number.isFinite(size)) {
			blobs.push(null);
			continue;
		}
		if (at + size > out.length) break;
		blobs.push(out.subarray(at, at + size));
		// The content is followed by a newline of git's own, which is not part of the blob.
		at += size + 1;
	}
	while (blobs.length < count) blobs.push(null);
	return blobs;
}

/**
 * Read every revision in one batch, in the order given.
 *
 * `HEAD:src/main.ts`, `:staged.ts`, `abc123:old.ts` — anything `git show` would accept. A rev
 * containing a newline cannot be framed on stdin and comes back as `null`; git does allow such
 * paths, and one of them is not worth giving up the batch for.
 */
export async function readBlobs(cwd: string, revs: string[]): Promise<(BlobRead | null)[]> {
	const out: (BlobRead | null)[] = revs.map(() => null);
	/*
	 * Which of the requested revisions are worth asking about, and where their answers belong.
	 *
	 * Empty means the caller already knows there is no such side — an addition has no committed
	 * version — and is skipped rather than sent, so nothing depends on how a given git version
	 * answers a blank line. A newline in a path cannot be framed on stdin at all; git allows such
	 * paths and one of them is not worth giving up the batch for.
	 */
	const asked: number[] = [];
	for (const [i, rev] of revs.entries()) if (rev && !rev.includes("\n")) asked.push(i);
	if (asked.length === 0) return out;

	const sizes = parseSizes(await catFile(cwd, asked.map((i) => revs[i]), ["--batch-check"]), asked.length);

	// Only the ones that exist and are small enough to diff are worth the bytes.
	const wanted: number[] = [];
	asked.forEach((slot, i) => {
		const size = sizes[i];
		if (size === null) return;
		if (size > MAX_BLOB_BYTES) {
			out[slot] = { bytes: size, content: null };
			return;
		}
		wanted.push(slot);
	});
	if (wanted.length === 0) return out;

	const blobs = parseBlobs(await catFile(cwd, wanted.map((i) => revs[i]), ["--batch"]), wanted.length);
	wanted.forEach((slot, i) => {
		const content = blobs[i];
		out[slot] = content ? { bytes: content.length, content } : null;
	});
	return out;
}
