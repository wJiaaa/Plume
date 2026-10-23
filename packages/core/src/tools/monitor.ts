/**
 * `monitor`: run a long-lived command and hand its new output lines to the model while it runs.
 *
 * `bash` with `run_in_background` reports once, when the command ends — right for a build, useless
 * for `tail -f` or a watch-mode compiler, which never end and whose every line may be the one that
 * matters. Everything about running the command is `bash`'s: the approval and risk judgement
 * (`authorizeCommand`), the sandbox, the log and the job registry (`launchJob`). What is here is
 * only what to do with the output.
 *
 * And what to do with it is decided by cost. Each delivery that reaches an idle session starts a
 * turn, and a turn resends the whole prefix — a line a turn would make a chatty log the most
 * expensive thing in the session. So lines are gathered into batches, batches are spaced out, each
 * is capped, and the description tells the model to filter in the command. The numbers below are
 * that budget; each says what it is paying for.
 */

import { authorizeCommand, launchJob, markJobRead } from "./bash.ts";
import { backgroundJobs, type BackgroundJob, type BackgroundJobs, type MonitorEvents } from "./background-jobs.ts";
import { errorResult } from "./result.ts";
import { commandShell } from "../platform.ts";
import type { SandboxProcess } from "../sandbox/types.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * After the first new line, how long to wait for the rest of it.
 *
 * Output comes in bursts — a stack trace, the summary a rebuild prints — whose lines are
 * milliseconds apart. Sent on the first line, the burst is two deliveries and two turns; a second
 * of waiting makes it one, and nobody acting on a log line notices a second.
 */
const GATHER_MS = 1_000;
/**
 * The least time between two deliveries of one monitor; lines arriving meanwhile wait for the next.
 *
 * This is what bounds the turns a talkative command can cost: at most six a minute, however fast
 * it prints. Ten seconds is still soon enough to react to a rebuild that failed, which is the
 * slowest thing anyone watches for; much longer and "tell me when it compiles" stops being worth it.
 */
const MIN_INTERVAL_MS = 10_000;
/**
 * The most text one delivery carries; over it the newest lines are kept and the rest counted.
 *
 * A delivery stays in the history and is resent with every turn after it. 4000 characters, about
 * a thousand tokens, is room for a full error with its stack, and small enough that a monitor that
 * hits its line limit has not doubled the context. The newest lines, because a watcher's latest
 * state is the one that is true now; the whole log is on disk for anything older.
 */
const DELIVERY_MAX_CHARS = 4_000;
/** One line is cut here, so that a minified bundle printed on one line cannot fill a delivery alone. */
const LINE_MAX_CHARS = 1_000;
/** Text with no newline yet is taken as a line once it is this long: a progress bar never ends one. */
const PARTIAL_MAX_CHARS = 4_096;
/**
 * Lines after which a monitor stops itself.
 *
 * In the worst case every line is its own delivery — a filtered log printing one match a minute —
 * and so its own turn. A hundred turns is already more than any watch is worth; a monitor that
 * needs more should filter harder, or ask for up to a thousand.
 */
const DEFAULT_MAX_EVENTS = 100;
const MAX_MAX_EVENTS = 1_000;
/**
 * Silence after which a monitor stops itself.
 *
 * Silence costs no tokens, only a process, so this is about forgetting rather than spending — and a
 * well-filtered monitor is meant to be silent most of the time. Ten minutes outlasts a slow build
 * between two edits; an hour is the most a forgotten one may hold on.
 */
const DEFAULT_IDLE_MS = 600_000;
const MAX_IDLE_MS = 3_600_000;
const MIN_IDLE_MS = 1_000;

interface MonitorArgs {
	command: string;
	description?: string;
	max_events?: number;
	idle_timeout?: number;
}

export const monitorTool: Tool<MonitorArgs> = {
	name: "monitor",
	approvalKind: "bash",
	/*
	 * Sent with every request, so only what decides whether and how to call it. The batching numbers,
	 * the limits and how to stop it come in the result, once it has been called.
	 */
	description:
		"Run a long-lived command — `tail -f` on a log, a build or test runner in watch mode, a polling loop — and get its new output lines delivered to you as messages while it runs. " +
		"Not for a command you are only waiting to finish: `bash` with `run_in_background` already reports when it ends. " +
		"Each delivery may cost a turn, so filter in the command to the lines you would act on, line-buffered (`grep --line-buffered`, `sed -u`) or the pipe holds them back: " +
		"`npm run dev 2>&1 | grep --line-buffered -E 'error|compiled'`.",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "The command to run. stdout and stderr both count; every non-empty line is an event." },
			description: {
				type: "string",
				description:
					"What this watches, in 5-10 words and the user's language — it is the line the user reads instead of the command " +
					"(\"Watch the dev server for errors\"), not the command or its flags.",
			},
			max_events: {
				type: "integer",
				description: `Stop after this many lines. Default ${DEFAULT_MAX_EVENTS}, max ${MAX_MAX_EVENTS}.`,
			},
			idle_timeout: {
				type: "integer",
				description: `Stop after this many milliseconds without output. Default ${DEFAULT_IDLE_MS}, max ${MAX_IDLE_MS}.`,
			},
		},
		required: ["command"],
		additionalProperties: false,
	},
	mutating: true,
	// The call returns as soon as the command has started, so running it alone costs nothing.
	executionMode: "sequential",
	/*
	 * Sub-agents do not get it: a sub-agent's background jobs are registered in its own state map,
	 * where nobody listens (`jobs.reportsOutput` is false), and output that cannot be delivered makes
	 * this tool pointless. Left out of the tool table rather than failing when called, for the same
	 * reason as `task`: the model does not want a tool it has never seen, and an error costs a turn to
	 * find out the way is closed. The check in `execute` is the fallback for other hosts.
	 */
	sessionOnly: true,
	summarize: (args) => args.description ?? args.command.split("\n")[0].slice(0, 80),

	async execute(args, ctx): Promise<ToolResult> {
		if (typeof args.command !== "string" || !args.command.trim()) return errorResult("`command` is required.");
		const jobs = backgroundJobs(ctx.state);
		// Before the approval: asking the person about a command that could not do its job is a wasted question.
		if (!jobs.reportsOutput) {
			return errorResult("monitor is not available here: nothing would receive its output. Use bash with run_in_background and read it with bash_output.");
		}
		const refused = await authorizeCommand(args.command, args.description, ctx);
		if (refused) return refused;

		const started = await launchJob(args, ctx, commandShell(ctx.sandboxMode), "monitor");
		if ("error" in started) return errorResult(started.error);
		const maxEvents = clamp(args.max_events, DEFAULT_MAX_EVENTS, 1, MAX_MAX_EVENTS);
		const idleMs = clamp(args.idle_timeout, DEFAULT_IDLE_MS, MIN_IDLE_MS, MAX_IDLE_MS);
		follow(started.job, started.process, jobs, maxEvents, idleMs);
		const { id, outputPath } = started.job;
		return {
			content: [{
				type: "text",
				text:
					`Started monitor ${id}. Keep working: its new output lines will be delivered to you as messages, so do not poll it. ` +
					`They come in batches, at most one every ${MIN_INTERVAL_MS / 1000}s, each keeping the newest ${DELIVERY_MAX_CHARS} characters. ` +
					`It stops after ${maxEvents} lines or ${Math.round(idleMs / 1000)}s without output, or when the person presses Stop; ` +
					`stop it with bash_output({ id: "${id}", kill: true }) as soon as you no longer need it.`,
			}],
			details: { kind: "monitor", id, command: args.command, outputPath },
		};
	},
};

function clamp(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * Turn a running job's output into batches for the model, and stop it at its limits.
 *
 * Its own end is not reported from here. A command that exits on its own is reported by the
 * registry like any background job (`jobFinished`), and that report reads what was printed since
 * the last batch — which is exactly what this had not sent yet, because each batch marks the job
 * read. Reporting it here as well would say the same lines twice.
 */
function follow(job: BackgroundJob, process: SandboxProcess, jobs: BackgroundJobs, maxEvents: number, idleMs: number): void {
	let partial = "";
	let pending: string[] = [];
	let events = 0;
	let lastSent = -Infinity;
	let done = false;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const deliver = (stopped?: { reason: NonNullable<MonitorEvents["stopped"]>; limit: number }) => {
		clearTimeout(flushTimer);
		flushTimer = undefined;
		if (pending.length === 0 && !stopped) return;
		const batch = pending;
		pending = [];
		lastSent = Date.now();
		markJobRead(job, partial);
		jobs.monitored({
			id: job.id,
			command: job.command,
			...(job.description ? { description: job.description } : {}),
			...newest(batch),
			...(job.outputPath ? { outputPath: job.outputPath } : {}),
			...(stopped ? { stopped: stopped.reason, limit: stopped.limit } : {}),
		});
	};
	const schedule = () => {
		if (flushTimer !== undefined) return;
		const now = Date.now();
		flushTimer = setTimeout(() => deliver(), Math.max(now + GATHER_MS, lastSent + MIN_INTERVAL_MS) - now);
		flushTimer.unref?.();
	};
	const end = () => {
		done = true;
		pending = [];
		clearTimeout(flushTimer);
		clearTimeout(idleTimer);
	};
	/*
	 * Stopped by its own limit: the last batch says why, then the process goes.
	 *
	 * Through `stop`, which marks the job quiet, so the exit that follows is not reported a second
	 * time as a background command that ended — this batch already is that report.
	 */
	const finish = (reason: NonNullable<MonitorEvents["stopped"]>, limit: number) => {
		if (done) return;
		deliver({ reason, limit });
		end();
		try { jobs.stop(job.id); } catch { /* the registry recorded the failure on the job; the panel shows it */ }
	};
	const armIdle = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => finish("idle", idleMs), idleMs);
		idleTimer.unref?.();
	};

	/*
	 * `partial` is everything not yet taken as a line, and it is what `deliver` leaves unread: on a
	 * normal batch, the line still being printed; when `max_events` is reached, the rest of the chunk
	 * as well. Either way it starts where a line starts or holds no line break — see `markJobRead`.
	 */
	process.onOutput((chunk) => {
		if (done) return;
		armIdle();
		const text = partial + chunk;
		let from = 0;
		for (;;) {
			const at = text.indexOf("\n", from);
			if (at === -1 && text.length - from <= PARTIAL_MAX_CHARS) break;
			const raw = text.slice(from, at === -1 ? text.length : at);
			from = at === -1 ? text.length : at + 1;
			const line = clean(raw);
			if (!line) continue;
			pending.push(line);
			if (++events >= maxEvents) {
				partial = text.slice(from);
				return finish("max_events", maxEvents);
			}
		}
		partial = text.slice(from);
		if (pending.length > 0) schedule();
	});
	process.onExit(end);
	process.onError(end);
	armIdle();
}

/** The newest lines of a batch that fit in one delivery, and how many older ones did not. */
function newest(lines: string[]): Pick<MonitorEvents, "text" | "lines" | "dropped"> {
	let size = 0;
	let from = lines.length;
	while (from > 0 && size + lines[from - 1].length + 1 <= DELIVERY_MAX_CHARS) size += lines[--from].length + 1;
	return { text: lines.slice(from).join("\n"), lines: lines.length, dropped: from };
}

// oxlint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// oxlint-disable-next-line no-control-regex -- the control characters left once the escapes are gone
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * A line as a terminal would have left it: colours gone, and of a line redrawn with `\r` (a
 * progress bar, a spinner) only the last drawing — otherwise each redraw is an event.
 */
function clean(raw: string): string {
	const line = raw.slice(raw.lastIndexOf("\r", raw.length - 2) + 1).replace(ESCAPES, "").replace(CONTROLS, "").trimEnd();
	return line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)}…` : line;
}
