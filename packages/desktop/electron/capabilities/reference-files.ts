import { realpath } from "node:fs/promises";

// A listed skill authorizes reading that file; it does not authorize its parent's settings or writes.
const readable = new Set<string>();

export async function registerReferenceFiles(paths: string[]): Promise<void> {
	for (const path of paths) {
		const resolved = await realpath(path).catch(() => null);
		if (resolved) readable.add(resolved);
	}
}

export async function referenceFile(path: string): Promise<string | null> {
	const resolved = await realpath(path).catch(() => null);
	return resolved && readable.has(resolved) ? resolved : null;
}
