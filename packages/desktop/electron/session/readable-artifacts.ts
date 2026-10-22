import { realpathSync } from "node:fs";
import { resolve } from "node:path";

// Grants come only from records the main process has actually produced, never from an IPC path.
const grants = new Map<string, string>();
export function grantArtifactRead(path: string): void {
	try { grants.set(resolve(path), realpathSync(path)); } catch { /* A removed source remains visible, but cannot be opened. */ }
}
export function readableArtifact(path: string): string | null {
	if (typeof path !== "string") return null;
	const raw = resolve(path), canonical = grants.get(raw);
	if (!canonical) return null;
	try { return realpathSync(raw) === canonical ? canonical : null; } catch { return null; }
}
