import type { SandboxProcess } from "../sandbox/types.ts";

export interface BackgroundJob {
	id: string;
	command: string;
	/** What the model said the command is for — the words a person reads instead of the shell line. */
	description?: string;
	startedAt: number;
	exitCode: number | null;
	finishedAt?: number;
	output: string;
	outputPath?: string;
	outputComplete?: boolean;
	outputError?: string;
	pid?: number;
	status: "running" | "stopping" | "exited" | "failed";
	error?: string;
	/** Started by `monitor`, which reports its output as it comes rather than once at the end. */
	kind?: "monitor";
}
/**
 * New output from a `monitor`, ready to go to the model: one batch, already cut to size.
 *
 * Here rather than in `monitor.ts` because the session's delivery reads it, and `runtime/` takes
 * the shape from where the registry is.
 */
export interface MonitorEvents {
	id: string;
	command: string;
	description?: string;
	/** The newest lines of the batch, joined; older ones are left out when the batch is over the cap. */
	text: string;
	/** Lines in the batch, the left-out ones included. */
	lines: number;
	/** How many of the oldest lines were left out. */
	dropped: number;
	outputPath?: string;
	/** Set on the last batch of a monitor that stopped itself, and why. */
	stopped?: "max_events" | "idle";
	/** The limit that stopped it: the line count or the idle milliseconds. */
	limit?: number;
}
interface OwnedJob { info: BackgroundJob; process: SandboxProcess }
const KEY = "backgroundJobs";

/** The only handles accepted by stop come from processes this session actually started. */
export class BackgroundJobs {
	private readonly entries = new Map<string, OwnedJob>();
	/**
	 * Jobs whose end the model must not be told about: someone stopped them, the model already read
	 * how they ended, or the person pressed stop while they ran. Telling it anyway either repeats
	 * what it knows or wakes a conversation the person just stopped.
	 */
	private readonly quiet = new Set<string>();
	/**
	 * Of those, the ones someone ended with `stop`. A monitor's batches are dropped only for this:
	 * one the model has merely read the end of still has lines nobody saw, already marked read.
	 */
	private readonly stopped = new Set<string>();
	private listener: ((job: BackgroundJob) => void) | null = null;
	private monitorListener: ((events: MonitorEvents) => void) | null = null;
	private runningListener: ((monitors: number) => void) | null = null;
	add(info: BackgroundJob, process: SandboxProcess): void {
		this.entries.set(info.id, { info, process });
		if (info.kind === "monitor") this.runningListener?.(this.runningMonitors());
	}
	get(id: string): BackgroundJob | undefined { return this.entries.get(id)?.info; }
	list(): BackgroundJob[] { return [...this.entries.values()].map(({ info }) => ({ ...info })); }
	/**
	 * Who hears about a job that ended on its own. Only a top-level session listens; a sub-agent's
	 * jobs live in its own state map and stay poll-only — see `reportsExit`.
	 */
	onFinished(listener: (job: BackgroundJob) => void): void { this.listener = listener; }
	/** Whether a job started here will be reported when it ends, so the model knows not to poll. */
	get reportsExit(): boolean { return this.listener !== null; }
	/** Called by whatever follows the process once it is gone. */
	finished(job: BackgroundJob): void {
		if (!this.quiet.has(job.id)) this.listener?.(job);
		if (job.kind === "monitor") this.runningListener?.(this.runningMonitors());
	}
	/** Who hears a monitor's output while it runs. Wired beside `onFinished`, by the same session. */
	onMonitorEvents(listener: (events: MonitorEvents) => void): void { this.monitorListener = listener; }
	/** Whether a monitor started here has anyone to report to. A sub-agent's registry does not. */
	get reportsOutput(): boolean { return this.monitorListener !== null; }
	/**
	 * Who hears the number of running monitors change. A monitor wakes the session on its own, so the
	 * window marks it even with the environment card closed; a plain background job does not.
	 */
	onMonitorsChanged(listener: (monitors: number) => void): void { this.runningListener = listener; }
	runningMonitors(): number {
		let count = 0;
		for (const { info } of this.entries.values()) if (info.kind === "monitor" && info.finishedAt === undefined) count += 1;
		return count;
	}
	/** A monitor has a batch for the model. A stopped one has nothing more to say: see `stopped`. */
	monitored(events: MonitorEvents): void {
		if (!this.stopped.has(events.id)) this.monitorListener?.(events);
	}
	/** The model has read this job's final state; its end is no longer news. */
	observed(id: string): void {
		if (this.entries.get(id)?.info.finishedAt !== undefined) this.quiet.add(id);
	}
	/** Read when the report is about to go out: a stop or a read may have happened in between. */
	isQuiet(id: string): boolean { return this.quiet.has(id); }
	wasStopped(id: string): boolean { return this.stopped.has(id); }
	/**
	 * A turn was stopped — the stop button, or a message that interrupts it: nothing running now
	 * may wake the session when it ends.
	 *
	 * Monitors are left alone. Muted, a monitor can do nothing except hold a process; after an
	 * interruption the conversation goes on and the model still counts on it. The stop button ends
	 * them outright instead: see `stopMonitors`.
	 */
	mute(): void {
		for (const { info } of this.entries.values()) {
			if (info.finishedAt === undefined && info.kind !== "monitor") this.quiet.add(info.id);
		}
	}
	/**
	 * The person pressed stop. A dev server they had started is theirs to keep — the button is for
	 * the conversation — but a monitor exists only to wake the session, which is what stop takes back.
	 */
	stopMonitors(): void {
		for (const { info } of this.entries.values()) {
			if (info.finishedAt !== undefined || info.kind !== "monitor") continue;
			try { this.stop(info.id); } catch { /* a monitor that will not die is no reason to fail the stop button */ }
		}
	}
	stop(id: string, force = false): boolean {
		const job = this.entries.get(id);
		if (!job || job.info.finishedAt !== undefined || job.info.status === "exited") return false;
		this.quiet.add(id);
		this.stopped.add(id);
		job.info.status = "stopping";
		try { job.process.kill(force ? "SIGKILL" : "SIGTERM"); }
		catch (error) { job.info.status = "failed"; job.info.error = String(error); throw error; }
		return true;
	}
	dispose(): void {
		const errors: unknown[] = [];
		for (const id of this.entries.keys()) {
			try { this.stop(id, true); } catch (error) { errors.push(error); }
		}
		if (errors.length) throw new AggregateError(errors, "Failed to stop background jobs");
	}
}

export function backgroundJobs(state: Map<string, unknown>): BackgroundJobs {
	const current = state.get(KEY);
	if (current instanceof BackgroundJobs) return current;
	const registry = new BackgroundJobs();
	state.set(KEY, registry);
	return registry;
}
