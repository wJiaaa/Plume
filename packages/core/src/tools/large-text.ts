/**
 * A window of lines from a file too big to load whole.
 *
 * `read` used to `readFile` and `split` every file, whatever its size: a 2 GB log became a 2 GB
 * buffer, then a string of twice that, then an array of every line — to show the model at most
 * `OUTPUT_BUDGET` characters of it. Above `STREAM_ABOVE_BYTES` the file is streamed instead: every
 * newline is counted, so "showing lines a-b of N" stays exact, and only the lines inside the window
 * are ever decoded.
 */

import { createReadStream } from "node:fs";
import { MAX_LINE_CHARS } from "./long-line.ts";
import { looksBinary } from "./paths.ts";

/**
 * Far past any source file an outline would help with — an outline has to fit one result — and
 * small enough that loading it whole stays a few tens of megabytes of memory at worst.
 */
export const STREAM_ABOVE_BYTES = 8 * 1024 * 1024;

/**
 * How much of one line is kept. A minified bundle or a JSON dump can be a single line of the whole
 * file; past this, `char_offset` cannot reach and the result says so.
 */
export const LINE_KEEP_BYTES = 1024 * 1024;

export interface LineWindowRead {
	/** A NUL in the first chunk, the same test `looksBinary` puts to a whole small file. */
	binary: boolean;
	totalLines: number;
	/** The lines from `offset`, as many as `limit` and the output budget leave room for. */
	lines: string[];
	/** 1-indexed numbers of the lines cut at `LINE_KEEP_BYTES`. */
	cut: number[];
}

/**
 * Lines `offset` (1-indexed) onwards, read the way `decodeText` reads a small file: no BOM, `\n`
 * breaks, a final newline not starting another line. A `\r` before each `\n` is dropped line by
 * line — for an all-CRLF file that is exactly `decodeText`; a file mixing the two loses the `\r`
 * on display, which only the bytes on disk would show anyway.
 *
 * Lines stop being collected once the rows they would render are sure to pass `budget`, so the
 * caller's renderer runs out of room before it runs out of lines and says where to continue.
 */
export async function readLineWindow(
	path: string,
	offset: number,
	limit: number,
	charStart: number,
	budget: number,
	signal?: AbortSignal,
): Promise<LineWindowRead> {
	const from = offset - 1;
	const to = from + limit;
	const lines: string[] = [];
	const cut: number[] = [];
	let line = 0;
	let parts: Buffer[] = [];
	let kept = 0;
	let overflow = false;
	let collecting = true;
	let used = 0;
	let first = true;
	let endsWithNewline = false;

	const wanted = () => collecting && line >= from && line < to;
	const endLine = () => {
		if (wanted()) {
			let text = Buffer.concat(parts).toString("utf8");
			if (line === 0 && text.startsWith("\uFEFF")) text = text.slice(1);
			if (text.endsWith("\r")) text = text.slice(0, -1);
			lines.push(text);
			if (overflow) cut.push(line + 1);
			/*
			 * At least what `renderLines` will spend on it — the line and its `→`, or one character
			 * window of it. A lower bound, so the renderer is always the one that runs out first and
			 * its "output capped" footer stays true.
			 */
			const inline = text.length <= MAX_LINE_CHARS && charStart <= 0;
			used += inline ? text.length + 2 : Math.max(0, Math.min(MAX_LINE_CHARS, text.length - charStart) - 1);
			if (used > budget) collecting = false;
		}
		parts = [];
		kept = 0;
		overflow = false;
		line += 1;
	};

	const stream = createReadStream(path, { highWaterMark: 1024 * 1024, signal });
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		if (first) {
			first = false;
			if (looksBinary(chunk)) {
				stream.destroy();
				return { binary: true, totalLines: 0, lines: [], cut: [] };
			}
		}
		let pos = 0;
		while (pos < chunk.length) {
			const newline = chunk.indexOf(10, pos);
			const end = newline === -1 ? chunk.length : newline;
			if (wanted() && end > pos) {
				const room = LINE_KEEP_BYTES - kept;
				if (end - pos > room) overflow = true;
				if (room > 0) {
					// Copied: a view would keep the whole megabyte chunk alive for a few bytes of line.
					const piece = Buffer.from(chunk.subarray(pos, Math.min(end, pos + room)));
					parts.push(piece);
					kept += piece.length;
				}
			}
			if (newline === -1) break;
			endLine();
			pos = newline + 1;
		}
		endsWithNewline = chunk.length > 0 && chunk[chunk.length - 1] === 10;
	}
	// The last line, unless the file ended on a newline — `split` and then dropping the final "".
	if (!endsWithNewline || line === 0) endLine();
	return { binary: false, totalLines: line, lines, cut };
}
