/**
 * macOS `open`, judged by what it would start.
 *
 * `open` hands its operand to LaunchServices, and LaunchServices starts the program in the user's
 * session — not as a child of this shell, so outside the sandbox the command was running in.
 * `open -g P.app`, where P runs `touch ~/x`, wrote to the home directory from a sandbox that denies
 * exactly that. Opening a document is different in kind: it starts the viewer the person chose for
 * that type, on a file they can see. So programs are asked about and documents are not — asking
 * about `open index.html` or `open .` would teach people to click through the card.
 */

import { SAFE, risky, type RiskVerdict } from "./risk-shared.ts";

/** Options that only mean anything when a program is being started, or that name one. */
const LAUNCH_OPTIONS = new Set(["-a", "-b", "--args", "-n", "--new", "--env", "--stdin", "--stdout", "--stderr"]);
/** Options that take the next word as their value, so it is not an operand. */
const TAKES_VALUE = new Set(["-a", "-b", "-s", "-u", "--env", "--stdin", "--stdout", "--stderr"]);

/**
 * Bundles that are programs, and files Finder runs rather than shows: `.command`/`.tool`/`.sh`
 * open in Terminal and execute, `.terminal` carries a command to run, the installer kinds install.
 */
const RUNS = /\.(app|command|tool|sh|terminal|workflow|action|pkg|mpkg|prefpane|saver)\/?$/i;
/** URL schemes that open a page or a draft. Any other scheme starts whichever app registered it, with the URL as its input. */
const VIEWS = /^(https?|mailto):/i;

export function judgeOpen(args: readonly string[]): RiskVerdict {
	for (let i = 0; i < args.length; i += 1) {
		const word = args[i];
		if (word === "--") continue;
		if (word.startsWith("--")) {
			const name = word.replace(/=.*$/, "");
			if (LAUNCH_OPTIONS.has(name)) return risky("launch-program");
			if (TAKES_VALUE.has(name) && !word.includes("=")) i += 1;
			continue;
		}
		if (/^-[A-Za-z]+$/.test(word)) {
			// Clustered short options: `-na Terminal` is `-n -a Terminal`.
			if (/[abn]/.test(word.slice(1))) return risky("launch-program");
			if (TAKES_VALUE.has(`-${word.slice(-1)}`)) {
				// `-u <url>`: the value is still something that gets opened.
				if (word.endsWith("u") && i + 1 < args.length && !opensDocument(args[i + 1])) return risky("launch-program");
				i += 1;
			}
			continue;
		}
		if (!opensDocument(word)) return risky("launch-program");
	}
	return SAFE;
}

/**
 * Whether opening this operand shows something rather than runs something.
 *
 * A name with no extension is not known to be a document: an executable file with no extension is
 * opened in Terminal and run. `.`, `..`, `~` and anything ending in `/` are directories, which open
 * in Finder.
 */
function opensDocument(operand: string): boolean {
	if (VIEWS.test(operand)) return true;
	const path = operand.replace(/^file:\/\//i, "");
	if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return false;
	if (RUNS.test(path)) return false;
	if (path === "." || path === ".." || path === "~" || /[\\/]$/.test(path)) return true;
	const name = path.replace(/^.*[\\/]/, "");
	return /.\.[A-Za-z0-9]+$/.test(name);
}
