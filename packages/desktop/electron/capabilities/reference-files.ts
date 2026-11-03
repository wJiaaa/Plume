import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isRemoteOrDevicePath } from "../../shared/remote-path.ts";

// A listed skill authorizes reading that file; it does not authorize its parent's settings or writes.
const readable = new Set<string>();

export async function registerReferenceFiles(paths: string[]): Promise<void> {
	for (const path of paths) {
		const resolved = await realpath(path).catch(() => null);
		if (resolved) readable.add(resolved);
	}
}

export async function referenceFile(path: string): Promise<string | null> {
	if (typeof path !== "string" || path.length === 0) return null;
	/*
	 * A share is matched by the letter before `realpath` touches it: on Windows resolving an arbitrary
	 * `\\host\share\…` already connects to that host and offers it the user's NTLM credentials. A
	 * skill that really lives on a share was registered under that same spelling, so it still reads.
	 */
	if (isRemoteOrDevicePath(path) && !readable.has(resolve(path))) return null;
	const resolved = await realpath(path).catch(() => null);
	return resolved && readable.has(resolved) ? resolved : null;
}
