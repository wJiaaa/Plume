/**
 * What a sandbox is, apart from any one of them.
 *
 * Its own file because the implementations (`local.ts`) and the tools that start commands
 * (`tools/bash.ts`, `tools/background-jobs.ts`) all need the shape, and `index.ts` imports the
 * implementation — putting the shape there would make every implementation import its own front door.
 */

import type { CommandShell } from "../platform.ts";
import type { SandboxMode } from "./policy.ts";

/**
 * A started command.
 *
 * Modelled on what a caller needs rather than on `ChildProcess`, so an implementation that is not
 * a local process — a container, another machine — can satisfy it without pretending to be one.
 */
export interface SandboxProcess {
	/** Available for locally owned processes; remote sandboxes may omit it. */
	readonly pid?: number;
	/** stdout and stderr interleaved, in arrival order, as the shell would have shown them. */
	onOutput(listener: (chunk: string) => void): void;
	/**
	 * The command finished. `signal` names what killed it when `code` is null.
	 *
	 * `lingering` is set when the command exited but left processes of its own running that still
	 * hold its output — `server &` without a redirect. They are handed over rather than waited for:
	 * the command is done, and they can be read or stopped through this handle.
	 */
	onExit(listener: (code: number | null, signal?: NodeJS.Signals | null, lingering?: SandboxProcess) => void): void;
	/** The command could not be started at all. Exit is not reported after this. */
	onError(listener: (error: Error) => void): void;
	kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

export interface Sandbox {
	/**
	 * Start one command.
	 *
	 * `mode` is what the caller wants enforced, not a hint: an implementation that cannot enforce
	 * it must throw rather than run the command anyway. Omitting it means the caller is not asking
	 * for confinement — the CLI and the tests, which have no permission mode to map from.
	 *
	 * `shell` is the shell the command was written for, when the caller knows it — the bash tool
	 * does, because it told the model which one (`commandShell`). Absent, an implementation runs its
	 * own default for `mode`.
	 */
	run(
		command: string,
		options: { cwd: string; env?: Record<string, string>; mode?: SandboxMode; shell?: CommandShell },
	): SandboxProcess;
}
