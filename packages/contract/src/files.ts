/**
 * The project on disk: which folder it is, what is in it, reading and changing files, and the
 * clipboard those files are copied through.
 */

import type { ExtractedText } from "@plume/core/contract-types";

/**
 * Which project the window is pointed at.
 *
 * It used to carry uncommitted line counts as well, on the strength of a comment saying the review
 * panel's header showed them. Nothing did — the counter above the composer polls `git.stat`, which
 * is where a number that changes while you watch belongs. Two fields nobody read cost every reader
 * of this record a full working-tree diff; see `workspace-info.ts`.
 */
export interface WorkspaceInfo {
	path: string;
	name: string;
	isGitRepo: boolean;
	branch: string | null;
	/**
	 * Why git could not say whether this is a repository, when it could not say.
	 *
	 * Distinct from `isGitRepo: false`, which means git answered no. This is the case where the
	 * question never got through — git missing, a checkout owned by someone else — and where the
	 * panel would otherwise offer to `git init` a directory that is already a repository.
	 */
	gitProblem?: string;
	/**
	 * The project this is a worktree of, when the window shows a conversation that runs in one.
	 *
	 * Filled in by the renderer from `SessionMeta.worktree` (`sessionWorkspace`), never by the main
	 * process: a worktree someone made by hand and opened as a project is a project of its own. `path`
	 * stays the worktree — its branch, its changes and its files are the conversation's — and a new
	 * conversation started from here starts in this one instead.
	 */
	worktreeOf?: string;
}

export interface FileEntry {
	name: string;
	/** Absolute, so the renderer never has to join paths itself. */
	path: string;
	isDirectory: boolean;
	size: number;
}

/**
 * What came of a create, rename, copy or delete.
 *
 * One shape for all of them so the panel has one thing to handle. `code` is what makes a failure
 * actionable rather than merely reported: `exists` is the one the caller can retry after asking
 * whether to replace, and the panel's replace prompt keys off exactly that.
 */
export interface FileOpResult {
	ok: boolean;
	/** What the operation produced: the file created, the path renamed to, the free name found. */
	path?: string;
	error?: string;
	code?: "exists" | "denied" | "descendant" | "invalid";
}

export interface FileContents {
	/** Granted contextual files outside the project are readable, never writable through this channel. */
	readOnly?: boolean;
	text: string;
	/** True when the file was longer than the read cap and only its head is here. */
	truncated: boolean;
	bytes: number;
	/** Set instead of `text` when the bytes are not text at all. */
	binary?: boolean;
	/** `mtimeMs` at the read. The media URL carries it, so a file overwritten in place is fetched again — see `mediaUrl`. */
	modifiedAt?: number;
}

/** One grid: a sheet of a workbook, or a table of a database. */
export interface DocumentSheet {
	name: string;
	/** Column headers. For a spreadsheet these are A, B, C…; for a table, its columns. */
	columns: string[];
	/** Row-major cells, already stringified — the window draws them, it does not compute with them. */
	rows: string[][];
	/**
	 * How many rows there are in total, which is not always how many are here.
	 *
	 * A table with two million rows is not something anybody scrolls, and shipping it across the
	 * boundary would cost more than the app has. The grid shows what arrived and says what was left.
	 */
	total: number;
}

export interface DocumentData {
	kind: "sheets" | "tables";
	sheets: DocumentSheet[];
	/** Set when the file could not be read at all, in the user's own language. */
	error?: string;
}

export interface WorkspaceApi {
	/** Show the project directory in the OS file manager. */
	reveal(path: string): Promise<void>;
	pick(): Promise<WorkspaceInfo | null>;
	info(path: string): Promise<WorkspaceInfo | null>;
}

/**
 * Reading the project's files, for the panel's file browser.
 *
 * Confined to the open project: both calls refuse a path outside it. The browser is for
 * looking at what you are working on, and a file picker that can wander into the rest of
 * the disk is a different, riskier thing than what was asked for.
 */
export interface FilesApi {
	list(dir: string): Promise<FileEntry[]>;
	read(path: string): Promise<FileContents | null>;
	/**
	 * A spreadsheet or a SQLite database, as sheets of cells.
	 *
	 * Null when the path is outside every open project or is not a file. The reader's own
	 * failures come back inside the value, as `error` — a corrupt workbook is something to show,
	 * not something to throw. See `electron/documents.ts`.
	 */
	document(path: string): Promise<DocumentData | null>;
	/**
	 * The file's own bytes, for the formats the window parses itself — `.docx` is the one.
	 *
	 * Null outside every open project, for a directory, or past the size cap.
	 */
	bytes(path: string): Promise<Uint8Array | null>;
	/**
	 * The bytes behind a `ly-media://` URL.
	 *
	 * The window's origin is `file://` and the scheme is not CORS-enabled, so the renderer can show
	 * these pictures but cannot read them: `fetch` is refused and a canvas they are drawn on is
	 * tainted. Copying, saving or attaching one needs its bytes, and only this side can get them.
	 */
	media(url: string): Promise<{ data: Uint8Array; mimeType: string } | null>;
	/**
	 * 一份文档里的字，抽给模型读——PDF、Word、Excel、PowerPoint，以及压缩包的清单。
	 *
	 * 收字节不收路径：服务的是输入框里拖进来的文件，那些是浏览器的 `File`，本来就没有磁盘路径。
	 *
	 * `null` 的意思是「这个格式这里读不了」，和「读了但里面没字」是两件事——后者会带着
	 * `imageOnly` 回来（扫描版 PDF 就是这样）。调用方要分开说，见 `Composer.addFiles`。
	 */
	documentText(name: string, bytes: Uint8Array): Promise<ExtractedText | null>;
	/**
	 * A URL the renderer can put in `src` for images, video and audio.
	 *
	 * Served over a private scheme whose handler re-checks the project boundary, so media
	 * streams (with range requests, so a video can seek) instead of being base64'd through
	 * IPC — a 40MB clip would otherwise have to become a 55MB string first.
	 *
	 * `version` (the file's `modifiedAt`) goes into the query. Chromium reuses a picture it has already
	 * loaded under the same URL for the rest of the page's life, so a file overwritten in place — an agent
	 * writing a fresh QR code to the same name — kept showing the old one. The handler reads only the path.
	 */
	mediaUrl(path: string, version?: number): string;

	/*
	 * Changing files, not just reading them.
	 *
	 * Every one of these is confined to the open project the same way reading is, and every one
	 * reports what happened as data — see `FileOpResult`. Implemented in `ipc/file-ops.ts`.
	 */
	create(dir: string, name: string, kind: "file" | "directory"): Promise<FileOpResult>;
	/** Rename or move; the two are the same call with a different parent. */
	rename(from: string, to: string, overwrite?: boolean): Promise<FileOpResult>;
	copy(from: string, to: string, overwrite?: boolean): Promise<FileOpResult>;
	/** To the OS trash, where it can be put back. */
	trash(paths: string[]): Promise<FileOpResult>;
	/** Permanently. Deliberately a different call from `trash`, not a flag on it. */
	remove(paths: string[]): Promise<FileOpResult>;
	/** A name nothing in `dir` uses yet — `report copy.md` — for duplicating and pasting. */
	uniquePath(dir: string, name: string): Promise<FileOpResult>;
	exists(path: string): Promise<boolean>;
	/** What a relative path written in a reply points at inside the project `root` — see `file-locate.ts`. */
	locate(root: string, relative: string): Promise<string[]>;
	/** Copy paths in from outside the app; only the destination is inside the project. */
	importInto(sources: string[], dir: string): Promise<FileOpResult>;
	/**
	 * The path behind a dropped `File`.
	 *
	 * `File.path` was removed in Electron 32; `webUtils.getPathForFile` is what replaced it,
	 * and it only exists in the preload. Synchronous, because a drop handler has to read the
	 * transfer list before the event returns.
	 */
	pathForDrop(file: File): string;
	/** Open native dialog to pick files or directories. */
	pick(options?: { directory?: boolean; multiple?: boolean }): Promise<string[]>;
}

/**
 * The system clipboard, for text.
 *
 * Through the main process rather than `navigator.clipboard`, whose read half needs a
 * permission prompt that never arrives in a packaged app — so paste in a context menu would
 * work in dev and silently do nothing once shipped.
 */
export interface ClipboardApi {
	read(): Promise<string>;
	write(text: string): Promise<void>;
	/**
	 * A picture on the clipboard, as a picture.
	 *
	 * `write` puts text there; pasting that into a chat window gives you a line of characters.
	 * Copying an image has to go through the image format or it is not copying the image.
	 * False when the data URL decoded to nothing.
	 */
	writeImage(dataUrl: string): Promise<boolean>;
}
