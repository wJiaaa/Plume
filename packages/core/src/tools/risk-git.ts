/**
 * Git, judged by its arguments.
 *
 * Almost nothing git does is dangerous by name: `git reset` unstages a file and `git reset --hard`
 * throws away a day's work; `git push` shares and `git push origin :main` deletes. So the rules
 * here read the subcommand's flags rather than look the subcommand up, and a subcommand with no
 * dangerous flag is ordinary work — asking about `git reset HEAD file` or `git clean -n` is the
 * kind of prompt people learn to click through.
 */

import type { RiskCode } from "./risk-reasons.ts";
import { SAFE, risky, type RiskVerdict } from "./risk-shared.ts";
import { RISKY_SUBCOMMANDS } from "./risk-tables.ts";

/**
 * Git's subcommand, after its global options.
 *
 * Taken as `words[1]` before, which is the option rather than the subcommand the moment anything
 * global is present — and `git -c protocol.ext.allow=always push --force` is a force push whose
 * "subcommand" read as `-c`. Every git rule below then declined to apply.
 */
function gitSubcommand(argv: readonly string[]): { sub: string; args: string[] } {
	const TAKES_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
	let i = 1;
	while (i < argv.length) {
		const word = argv[i];
		if (TAKES_VALUE.has(word)) {
			i += 2;
			continue;
		}
		if (word.startsWith("-")) {
			i += 1;
			continue;
		}
		return { sub: word, args: argv.slice(i + 1) };
	}
	return { sub: "", args: [] };
}

/** Pathspecs that mean the whole tree — `git checkout .` throws away every unstaged change. */
const WHOLE_TREE = new Set([".", "./", ":/"]);

/**
 * Git subcommands whose danger is in their arguments rather than their name.
 *
 * `checkout` and `restore` sat in `RISKY_SUBCOMMANDS` without a rule that ever consulted the
 * table, so `git checkout .` and `git restore .` went through unasked. The line that matters is
 * `git checkout <branch>`: it is how anyone changes branch and refuses to clobber local edits on
 * its own, so only `-f`, a whole-tree pathspec or paths after `--` count.
 */
function gitArgumentRisk(sub: string, args: string[]): RiskCode | undefined {
	const has = (...flags: string[]) => args.some((arg) => flags.includes(arg));
	// Git accepts short flags bundled, so `-fd` is `-f -d` and `-df` is the same thing.
	const short = (letter: string) => args.some((arg) => /^-[A-Za-z]+$/.test(arg) && arg.includes(letter));
	const operands = args.filter((arg) => !arg.startsWith("-"));
	if (sub === "checkout") {
		const afterDashes = args.indexOf("--");
		const paths = afterDashes >= 0 && afterDashes < args.length - 1;
		if (has("-f", "--force") || paths || operands.some((arg) => WHOLE_TREE.has(arg))) return "overwrite-changes";
	}
	// Restoring the index alone keeps the edits; anything that touches the worktree drops them.
	if (sub === "restore" && (!has("-S", "--staged") || has("-W", "--worktree"))) return "discard-changes";
	// `git switch` refuses to clobber local edits unless told to, exactly like `git checkout <branch>`.
	if (sub === "switch" && (short("f") || has("--force", "--discard-changes"))) return "discard-changes";
	if (sub === "push") {
		// `--force-with-lease` is the careful form, but it still replaces the remote branch.
		if (short("f") || args.some((arg) => arg.startsWith("--force"))) return "force-push";
		/*
		 * `+main` is `--force` for that one ref; `--mirror` makes the remote match, deletions included;
		 * `--delete` and `:main` remove the remote branch outright. A lone `:` is git's "push the
		 * matching branches", which deletes nothing.
		 */
		const refspecs = operands.slice(1);
		if (has("--mirror")) return "force-push";
		if (has("--delete") || short("d") || refspecs.some((ref) => ref.startsWith(":") && ref.length > 1)) return "delete-branch";
		if (refspecs.some((ref) => ref.startsWith("+"))) return "force-push";
	}
	// `-d` refuses to delete a branch that is not merged; `-D` (or `-d --force`) drops its commits.
	if (sub === "branch" && (short("D") || ((short("d") || has("--delete")) && (short("f") || has("--force"))))) {
		return "delete-branch";
	}
	if (sub === "reset") {
		if (has("--hard")) return "hard-reset";
		// The other two forms that touch the worktree; `--soft`, `--mixed` and `reset <path>` keep every edit.
		if (has("--merge", "--keep")) return "discard-changes";
	}
	// `git clean` deletes nothing without `-f` (git's own default), and nothing at all with `-n`.
	if (sub === "clean" && (short("f") || has("--force")) && !(short("n") || has("--dry-run"))) return "delete-untracked";
	if (sub === "stash" && (operands[0] === "clear" || operands[0] === "drop")) return "discard-changes";
	if (sub === "worktree" && operands[0] === "remove" && has("-f", "--force")) return "discard-changes";
	return undefined;
}

/** A git command's verdict. `argv` is its words, quotes resolved and assignments gone. */
export function judgeGit(argv: readonly string[]): RiskVerdict {
	const { sub, args } = gitSubcommand(argv);
	const argumentRisk = gitArgumentRisk(sub, args);
	if (argumentRisk) return risky(argumentRisk);
	// Rewriting history is what `rebase` and `filter-branch` are for, whatever the flags.
	const code = RISKY_SUBCOMMANDS.get("git")?.get(sub);
	return code ? risky(code) : SAFE;
}
