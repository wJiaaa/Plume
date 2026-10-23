/**
 * Scheduled tasks.
 *
 * Each due task starts a *fresh* session and sends its prompt. A fresh session is deliberate:
 * a recurring task that accumulated history would drift as the transcript grew, and would
 * eventually blow past the context window.
 *
 * The tick is one minute, which is the finest granularity the schedule kinds express.
 */

import { isDue } from "@plume/core";
import type { AgentSession, ScheduledTask, Settings, TurnEnd } from "@plume/core";
import { nativeText } from "../i18n.ts";
import type { SchedulerNotice } from "@plume/contract";

const TICK_MS = 60_000;

type NoticeSubject = Pick<SchedulerNotice, "taskId" | "kind" | "sessionId">;

export interface SchedulerDeps {
	getSettings(): Settings;
	saveSettings(settings: Settings): Promise<void>;
	/** `project` is the task's (`ScheduledTask.project`): its runs are filed there, not under whatever lists the folder. */
	createSession(cwd: string, modelId: string, project?: string): Promise<AgentSession>;
	/** A notice for the window, already in the interface language, and the task it is about. */
	notify(message: string, level: SchedulerNotice["level"], about: NoticeSubject): void;
}

export class Scheduler {
	private deps: SchedulerDeps;
	private timer: ReturnType<typeof setInterval> | null = null;
	/**
	 * 这一次运行还没收尾的任务：tick 跳过它们，不在同一个目录上再开一个会话。
	 *
	 * 收尾 = 这一轮跑完、后台子代理送回来的那几轮也做完（`whenIdle`）。从前会话一建好就放开，而
	 * 这一轮不被等待，间隔比一轮短的任务就一次叠一次。`lastRunAt` 记的是开跑的时间，所以忙着期间
	 * 到期几次，收尾之后的下一个 tick 都只补跑一次。
	 */
	private running = new Set<string>();

	constructor(deps: SchedulerDeps) {
		this.deps = deps;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		// Run one tick shortly after launch so a task overdue from last session fires.
		setTimeout(() => void this.tick(), 5_000);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async tick(now = Date.now()): Promise<void> {
		const settings = this.deps.getSettings();
		for (const task of settings.scheduledTasks) {
			if (!task.enabled || this.running.has(task.id)) continue;
			if (!isDue(task, now)) continue;
			await this.run(task, now);
		}
	}

	private async run(task: ScheduledTask, now: number): Promise<void> {
		this.running.add(task.id);
		let sessionId: string | undefined;
		let error: string | undefined;
		/** This attempt on its way to disk. A failure later in the turn is written after it, not under it. */
		let recorded: Promise<void> = Promise.resolve();
		/** 这一次运行收尾；见 `running`。没建成会话就没有。 */
		let settled: Promise<void> | null = null;

		try {
			const settings = this.deps.getSettings();
			const session = await this.deps.createSession(task.cwd, settings.defaultModelId ?? "", task.project);
			sessionId = session.meta.id;
			this.deps.notify(nativeText("scheduled.started", { name: task.name }), "info", { taskId: task.id, kind: "started", sessionId });
			const failed = async (reason: string) => {
				this.deps.notify(nativeText("scheduled.failed", { name: task.name, reason }), "error", {
					taskId: task.id,
					kind: "failed",
					sessionId: session.meta.id,
				});
				// A save that failed has already been reported by the run it belongs to.
				await recorded.catch(() => {});
				await this.recordFailure(task.id, session.meta.id, reason);
			};
			// Not awaited: the turn can run for minutes and must not block the tick.
			settled = session
				.prompt([{ type: "text", text: task.prompt }])
				.then(
					async (ended) => {
						const reason = unfinished(ended);
						if (reason) await failed(reason);
					},
					(cause: unknown) => failed(cause instanceof Error ? cause.message : String(cause)),
				)
				.then(() => session.whenIdle());
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
			this.deps.notify(nativeText("scheduled.couldNotStart", { name: task.name, reason: error }), "error", {
				taskId: task.id,
				kind: "cannotStart",
			});
		} finally {
			if (settled) void settled.catch(() => {}).finally(() => this.running.delete(task.id));
			else this.running.delete(task.id);
			// Record the attempt either way, so a failing task does not retry every minute.
			const settings = this.deps.getSettings();
			recorded = this.deps.saveSettings({
				...settings,
				scheduledTasks: settings.scheduledTasks.map((t) =>
					t.id === task.id ? { ...t, lastRunAt: now, lastSessionId: sessionId, lastError: error } : t,
				),
			});
			await recorded;
		}
	}

	/**
	 * Puts a failure from later in the turn on the task, where its card shows it.
	 *
	 * The attempt was recorded when the run started, without an error, so a turn that failed minutes
	 * afterwards left the card saying nothing was wrong. Only while that run is still the task's
	 * latest — a run started since has an outcome of its own.
	 */
	private async recordFailure(taskId: string, sessionId: string, reason: string): Promise<void> {
		const settings = this.deps.getSettings();
		if (settings.scheduledTasks.find((t) => t.id === taskId)?.lastSessionId !== sessionId) return;
		await this.deps.saveSettings({
			...settings,
			scheduledTasks: settings.scheduledTasks.map((t) => (t.id === taskId ? { ...t, lastError: reason } : t)),
		});
	}
}

/**
 * 一轮正常返回、却没做完时该说的原因；做完了、被人停下的没有。
 *
 * `prompt()` 正常返回不等于做完：服务商出错、原地打转、跑满轮数都是正常返回的，从前卡片上于是什么
 * 问题都没有。被停下的不算失败——那是人按的按钮。
 */
function unfinished(ended: TurnEnd | undefined): string | null {
	if (!ended) return null;
	if (ended.reason === "error") return ended.error || nativeText("scheduled.modelError");
	if (ended.reason === "stalled") return nativeText("scheduled.stalled");
	if (ended.reason === "max_turns") return nativeText("scheduled.maxTurns");
	return null;
}
