/**
 * Reads a SQLite database into sheets, in a process of its own: `documents.ts` starts it as
 * `<this executable> database-reader.js <path>` in Node mode and kills it when it runs too long.
 *
 * A process, not a worker thread, because what can run too long is SQLite itself. A view built on
 * a recursive CTE never finishes, and a thread stuck inside `sqlite3_step` cannot be stopped:
 * `Worker.terminate()` only takes effect once control is back in JavaScript, so the thread spins on
 * — and `process.exit` waits for it, which would have turned "the file pane hangs" into "the app
 * cannot quit". `node:sqlite` has no interrupt to call. Killing a process always works.
 *
 * Output is one JSON line per message: first `{ names }`, then one `{ sheet }` per table, so the
 * parent can say which table it was on when the clock ran out. Nothing here may import from the
 * rest of the app — it is a second entry of the main build and runs without it.
 */

import type { DocumentSheet } from "@plume/contract";

// The same bounds `documents.ts` puts on a workbook, and for the same reasons.
const MAX_ROWS = 2000;
const MAX_COLUMNS = 64;
const MAX_TABLES = 64;

interface Prepared {
	all(...params: unknown[]): unknown[];
}
interface Database {
	close(): void;
	prepare(sql: string): Prepared;
}

function emit(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main(path: string): Promise<void> {
	const { DatabaseSync } = await import("node:sqlite");
	/*
	 * Read-only is not a detail. This is a *preview* — opening someone's database in a file browser
	 * must not be able to write to it, and a journal file appearing beside a repository because you
	 * glanced at it would be a bug with a bad name.
	 */
	const database: Database = new DatabaseSync(path, { readOnly: true });
	try {
		const entries = database
			.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
			.all()
			.slice(0, MAX_TABLES)
			.map((row) => row as { name: unknown; type: unknown })
			.map((row) => ({ name: String(row.name), view: row.type === "view" }));
		emit({ names: entries.map((entry) => entry.name) });
		for (const entry of entries) emit({ sheet: readSheet(database, entry.name, entry.view) });
	} finally {
		database.close();
	}
}

function readSheet(database: Database, name: string, view: boolean): DocumentSheet {
	// Quoted by doubling, which is SQLite's own escape — a table really can be called `a"b`.
	const quoted = `"${name.replaceAll('"', '""')}"`;
	const rows = database.prepare(`SELECT * FROM ${quoted} LIMIT ${MAX_ROWS}`).all() as Record<string, unknown>[];
	/*
	 * A view is not counted. Counting it means running it to the end, and a view over a recursive
	 * CTE has no end — while `LIMIT` lets SQLite stop after the rows it was asked for. Its total is
	 * what arrived; the contract has no way to say "unknown" yet.
	 */
	const total = view ? rows.length : Number((database.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).all()[0] as { n: number }).n);
	const columns = rows.length > 0 ? Object.keys(rows[0]).slice(0, MAX_COLUMNS) : columnsOf(database, quoted);
	return { name, columns, rows: rows.map((row) => columns.map((column) => cell(row[column]))), total };
}

/** An empty table still has columns, and they are worth showing. */
function columnsOf(database: Database, quoted: string): string[] {
	try {
		return database
			.prepare(`PRAGMA table_info(${quoted})`)
			.all()
			.map((row) => String((row as { name: string }).name))
			.slice(0, MAX_COLUMNS);
	} catch {
		return [];
	}
}

/**
 * One value, as text.
 *
 * A BLOB is described rather than decoded: it is bytes, frequently an image, and pasting its
 * contents into a table cell produces a screenful of noise where a size would have been useful.
 */
function cell(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (value instanceof Uint8Array) return BLOB_LABEL.replace("{n}", String(value.length));
	return String(value);
}

/** `[{n} 字节]` 这一句，按界面语言由父进程传进来；单独跑这个文件时退回英文。 */
const BLOB_LABEL = process.argv[3] || "[{n} bytes]";

main(process.argv[2] ?? "").catch((error: unknown) => {
	emit({ error: error instanceof Error ? error.message : String(error) });
	process.exitCode = 1;
});
