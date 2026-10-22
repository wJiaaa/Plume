/**
 * Path helper for screenshot destination directory.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveSaveDirectory(customPath?: string, defaultDesktop?: string): string {
	if (customPath && customPath.trim()) {
		const expanded = customPath.startsWith("~") ? join(homedir(), customPath.slice(1)) : customPath;
		return expanded;
	}
	return defaultDesktop || join(homedir(), "Desktop");
}
