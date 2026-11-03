import { isAbsolute } from "node:path";
import { commandDialects, withinOrIs } from "../platform.ts";
import { WINDOWS_DELETERS, climbsOut, findExec, judgeFind, judgeRm, judgeWindowsDelete } from "./risk-delete.ts";
import { judgeGit } from "./risk-git.ts";
import { judgeOpen } from "./risk-open.ts";
import { SAFE, risky, scratchRoots, underScratchRoot, type RiskVerdict } from "./risk-shared.ts";
import {
	COMMAND_PREFIXES,
	FETCHERS,
	INTERPRETERS,
	NEVER_UNATTENDED,
	PLACES_FILES,
	PROTECTED_PATH,
	RISKY_SUBCOMMANDS,
	SECRET_PATH,
	SHELLS,
} from "./risk-tables.ts";
import { pipelines, splitCommands, splitWords, substitutionHosts, type Dialect } from "./shell-split.ts";
/**
 * How dangerous an operation is, so that "帮我批准" can mean what it says.
 *
 * The first version of this was an allow-list: a command was waved through only if its first
 * word was one of about thirty read-only programs, and *any* shell metacharacter disqualified
 * it outright. The reasoning was sound in isolation — `ls && rm -rf /` really does start with
 * `ls` — but the effect was that a mode advertised as "only ask about risky things" asked about
 * nearly everything, because models write `cd x && git log; echo ---` rather than bare `ls`.
 * A permission prompt that fires constantly is not a safety feature; it is something people
 * learn to click through, which is strictly worse than not having it.
 *
 * So this inverts: everything is allowed unless it matches something genuinely destructive.
 * The list below is not "things that write" — writing is the job — but "things you cannot take
 * back": deleting, force-pushing, rewriting history, escalating privileges, piping the network
 * into a shell, touching anything outside the project.
 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The words the shell will run: quotes resolved, leading `VAR=value` assignments gone.
 *
 * Every rule reads this one list. They used to split on whitespace each for themselves, and the
 * shell does not: `'rm' -rf ~` is `rm`, `rm -rf '/'` deletes `/`, and `HUSKY=0 git push --force` is
 * a force push whose words began `HUSKY=0`. Each of those was judged safe.
 */
function argvOf(command: string, dialect: Dialect): string[] {
	const words = splitWords(command, dialect);
	let i = 0;
	while (i < words.length && ASSIGNMENT.test(words[i])) i += 1;
	return words.slice(i);
}

/** `C:\Windows\System32\format.com` and `rm.exe` are `format` and `rm`. */
const programName = (word = "") => word.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|com)$/i, "");

function firstWord(command: string, dialect: Dialect = "posix"): string {
	return programName(argvOf(command, dialect)[0]);
}

/** A table lookup that also accepts Windows' case-insensitive spelling of the name. */
function lookup<T>(table: Map<string, T>, name: string): T | undefined {
	return table.get(name) ?? table.get(name.toLowerCase());
}

/**
 * What a wrapper wraps, or null if this command is not one.
 *
 * `firstWord` answers "what program is this", and for `env`, `xargs`, `nohup`, `timeout` and the
 * shells themselves the answer is not the program that does anything. So every rule below was
 * looking at the wrapper: `env rm -rf ~` was judged as `env` and `bash -c "rm -rf ~"` as `bash`,
 * and neither is on any list, so both were safe. That is not a gap in the tables — the tables are
 * about `rm` — it is a gap in deciding what to look up.
 */
function wrappedCommand(command: string, dialect: Dialect = "posix"): string | null {
	const words = argvOf(command, dialect);
	if (words.length < 2) return null;
	const head = words[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
	const lower = head.toLowerCase();

	/*
	 * PowerShell takes its command after `-Command` (any unambiguous prefix, any case), or base64
	 * of UTF-16 after `-EncodedCommand` — which is exactly how a command hides from a reader, so it
	 * is decoded and judged. cmd takes the rest of the line after `/c` or `/k`.
	 */
	if (lower === "powershell" || lower === "pwsh") {
		const encoded = words.findIndex((word, index) => index > 0 && /^-e(c|nc|ncodedcommand)?$/i.test(word));
		if (encoded !== -1 && words[encoded + 1]) return Buffer.from(words[encoded + 1], "base64").toString("utf16le");
		const at = words.findIndex((word, index) => index > 0 && /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(word));
		return at === -1 || at + 1 >= words.length ? null : words.slice(at + 1).join(" ");
	}
	if (lower === "cmd") {
		const at = words.findIndex((word, index) => index > 0 && /^\/[ck]$/i.test(word));
		return at === -1 || at + 1 >= words.length ? null : words.slice(at + 1).join(" ");
	}

	// A shell takes its command as one string, after `-c`. `-lc`, `-ec` and friends count.
	if (SHELLS.has(head)) {
		const at = words.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c$/.test(word));
		return at === -1 || at + 1 >= words.length ? null : words[at + 1];
	}
	// `eval` takes it as the rest of the line, however many words that is.
	if (head === "eval") return words.slice(1).join(" ");
	if (head === "find") return findExec(words.slice(1));

	if (!COMMAND_PREFIXES.has(head)) return null;

	let i = 1;
	// The wrapper's own options and any `VAR=value` it is setting.
	while (i < words.length && (words[i].startsWith("-") || ASSIGNMENT.test(words[i]))) {
		// `nice -n 10 cmd`, `timeout -k 5 …`, `xargs -n 1 cmd`: the option takes an argument.
		if (/^-[nPILsEek]$/.test(words[i]) && i + 1 < words.length) i += 1;
		i += 1;
	}
	// `timeout 30s cmd` and `watch 2 cmd`: a bare duration belongs to the wrapper.
	if ((head === "timeout" || head === "watch") && i < words.length && /^\d+(\.\d+)?[smhd]?$/.test(words[i])) i += 1;
	if (i >= words.length) return null;

	const inner = words.slice(i).join(" ");
	// A wrapper that wrapped nothing but itself would recurse forever.
	return inner === command.trim() ? null : inner;
}

/**
 * Judge one command — no chaining, no substitution; `assessCommand` splits those first.
 */
function judgeSingle(command: string, contained = false, cwd?: string, dialect: Dialect = "posix"): RiskVerdict {
	const argv = argvOf(command, dialect);
	const head = programName(argv[0]);
	if (!head) return SAFE;
	const args = argv.slice(1);

	const never = lookup(NEVER_UNATTENDED, head);
	if (never) return risky(never);

	if (WINDOWS_DELETERS.has(head.toLowerCase())) {
		const verdict = judgeWindowsDelete(args, contained);
		if (verdict.risky) return verdict;
	}

	// `iex (irm https://…)`: the download-and-run without a pipe for the pipeline rule to see.
	if (/\b(iex|invoke-expression)\b/i.test(command) && /\b(irm|iwr|invoke-(webrequest|restmethod)|downloadstring|net\.webclient)\b/i.test(command)) {
		return risky("download-and-run");
	}
	// `Start-Process … -Verb RunAs` is Windows' `sudo`.
	if (head.toLowerCase() === "start-process" && /-verb\s+['"]?runas\b/i.test(command)) return risky("run-as-admin");

	if (head === "rm") {
		const verdict = judgeRm(args, contained, cwd);
		if (verdict.risky) return verdict;
	}
	if (head === "find") {
		const verdict = judgeFind(args, contained, cwd);
		if (verdict.risky) return verdict;
	}
	if (head === "git") return judgeGit(argv);
	// What LaunchServices starts runs outside the sandbox this command is in — see `risk-open.ts`.
	if (head === "open") {
		const verdict = judgeOpen(args);
		if (verdict.risky) return verdict;
	}
	// Pruning volumes deletes the data in them; `docker volume ls` and `create` do not.
	if (head === "docker" && args[0] === "volume" && args[1] === "prune") return risky("docker-prune");

	const table = lookup(RISKY_SUBCOMMANDS, head);
	if (table) {
		// The first operand, so `pnpm -r publish` is a publish too.
		const code = lookup(table, args.find((word) => !word.startsWith("-")) ?? "");
		if (code) return risky(code);
	}

	/*
	 * A credential named anywhere in the command, read or written.
	 *
	 * Checked before the write rules rather than folded into them, because for a key the read is
	 * the loss: `cat ~/.plume/vault.key` does no damage and hands over every stored credential,
	 * and `curl -d @~/.ssh/id_ed25519` is the same sentence with somewhere to send it. Both were
	 * safe, because the only path rule in here fired on a redirect.
	 */
	if (SECRET_PATH.test(command)) return risky("secret-file");

	// A redirect into a system location, or an edit of the shell's own startup files.
	if (/>\s*[^&\s]/.test(command) && PROTECTED_PATH.test(command)) return risky("write-system-path");
	if (/>\s*~?\/?\.(zshrc|bashrc|profile|zprofile)\b/.test(command)) return risky("shell-startup");
	// And the same destination reached without one: `cp payload /usr/local/bin/git`.
	if ((PLACES_FILES.has(head) || PLACES_FILES.has(head.toLowerCase())) && PROTECTED_PATH.test(command)) return risky("write-system-path");

	/*
	 * A local file going out over the network.
	 *
	 * Uploading is not a step in writing code, and it is the one effect on this list that cannot
	 * be undone by any means at all — a file that has left the machine has left it. `@` is curl's
	 * "read this from a file" marker, which is what separates sending a file from sending a
	 * string the model composed.
	 */
	if (head === "curl" || head === "wget") {
		/*
		 * The `@` has to sit where a filename would: at the start of the value, or just after the
		 * field name in curl's `-F name=@file`. Anywhere else it is ordinary text, and
		 * `-d 'email=a@b.test'` is a string being posted, not a file being uploaded.
		 */
		const uploads = /(^|\s)(-d|--data(-binary|-raw)?|-F|--form)(\s+|=)['"]?([A-Za-z0-9_.-]+=)?@/;
		const puts = /(^|\s)(-T|--upload-file)(\s|=)/;
		if (uploads.test(command) || puts.test(command)) return risky("upload-file");
	}

	return SAFE;
}

/**
 * Judge a whole command line, including everything it chains or substitutes.
 *
 * A pipeline is risky if any stage is: `cat x | sudo tee /etc/hosts` is not made safe by
 * starting with `cat`.
 */
export function assessCommand(command: string, cwd?: string, depth = 0, dialects: readonly Dialect[] = commandDialects()): RiskVerdict {
	/*
	 * In every grammar the shell might read it in — see `commandDialects`. Where PowerShell is one of
	 * them, a line is judged by bash's reading and PowerShell's both, and either finding a risk is
	 * enough: `echo "a\"; rm -rf ~; echo"` is one quoted string to bash, whose backslash escapes the
	 * quote, and two commands to PowerShell, whose backslash is an ordinary character.
	 */
	for (const dialect of dialects) {
		const verdict = assessIn(command, cwd, depth, dialect, dialects);
		if (verdict.risky) return verdict;
	}
	return SAFE;
}

const fetches = (head: string) => FETCHERS.has(head.toLowerCase());
const interprets = (head: string) => INTERPRETERS.has(head) || INTERPRETERS.has(head.toLowerCase());
/** Builtins that run the code they are given as an argument, the way an interpreter does. */
const SOURCES = new Set(["eval", "source", "."]);

function assessIn(command: string, cwd: string | undefined, depth: number, dialect: Dialect, dialects: readonly Dialect[]): RiskVerdict {
	/*
	 * Downloading something and handing it to an interpreter.
	 *
	 * The classic way to run code nobody has read, and invisible once the line is flattened,
	 * because `curl url` and `python3` are each unremarkable on their own. The danger is in the
	 * join — so this asks the pipeline view rather than a regular expression over the whole line.
	 *
	 * That regular expression matched a shell directly after the pipe and nothing else, so it
	 * covered `curl u | sh` and missed both `curl u | python3` (any other interpreter) and
	 * `curl u | tail -n +2 | sh` (anything in between). Both are the same sentence.
	 */
	for (const stages of pipelines(command, dialect)) {
		const heads = stages.map((stage) => firstWord(stage, dialect));
		const fetched = heads.findIndex(fetches);
		if (fetched === -1) continue;
		const ran = heads.findIndex((head, index) => index > fetched && interprets(head));
		if (ran !== -1) return risky("download-and-run");
	}
	// And the same join with no pipe in it: `sh -c "$(curl u)"`, `bash <(curl u)`, `source <(curl u)`.
	for (const { host, inner } of substitutionHosts(command, dialect)) {
		const head = firstWord(host, dialect);
		if ((interprets(head) || SOURCES.has(head)) && inner.some((piece) => fetches(firstWord(piece, dialect)))) return risky("download-and-run");
	}

	/*
	 * Whether the command stays inside the project.
	 *
	 * `cd` is what makes a relative path ambiguous: `rm -f build/*` is housekeeping, and
	 * `cd /etc && rm -f *` is the same three characters somewhere it must never happen. If every
	 * `cd` in the chain lands inside the workspace, a relative path is a path within it.
	 */
	const contained = cwd ? staysInside(command, cwd) : false;

	for (const piece of splitCommands(command, dialect)) {
		const verdict = judgeSingle(piece, contained, cwd, dialect);
		if (verdict.risky) return verdict;

		/*
		 * And whatever this piece wraps.
		 *
		 * Bounded because the nesting can be: `bash -c "bash -c '…'"` is legal and a model that
		 * produced it by accident should get an answer rather than a stack overflow. Four is past
		 * anything written on purpose; the depth is what stops it, not the shape.
		 */
		if (depth >= 4) continue;
		const inner = wrappedCommand(piece, dialect);
		if (!inner) continue;
		const nested = assessCommand(inner, cwd, depth + 1, dialects);
		if (nested.risky) return nested;
	}
	return SAFE;
}


/**
 * Whether every directory the command changes into is within the workspace.
 *
 * Conservative by construction: a `cd` whose destination cannot be read literally — a variable,
 * a substitution, `-` — counts as leaving, because what it resolves to is not knowable here.
 */
function staysInside(command: string, cwd: string): boolean {
	const root = cwd.replace(/\/+$/, "");
	for (const piece of splitCommands(command)) {
		const match = /^\s*cd\s+(\S+)/.exec(piece);
		if (!match) continue;
		const target = match[1].replace(/^['"]|['"]$/g, "");
		if (target.startsWith("~") || target === "-" || /[$`]/.test(target)) return false;
		/*
		 * `isAbsolute`, so this recognises `C:\…` as well as `/…`.
		 *
		 * With `startsWith("/")` every Windows path fell straight past every one of these checks —
		 * so `rm -rf C:\Users\…\Temp` was not merely misjudged, it was never judged at all. A
		 * classifier that answers "safe" because it did not recognise the shape of the path is the
		 * worst failure mode available to it.
		 */
		if (isAbsolute(target)) {
			if (withinOrIs(root, target)) continue;
			/*
			 * A scratch directory is somewhere work legitimately happens, not somewhere it escaped
			 * to — and here the root itself counts. `cd /tmp` is working there; `rm -rf /tmp` is
			 * something else entirely, and that is judged separately.
			 */
			if (underScratchRoot(target, cwd) || scratchRoots(cwd).includes(target.replace(/\/+$/, ""))) continue;
			return false;
		}
		// A relative `cd` can still climb out with `..`.
		if (climbsOut(target)) return false;
	}
	return true;
}

export { splitCommands } from "./shell-split.ts";

export { assessWrite } from "./risk-paths.ts";
export { assessNetwork } from "./risk-network.ts";
