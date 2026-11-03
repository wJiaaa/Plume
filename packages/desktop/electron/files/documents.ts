/**
 * Files that are documents rather than text: spreadsheets and databases, read into a shape the
 * window can draw as a table.
 *
 * Read here rather than in the renderer for the same reason everything else on this side is: these
 * are files on disk behind a project boundary, and a parser that runs in the page would need the
 * bytes handed to it anyway. Doing the work here also means the renderer receives rows — small,
 * structured, already bounded — rather than a forty-megabyte workbook it has to keep alive.
 *
 * Both formats come back as the same thing: named sheets of cells. A spreadsheet has sheets and a
 * database has tables, and once you are drawing a grid the difference is what the tab is called.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { DocumentData, DocumentSheet } from "@plume/contract";
import { nativeText } from "../i18n.ts";

/**
 * How much of a sheet is worth moving.
 *
 * Two thousand rows is more than anyone reads in a preview pane and small enough to render without
 * virtualising. What is cut off is said on screen rather than silently dropped.
 */
const MAX_ROWS = 2000;
/** Columns past this are almost always empty padding a tool left behind. */
const MAX_COLUMNS = 64;

/**
 * A workbook, sheet by sheet.
 *
 * `raw: false` so what comes back is what Excel shows — a date as a date, a percentage as a
 * percentage — rather than the serial number underneath it. Someone previewing a spreadsheet wants
 * the spreadsheet, not its storage format.
 */
export async function readWorkbook(path: string): Promise<DocumentData> {
	try {
		const { read, utils } = await import("xlsx");
		const workbook = read(await readFile(path), { type: "buffer", cellDates: true, dense: false });

		const sheets = workbook.SheetNames.slice(0, 32).map((name) => {
			const sheet = workbook.Sheets[name];
			const grid = utils.sheet_to_json<string[]>(sheet, {
				header: 1,
				raw: false,
				defval: "",
				blankrows: false,
			}) as unknown as string[][];

			const width = Math.min(MAX_COLUMNS, Math.max(0, ...grid.map((row) => row.length)));
			return {
				name,
				/*
				 * Spreadsheet column letters, not the first row.
				 *
				 * Whether row 1 is a header is a guess, and a wrong guess eats a row of data. Excel
				 * itself does not guess: it labels the columns A, B, C and leaves the first row where
				 * it is, which is also what makes a cell reference in a formula readable.
				 */
				columns: Array.from({ length: width }, (_, index) => utils.encode_col(index)),
				rows: grid.slice(0, MAX_ROWS).map((row) => padTo(row.map(cell), width)),
				total: grid.length,
			};
		});

		return { kind: "sheets", sheets };
	} catch (error) {
		return { kind: "sheets", sheets: [], error: describe(error) };
	}
}

/** Long enough for a large table on a slow disk, short enough that nobody sits watching a spinner. */
const DATABASE_TIMEOUT_MS = 5000;

/**
 * A SQLite database, table by table.
 *
 * `node:sqlite` rather than a dependency: it is in the runtime Electron already ships, it opens
 * files read-only, and adding a native module to this app for a preview pane would mean rebuilding
 * it per platform on every release.
 *
 * Read in a child process rather than here. `DatabaseSync` is synchronous, and a view built on a
 * recursive CTE never finishes: run on the main process it froze every window for good. Why a
 * process and not a worker is in `database-reader.ts`.
 */
export async function readDatabase(path: string, timeoutMs = DATABASE_TIMEOUT_MS): Promise<DocumentData> {
	/*
	 * Beside this file, with this file's extension: `out/main/database-reader.js` in the build (a
	 * second entry, see `electron.vite.config.ts`), the `.ts` source under the tests. Built from
	 * `import.meta` rather than a `new URL(…)` literal, which the bundler would copy as an asset.
	 */
	const entry = join(import.meta.dirname, `database-reader${extname(import.meta.filename)}`);
	// 子进程不引主进程的文案表（见 `database-reader.ts` 顶上），BLOB 那一格的说法由这里按界面语言交给它。
	const args = [...(entry.endsWith(".ts") ? ["--experimental-strip-types", "--no-warnings"] : []), entry, path, nativeText("documents.blob", { n: "{n}" })];

	return new Promise((resolve) => {
		const names: string[] = [];
		const sheets: DocumentSheet[] = [];
		let failure: string | undefined;
		let pending = "";
		let settled = false;
		const finish = (data: DocumentData): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(data);
		};
		const take = (line: string): void => {
			if (!line) return;
			try {
				const message = JSON.parse(line) as { names?: string[]; sheet?: DocumentSheet; error?: string };
				if (message.names) names.push(...message.names);
				if (message.sheet) sheets.push(message.sheet);
				if (message.error) failure = message.error;
			} catch {
				// A line that is not ours (a stray warning) says nothing about the database.
			}
		};

		/*
		 * `ELECTRON_RUN_AS_NODE` because in the app `process.execPath` is Plume, not Node — without it
		 * this would start a second copy of the app. Under plain Node the variable does nothing.
		 */
		const child = spawn(process.execPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "1" },
			windowsHide: true,
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			const stuck = names[sheets.length];
			finish({
				kind: "tables",
				sheets: [],
				error: stuck
					? nativeText("documents.timeoutAt", { name: stuck, seconds: timeoutMs / 1000 })
					: nativeText("documents.timeout", { seconds: timeoutMs / 1000 }),
			});
		}, timeoutMs);

		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			pending += chunk;
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) take(line);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < 4000) stderr += chunk;
		});
		child.on("error", (error) => finish({ kind: "tables", sheets: [], error: describe(error) }));
		child.on("close", (code) => {
			take(pending);
			if (failure !== undefined || code !== 0) {
				finish({ kind: "tables", sheets: [], error: describe(failure ?? (stderr.trim() || `exit ${code}`)) });
				return;
			}
			finish({ kind: "tables", sheets });
		});
	});
}

/**
 * One value, as text.
 *
 * A BLOB is described rather than decoded: it is bytes, frequently an image, and pasting its
 * contents into a table cell produces a screenful of noise where a size would have been useful.
 */
function cell(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (value instanceof Uint8Array) return `[${value.length} 字节]`;
	if (value instanceof Date) return value.toISOString().replace("T", " ").slice(0, 19);
	return String(value);
}

function padTo(row: string[], width: number): string[] {
	const out = row.slice(0, width);
	while (out.length < width) out.push("");
	return out;
}

function describe(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `打不开这个文件：${message}`;
}
