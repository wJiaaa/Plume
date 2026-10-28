/**
 * Results that finish in the background, carried back into the conversation.
 *
 * Four sources: sub-agents dispatched in the background (`detached-dispatches.ts`), background
 * commands that ended (`tools/background-jobs.ts`), new output from a `monitor` (`tools/monitor.ts`),
 * and conversations started from this one's suggestion that were asked to report back (`FinishedSession`). All are gathered for a moment and
 * handed to the session as one message — mid-turn it is spliced in, idle it starts a turn. Requests
 * and notices from other sessions travel the same way but never in that message: see `flush`. Only
 * notices that arrive while the session is idle or compacting come here; mid-turn ones go into the turn,
 * see `AgentSession.receive`.
 *
 * Kept out of `AgentSession` because it needs four things from it and nothing else: a way to submit,
 * the roster to check a report against, the background-job registry, and the session's activity to
 * know whether a stop happened meanwhile.
 */

import type { SettledDispatch } from "../sub-agent/detached-dispatches.ts";
import { deliveryMessage, type FinishedJob, type FinishedSession } from "./delivery-message.ts";
import type { SessionActivity } from "./session-activity.ts";
import type { SubAgentSummary } from "../../types/sub-agent.ts";
import type { BackgroundJob, BackgroundJobs, MonitorEvents } from "../../tools/background-jobs.ts";
import { readJob } from "../../tools/bash.ts";
import type { Message, PeerLetter } from "../../types.ts";
import { bySender, peerMessage } from "./peer-letters.ts";

/**
 * How long background results are gathered before they are delivered.
 *
 * Several dispatched in parallel often finish one right after another — same model, similar work,
 * end times a few hundred milliseconds apart are common. Gathered for this short while, they are
 * one message and one turn; not gathered, they are several turns, each resending the whole prefix.
 * Any longer and the one that finished first waits for nothing: the person can see it is done,
 * yet the main session has not moved.
 */
const DELIVERY_GATHER_MS = 400;

export interface DeliveryDeps {
	activity: SessionActivity;
	jobs: () => BackgroundJobs;
	detail: (id: string) => SubAgentSummary | null;
	/** 还在后台跑、没回来的子代理：送达消息里点名，模型才知道还在等谁。 */
	outstanding: () => SubAgentSummary[];
	/** `followUp` 排到这一轮之后；`notice` 忙时回到专用通知流，打断等待且停止时不丢。 */
	submit: (message: Message, deliver?: "followUp" | "notice") => Promise<void>;
	/** 人按了停，攒着的通知没送出去：交还会话，下一轮开头读到。通知没人等回答，丢了谁也不知道。 */
	unsent: (letters: PeerLetter[]) => void;
	/** 一次送达收了尾（送了或丢了）；会话据此重新看一眼自己是不是空闲了。 */
	settled: () => void;
}

export class SessionDeliveries {
	private reports: SettledDispatch[] = [];
	private finishedJobs: BackgroundJob[] = [];
	private monitorEvents: MonitorEvents[] = [];
	private finishedSessions: FinishedSession[] = [];
	/** 其他会话的请求：排到收件方这一轮之后，每个发件会话单独一轮。 */
	private requests: PeerLetter[] = [];
	/** 闲着或压缩时到的通知：几家的并成一条，等能开轮时读。 */
	private notices: PeerLetter[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** 已经取出、还没交到会话手里的那一次送达；这期间也不算空闲。 */
	private flushing = false;
	private readonly deps: DeliveryDeps;

	constructor(deps: DeliveryDeps) {
		this.deps = deps;
	}

	/**
	 * A sub-agent that was let go has finished: hold it, and shortly deliver it together with any
	 * that finished around the same time.
	 */
	report(report: SettledDispatch): void {
		this.reports.push(report);
		this.schedule();
	}

	jobFinished(job: BackgroundJob): void {
		this.finishedJobs.push(job);
		this.schedule();
	}

	/** A monitor has new lines. It already spaced and capped them; this only gathers them with the rest. */
	monitored(events: MonitorEvents): void {
		this.monitorEvents.push(events);
		this.schedule();
	}

	/** 从这里的建议开出来的会话跑完了第一轮，要交回来。 */
	sessionFinished(session: FinishedSession): void {
		this.finishedSessions.push(session);
		this.schedule();
	}

	/** 另一个会话的请求到了；和同一时刻到的一起送，但不和后台结果、别的会话的请求并成一条。 */
	letter(letter: PeerLetter): void {
		this.requests.push(letter);
		this.schedule();
	}

	/** 闲着或压缩时另一个会话的通知到了；和同一时刻到的一起送。 */
	notice(letter: PeerLetter): void {
		this.notices.push(letter);
		this.schedule();
	}

	/** 没有攒着待送的东西。会话判断空闲时要看它：攒着的那一条四百毫秒后就会开一轮。 */
	get empty(): boolean {
		return this.timer === null && !this.flushing && this.reports.length === 0 && this.finishedJobs.length === 0 && this.monitorEvents.length === 0 && this.finishedSessions.length === 0 && this.requests.length === 0 && this.notices.length === 0;
	}

	/**
	 * After a stop, nothing still being held is delivered.
	 *
	 * A sub-agent that was stopped still "finishes" afterwards, and if something is waiting to
	 * deliver it at that moment, a result cut off halfway wakes the main session that was just
	 * stopped — the screen has only just said "stopped", and it starts moving again. Background
	 * commands are not stopped (the stop button is for this conversation, not for the dev server
	 * the person had it start), but they no longer wake the session when they end either: if the
	 * model needs the result next turn, it reads it itself with `bash_output`.
	 *
	 * Monitors are the exception either way. The stop button ends them (`BackgroundJobs.stopMonitors`)
	 * and passes `monitors: true`, so what they had gathered goes with them. A message that interrupts
	 * the turn leaves them running, and their gathered lines — already marked read — still go out. So
	 * does the end of one that exited on its own just before: `mute` leaves monitors alone, and that
	 * report carries its exit status and the lines after its last batch, which nothing else will show.
	 * Other background commands that ended meanwhile are still dropped, the same as the running ones
	 * `mute` just silenced.
	 *
	 * Notices from other sessions are not dropped but handed back (`unsent`): nobody waits for an
	 * answer to one, so a dropped notice is lost without anyone knowing. The next turn reads them.
	 */
	clear({ monitors }: { monitors: boolean }): void {
		this.reports.length = 0;
		this.finishedJobs = monitors ? [] : this.finishedJobs.filter((job) => job.kind === "monitor");
		if (monitors) this.monitorEvents.length = 0;
		this.finishedSessions.length = 0;
		this.requests.length = 0;
		if (this.notices.length > 0) this.deps.unsent(this.notices.splice(0, this.notices.length));
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (this.monitorEvents.length > 0 || this.finishedJobs.length > 0) this.schedule();
	}

	/**
	 * Of the finished reports held for delivery, keep only those whose dispatch is still in the
	 * history. See `stopCutDelegations` in `session-rewind.ts`.
	 */
	keepOnly(dispatched: ReadonlySet<string>): void {
		this.reports = this.reports.filter((report) => dispatched.has(report.id));
	}

	/** Drop what is held for these background jobs; see `stopCutWatches` in `session-rewind.ts`. */
	forgetJobs(ids: ReadonlySet<string>): void {
		this.finishedJobs = this.finishedJobs.filter((job) => !ids.has(job.id));
		this.monitorEvents = this.monitorEvents.filter((events) => !ids.has(events.id));
	}

	private schedule(): void {
		this.timer ??= setTimeout(() => {
			this.timer = null;
			this.flushing = true;
			void this.flush().finally(() => {
				this.flushing = false;
				this.deps.settled();
			});
		}, DELIVERY_GATHER_MS);
	}

	/**
	 * Deliver the gathered background results to the main session as one message.
	 *
	 * If the main session is running it is spliced in — read at the start of the next turn; if it
	 * is idle a turn is started so it can go on with these conclusions. Ones a person stopped are
	 * not delivered: stopping it was the person's decision, and waking the main session with a
	 * half-finished result is arguing with that decision.
	 */
	private async flush(): Promise<void> {
		const settled = this.reports.splice(0, this.reports.length);
		const reports = settled
			.map((report) => ({ report, summary: this.deps.detail(report.id) }))
			.filter(({ report, summary }) => summary?.status !== "aborted" && !report.answer?.stoppedByUser);
		const monitors = this.takeMonitorEvents();
		const jobs = this.takeFinishedJobs();
		const sessions = this.finishedSessions.splice(0, this.finishedSessions.length);
		const requests = this.requests.splice(0, this.requests.length);
		const notices = this.notices.splice(0, this.notices.length);
		if (reports.length === 0 && jobs.length === 0 && monitors.length === 0 && sessions.length === 0 && requests.length === 0 && notices.length === 0) return;
		const { activity } = this.deps;
		// A manual compaction is rewriting the history: wait until it has written the boundary
		// before coming in, the same as a message from the person.
		const mark = activity.mark();
		if (activity.compaction) await activity.compaction;
		/*
		 * The person pressed stop while this was waiting: these reports were already taken out, so
		 * `clear` cannot reach them. Drop them for the same reason, rather than putting them back —
		 * except notices, handed back for the reason given at `clear`.
		 */
		if (activity.stoppedSince(mark)) {
			if (notices.length > 0) this.deps.unsent(notices);
			return;
		}
		/*
		 * 一组一条，同步交进去：闲着时第一条开一轮，其余的这时已经算忙，排在后面，顺序就是这里的顺序。
		 *
		 * 请求不并进后台结果，不同会话的请求也不并在一起：发件方等回来的是处理它那封信的那一轮最后
		 * 说的话，几家并成一轮，每一家拿到的都是同一段回答。通知没人等回答，几家并成一条；不排到
		 * 这一轮之后（没有 `followUp`）：这四百毫秒里会话若开始跑了，它插进去，和在跑时到的通知一样。
		 */
		const background = reports.length + jobs.length + monitors.length + sessions.length;
		const parts: { message: Message; deliver?: "followUp" | "notice" }[] = [
			...(background > 0 ? [{ message: deliveryMessage(reports, jobs, reports.length > 0 ? this.deps.outstanding() : [], sessions, monitors) }] : []),
			...(notices.length > 0 ? [{ message: peerMessage(notices, "notice"), deliver: "notice" as const }] : []),
			...bySender(requests).map((group) => ({ message: peerMessage(group), deliver: "followUp" as const })),
		];
		await Promise.all(parts.map(({ message, deliver }) => this.deps.submit(message, deliver)));
	}

	/**
	 * The gathered monitor batches, less those of a monitor stopped meanwhile from the services panel
	 * or with `bash_output`. Stopped, not quiet: a monitor whose end the model has already read with
	 * `bash_output` is quiet, yet its last batch is lines that read did not show.
	 *
	 * A monitor that stopped itself is quiet too, but all of its batches stay: its own stop came right
	 * after its last batch, which is what tells the model it ended, and a batch sent just before that
	 * one is still waiting here when a burst of output fills `max_events` within the gathering window.
	 * Those lines were marked read when they were sent, so dropping them here loses them for good.
	 */
	private takeMonitorEvents(): MonitorEvents[] {
		const registry = this.deps.jobs();
		const taken = this.monitorEvents.splice(0, this.monitorEvents.length);
		const ended = new Set(taken.filter((events) => events.stopped !== undefined).map((events) => events.id));
		return taken.filter((events) => ended.has(events.id) || !registry.wasStopped(events.id));
	}

	/**
	 * The gathered background commands, read into the shape used for delivery.
	 *
	 * Whether each is quiet is asked again at this moment: during those 400ms of gathering, the
	 * model may have already read the outcome itself with `bash_output`, or someone may have pressed
	 * stop in the services panel — delivering the former again is a repeat, and the latter would be
	 * arguing with that decision.
	 */
	private takeFinishedJobs(): FinishedJob[] {
		const registry = this.deps.jobs();
		return this.finishedJobs
			.splice(0, this.finishedJobs.length)
			.filter((job) => !registry.isQuiet(job.id))
			.map((job) => {
				registry.observed(job.id);
				const { status, text } = readJob(job);
				return { id: job.id, command: job.command, description: job.description, exitCode: job.exitCode, status, failed: job.status === "failed", output: text };
			});
	}
}
