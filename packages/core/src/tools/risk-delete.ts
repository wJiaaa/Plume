/**
 * What a delete removes.
 *
 * `rm`, PowerShell's and cmd's deleters, and `find` with `-delete` or `-exec` all come down to the
 * same question — which paths go — so they are answered by the same rule, in one place. A second
 * copy of "what is a reckless target" is a second place for the answer to drift.
 *
 * Every function here takes the command's words with quotes already resolved (`risk.ts` makes that
 * list once): `rm -rf '/'` deletes `/`, and a rule that saw `'/'` saw nothing it knew.
 */

import { isAbsolute } from "node:path";
import { SAFE, risky, underScratchRoot, wipesScratchRoot, type RiskVerdict } from "./risk-shared.ts";

/** Absolute on either platform's terms: `/x`, `\x`, `C:\x`, `C:/x`, Git Bash's `/c/x`. */
const absoluteAnywhere = (path: string) => isAbsolute(path) || /^([A-Za-z]:[\\/]|[\\/])/.test(path);

/** `..` as a path segment, whichever separator wrote it. */
export const climbsOut = (path: string) => path.split(/[\\/]/).includes("..");

/**
 * A path the shell has not resolved yet: `$HOME`, `${DIR}`, PowerShell's `$env:USERPROFILE`, cmd's
 * `%USERPROFILE%`. What it deletes is decided at run time, so it is judged as the worst it could be.
 */
const unexpanded = (target: string) => /\$|%[^%\s]+%/.test(target);

/** PowerShell's and cmd's delete commands, lower-cased. `rm` is judged by the POSIX rule. */
export const WINDOWS_DELETERS = new Set(["remove-item", "ri", "del", "erase", "rd", "rmdir"]);

/**
 * A wildcard with nothing in front of it.
 *
 * `rm -rf *` is the working directory and everything in it — the command people mean when they
 * warn you about `rm -rf`. `rm -rf server/data/uploads/*` is a named directory being emptied,
 * which is what re-seeding a database or clearing an upload folder looks like, and is no more
 * dangerous than deleting that directory. Treating the two as the same thing meant ordinary
 * housekeeping stopped an unattended run.
 *
 * The test is whether anything survives removing the wildcard segments: `*` and `./*` leave
 * nothing; `a/b/*` leaves `a/b`.
 */
function bareGlob(target: string): boolean {
	if (!/[*?]/.test(target)) return false;
	const prefix = target
		.split("/")
		.filter((segment) => !/[*?]/.test(segment))
		.filter((segment) => segment !== "" && segment !== ".");
	return prefix.length === 0 || prefix.includes("..");
}

/**
 * A recursive delete of these targets, judged at the user's direction.
 *
 * Clearing `src/data` to reseed a database, or `dist` to rebuild, is a step inside work that was
 * asked for, and stopping at each one is what stops an unattended run being unattended. The user
 * chose this trade explicitly: relative paths inside the workspace proceed; the workspace itself
 * (`.`), a bare wildcard, a home or absolute path, a variable, anything climbing out with `..`, and
 * any chain that has `cd`-ed elsewhere first still ask.
 */
function recursiveDelete(targets: readonly string[], contained: boolean, cwd?: string): RiskVerdict {
	const reckless = targets.some(
		(t) =>
			!t ||
			unexpanded(t) ||
			t.startsWith("~") ||
			t === "." ||
			t === ".." ||
			bareGlob(t) ||
			wipesScratchRoot(t, cwd) ||
			(isAbsolute(t) && !underScratchRoot(t, cwd)),
	);
	if (targets.length === 0 || reckless || targets.some(climbsOut) || !contained) return risky("recursive-delete");
	return SAFE;
}

/** `rm`'s options and its operands; after `--` everything is an operand. */
function options(args: readonly string[]): { flags: string[]; targets: string[] } {
	const end = args.indexOf("--");
	const before = end === -1 ? args : args.slice(0, end);
	const flags = before.filter((word) => word.startsWith("-"));
	const targets = [...before.filter((word) => !word.startsWith("-")), ...(end === -1 ? [] : args.slice(end + 1))];
	return { flags, targets };
}

/** `rm`, by what it removes: removing a file is routine, removing a tree is not. */
export function judgeRm(args: readonly string[], contained: boolean, cwd?: string): RiskVerdict {
	const { flags, targets } = options(args);
	// Long options too: `--recursive` is `-r`. `-rf` is one word carrying both flags.
	if (flags.some((flag) => /^-[a-zA-Z]*[rR]/.test(flag) || flag === "--recursive")) {
		const verdict = recursiveDelete(targets, contained, cwd);
		if (verdict.risky) return verdict;
	}
	/*
	 * A glob delete is judged by where it points, not by the glob.
	 *
	 * Rebuilding a database or clearing a build directory is ordinary work — and it is what
	 * `rm -f data/blog.db*` is. What cannot be taken back is the same command aimed outside
	 * the project, so that is what this asks about: an absolute, home-relative or not-yet-expanded
	 * target, or a chain that has stepped out of the workspace first.
	 */
	if (flags.some((flag) => /^-[a-zA-Z]*f/.test(flag) || flag === "--force") && targets.some((t) => /[*?]/.test(t))) {
		const outside = targets.some(
			(t) => unexpanded(t) || t.startsWith("~") || wipesScratchRoot(t, cwd) || (isAbsolute(t) && !underScratchRoot(t, cwd)),
		);
		if (outside || !contained) return risky("force-delete-glob");
	}
	if (targets.some((t) => t === "/" || t === "~" || t === "~/")) return risky("delete-root-or-home");
	return SAFE;
}

/**
 * PowerShell's and cmd's recursive deletes, by the same rule as `rm -r`.
 *
 * `-Recurse` may be abbreviated to any unambiguous prefix down to `-r`, in any case, and takes
 * `:$true` after it; cmd spells it `/s`. Targets are judged the same way, except that an absolute
 * path counts in either platform's spelling and the wildcard in either separator.
 */
export function judgeWindowsDelete(args: readonly string[], contained: boolean): RiskVerdict {
	const recursive = args.some((word) => /^-r(e(c(u(r(s(e)?)?)?)?)?)?(:|$)/i.test(word) || /^\/s$/i.test(word));
	if (!recursive) return SAFE;
	const targets = args.filter((word) => !word.startsWith("-") && !/^\/[a-z]$/i.test(word));
	const reckless = targets.some(
		(t) =>
			!t ||
			unexpanded(t) ||
			t.startsWith("~") ||
			t === "." ||
			t === ".." ||
			bareGlob(t.replaceAll("\\", "/")) ||
			absoluteAnywhere(t),
	);
	if (targets.length === 0 || reckless || targets.some(climbsOut) || !contained) return risky("recursive-delete");
	return SAFE;
}

/** Tests that narrow what `find` matches — with one, it is not the whole tree under its start. */
const FIND_FILTERS = new Set([
	"-name",
	"-iname",
	"-path",
	"-ipath",
	"-wholename",
	"-iwholename",
	"-regex",
	"-iregex",
	"-type",
	"-newer",
	"-mtime",
	"-mmin",
	"-atime",
	"-amin",
	"-ctime",
	"-cmin",
	"-size",
	"-empty",
	"-user",
	"-group",
	"-perm",
]);

/**
 * What `find` would hand to `-delete` or `{}`: a path for each place it starts from.
 *
 * Without a filter, `find p -delete` is `rm -rf p` and `{}` is `p` itself among everything under
 * it. With one, it is something *under* `p` — written `p/{}` so the delete rule can still see that
 * `/{}` is absolute, `~/{}` is home and `../{}` climbs out, while `./{}` (`find . -name '*.pyc'
 * -delete`, the commonest cleanup there is) is inside the workspace.
 */
function findTargets(args: readonly string[]): { targets: string[]; expression: string[] } {
	let i = 0;
	// `-H`, `-L`, `-P`, `-O3` and `-D debugopts` come before the paths.
	while (i < args.length && (/^-[HLP]+$/.test(args[i]) || /^-O\d*$/.test(args[i]) || args[i] === "-D")) i += args[i] === "-D" ? 2 : 1;
	const starts: string[] = [];
	while (i < args.length && !/^[-(!),]/.test(args[i])) starts.push(args[i++]);
	const expression = args.slice(i);
	const filtered = expression.some((word) => FIND_FILTERS.has(word));
	const targets = (starts.length > 0 ? starts : ["."]).map((start) => (filtered ? `${start.replace(/\/+$/, "")}/{}` : start));
	return { targets, expression };
}

/** `find … -delete`, judged as the recursive delete it is. */
export function judgeFind(args: readonly string[], contained: boolean, cwd?: string): RiskVerdict {
	const { targets, expression } = findTargets(args);
	return expression.includes("-delete") ? recursiveDelete(targets, contained, cwd) : SAFE;
}

/** A word as the shell would need it written to read it back as one word. */
const quote = (word: string) => (/^[\w@%+=:,./~{}-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/**
 * The commands `find` runs through `-exec`, `-execdir`, `-ok` and `-okdir`, joined into one line —
 * or null if it runs none.
 *
 * `find / -exec rm -rf {} +` is `rm -rf` with the targets moved to the front of the line, so `{}` is
 * replaced by what it stands for and the result is judged like any other wrapped command.
 */
export function findExec(args: readonly string[]): string | null {
	const { targets, expression } = findTargets(args);
	const commands: string[] = [];
	for (let i = 0; i < expression.length; i++) {
		if (!/^-(exec|execdir|ok|okdir)$/.test(expression[i])) continue;
		const words: string[] = [];
		for (i += 1; i < expression.length && expression[i] !== ";" && expression[i] !== "+"; i++) {
			const word = expression[i];
			if (word === "{}") words.push(...targets);
			else words.push(word.replaceAll("{}", targets[0]));
		}
		if (words.length > 0) commands.push(words.map(quote).join(" "));
	}
	return commands.length > 0 ? commands.join("; ") : null;
}
