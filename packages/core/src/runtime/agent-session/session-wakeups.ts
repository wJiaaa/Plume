/**
 * 模型给这个对话安排的「以后再接着做」：`schedule_wakeup` 的一次性唤醒、`cron_create` 的定时触发。
 *
 * 到点后往这个对话送一条消息（`wakeup-message.ts`），闲着就开一轮，忙着排到这一轮之后。每次开一个
 * **新**会话的「定时任务」是另一件事（`config/schedule.ts`、桌面端的 `scheduler.ts`），存在设置里；
 * 这里只活在会话的内存里——应用退出、会话被处置、人按停止，就都没了。
 *
 * 和 `SessionDeliveries` 一样从 `AgentSession` 身上拆出来：它只要一个送消息的口子和一个时钟。
 *
 * 几个数和它们的理由：
 *
 * - 最短 60 秒：cron 的粒度本来就是一分钟；再短就是在一轮里轮询，那该用 `bash` 的后台任务。
 * - 一次性唤醒最长 24 小时：再远的事多半是「以后每天都跑」，该去定时任务页建，那边重启也还在。
 * - 循环任务 3 天后过期：任务只在内存里，桌面端一开就是好几天，忘了删的 `*\/5` 每五分钟开一轮、
 *   每轮重发整段前缀，一夜就是上百次请求。3 天够盯一个跨周末的发布；更久的去定时任务页。
 * - 每个会话最多 10 个：一个对话同时要盯的事很少超过两三件，十个已经是失控的信号。
 */

import { nextCronTime, parseCron, type CronSchedule } from "../../config/cron.ts";
import type { AgentEvent, SessionWakeup } from "../../agent/events.ts";
import type { Message } from "../../types.ts";
import { wakeupMessage } from "./wakeup-message.ts";

export const WAKEUP_MIN_SECONDS = 60;
export const WAKEUP_MAX_SECONDS = 24 * 60 * 60;
export const CRON_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
export const MAX_WAKEUPS = 10;

/**
 * 计时器最长隔多久醒一次，醒了按墙上时间重新看。
 *
 * 不直接睡到触发时刻：Node 的计时器走单调时钟，macOS 合盖睡眠时它不走，一个十分钟的唤醒醒来后要再
 * 等十分钟。一分钟一看，开盖之后最多晚一分钟。
 */
const TICK_MS = 60_000;

export interface WakeupClock {
	now(): number;
	setTimeout(run: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realClock: WakeupClock = {
	now: () => Date.now(),
	setTimeout: (run, ms) => {
		const handle = setTimeout(run, ms);
		// 待触发的唤醒不该把一个本来要退出的进程（命令行、测试）拖住。
		handle.unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface WakeupDeps {
	/**
	 * 送进对话：忙着排到这一轮之后，闲着开一轮。答 false 是没送进去（提交出错、会话停了），
	 * 那一次就不算「还没看完」，下一次到点照常送。
	 */
	deliver(message: Message): Promise<boolean> | void;
	/** 表变了，整张交出去。 */
	changed(wakeups: SessionWakeup[]): void;
	clock?: WakeupClock;
}

interface Entry {
	wakeup: SessionWakeup;
	schedule?: CronSchedule;
	/**
	 * 上一次触发送进去的消息走到哪了：`queued` 排着还没开始，`running` 开的那一轮在跑。
	 *
	 * 不是 null 时再到点就跳过、记一笔：模型还没看完上一次，再排一条进去只会在它后面接成一串，
	 * 每一条都重发整段前缀，说的却是同一件事。
	 */
	phase: "queued" | "running" | null;
	skipped: number;
}

export class SessionWakeups {
	private readonly entries = new Map<string, Entry>();
	/**
	 * 已经触发、消息还没在对话里开始的一次性唤醒。表里已经没有它，但那条消息还可能被插话清掉
	 * （见 `dropped`），那时要靠这里把它放回去。消息开始了、或者没送进去，就从这里拿掉。
	 */
	private readonly sent = new Map<string, Entry>();
	private readonly clock: WakeupClock;
	private timer: unknown = null;
	private counter = 0;
	private readonly deps: WakeupDeps;

	constructor(deps: WakeupDeps) {
		this.deps = deps;
		this.clock = deps.clock ?? realClock;
	}

	/** 一次性唤醒。短于下限的抬到下限（结果里会说），长于上限的拒绝：那多半是该去定时任务页的事。 */
	wakeup(delaySeconds: number, prompt: string, reason?: string): { wakeup: SessionWakeup; clamped: boolean } {
		if (!Number.isFinite(delaySeconds)) throw new Error("delay_seconds must be a number of seconds.");
		if (delaySeconds > WAKEUP_MAX_SECONDS) {
			throw new Error(`delay_seconds is at most ${WAKEUP_MAX_SECONDS} (24 hours). For something further off or on a lasting schedule, tell the person to create it on the app's Scheduled page (定时任务) instead.`);
		}
		this.roomForOneMore();
		const seconds = Math.max(WAKEUP_MIN_SECONDS, Math.round(delaySeconds));
		const now = this.clock.now();
		const wakeup: SessionWakeup = { id: this.nextId("wake"), kind: "wakeup", prompt, ...(reason ? { reason } : {}), recurring: false, createdAt: now, nextAt: now + seconds * 1000, fired: 0 };
		this.add({ wakeup, phase: null, skipped: 0 });
		return { wakeup: { ...wakeup }, clamped: seconds !== Math.round(delaySeconds) };
	}

	/** cron 任务。第一次至少在 60 秒之后，而且要落在过期之前——永远等不到的任务不收。 */
	cron(expression: string, prompt: string, recurring: boolean): SessionWakeup {
		const schedule = parseCron(expression);
		this.roomForOneMore();
		const now = this.clock.now();
		const horizon = now + CRON_MAX_AGE_MS;
		// 严格晚于 now + 59.999s 的第一个整分钟，也就是不早于 60 秒之后。
		const first = nextCronTime(schedule, now + WAKEUP_MIN_SECONDS * 1000 - 1, horizon);
		if (first === null) {
			throw new Error(
				`"${schedule.source}" does not match any time between one minute and 3 days from now. Jobs here live at most 3 days; for a lasting schedule, tell the person to create it on the app's Scheduled page (定时任务) instead.`,
			);
		}
		const wakeup: SessionWakeup = {
			id: this.nextId("cron"),
			kind: "cron",
			prompt,
			cron: schedule.source,
			recurring,
			createdAt: now,
			nextAt: first,
			...(recurring ? { expiresAt: horizon } : {}),
			fired: 0,
		};
		this.add({ wakeup, schedule, phase: null, skipped: 0 });
		return { ...wakeup };
	}

	/** 按下一次触发的先后。 */
	list(): SessionWakeup[] {
		return [...this.entries.values()].map((entry) => ({ ...entry.wakeup })).sort((a, b) => a.nextAt - b.nextAt);
	}

	cancel(id: string): boolean {
		this.sent.delete(id);
		if (!this.entries.delete(id)) return false;
		this.arm();
		this.announce();
		return true;
	}

	/** 全部取消，答取消了几个。人按停止、会话被处置时用。 */
	cancelAll(): number {
		const count = this.entries.size;
		this.entries.clear();
		this.sent.clear();
		this.arm();
		if (count > 0) this.announce();
		return count;
	}

	/**
	 * 送进去还没轮上的消息被清掉了：插话、编辑重发停下这一轮时，排在后面的一并清空（`SessionInbox.clear`）。
	 *
	 * 插话不取消唤醒，这一次也就不能算送到：否则一次性的悄悄没了，循环的停在 `queued`，之后每次到点
	 * 都当成「上一次还没看完」跳过，直到过期。所以放回表里，一分钟后补送。不立刻送：被停下的那一轮
	 * 收尾时会接着跑排着的消息，立刻送就排到了插话那句话前面；一分钟后人那一轮已经开始，补送的排在它
	 * 后面。人按停止时也会走到这里，随后的 `cancelAll` 把它们算进「取消了几个」——它们本来就是还没
	 * 被看到的唤醒。
	 */
	dropped(messages: Message[]): void {
		const at = this.clock.now() + WAKEUP_MIN_SECONDS * 1000;
		let changed = false;
		for (const message of messages) {
			if (message.role !== "user") continue;
			for (const report of message.delivery ?? []) {
				const entry = report.kind === "wakeup" ? (this.entries.get(report.id) ?? this.sent.get(report.id)) : undefined;
				if (!entry || entry.phase !== "queued") continue;
				const recurring = this.entries.has(report.id);
				this.sent.delete(report.id);
				entry.phase = null;
				entry.wakeup.fired -= 1;
				// 循环任务下一次本来就更近的，不必为补送再提前。
				entry.wakeup.nextAt = recurring ? Math.min(entry.wakeup.nextAt, at) : at;
				this.entries.set(report.id, entry);
				changed = true;
			}
		}
		if (!changed) return;
		this.arm();
		this.announce();
	}

	/** 撤回、编辑重发截掉的那一段里建的：说它们的那次工具调用已经不在对话里了。见 `session-rewind.ts`。 */
	cancelOnly(ids: ReadonlySet<string>): void {
		let changed = false;
		for (const id of ids) {
			this.sent.delete(id);
			if (this.entries.delete(id)) changed = true;
		}
		if (!changed) return;
		this.arm();
		this.announce();
	}

	/**
	 * 看会话的事件，知道上一次触发开的那一轮结束没有。
	 *
	 * 送进去的那条消息开始了（`message_start`）才算这一轮是它的；它后面的 `agent_end` 就是这一轮结束。
	 * 排着没开始的那条不受别的回合收尾影响——人那一轮结束时它还没轮上。
	 */
	observe(event: AgentEvent): void {
		if (event.type === "message_start" && event.message.role === "user") {
			for (const report of event.message.delivery ?? []) {
				if (report.kind !== "wakeup") continue;
				// 一次性的进了对话就算送到，之后再清掉什么也与它无关。
				this.sent.delete(report.id);
				const entry = this.entries.get(report.id);
				if (entry) entry.phase = "running";
			}
		} else if (event.type === "agent_end") {
			for (const entry of this.entries.values()) if (entry.phase === "running") entry.phase = null;
		}
	}

	private roomForOneMore(): void {
		if (this.entries.size >= MAX_WAKEUPS) {
			throw new Error(`This conversation already has ${MAX_WAKEUPS} pending wakeups and cron jobs. Delete one you no longer need with cron_delete first.`);
		}
	}

	private nextId(prefix: string): string {
		this.counter += 1;
		return `${prefix}-${this.counter}`;
	}

	private add(entry: Entry): void {
		this.entries.set(entry.wakeup.id, entry);
		this.arm();
		this.announce();
	}

	private announce(): void {
		this.deps.changed(this.list());
	}

	private arm(): void {
		if (this.timer !== null) this.clock.clearTimeout(this.timer);
		this.timer = null;
		let earliest = Infinity;
		for (const entry of this.entries.values()) earliest = Math.min(earliest, entry.wakeup.nextAt);
		if (earliest === Infinity) return;
		const wait = Math.min(TICK_MS, Math.max(0, earliest - this.clock.now()));
		this.timer = this.clock.setTimeout(() => {
			this.timer = null;
			this.tick();
		}, wait);
	}

	private tick(): void {
		const now = this.clock.now();
		const due = [...this.entries.values()].filter((entry) => entry.wakeup.nextAt <= now).sort((a, b) => a.wakeup.nextAt - b.wakeup.nextAt);
		for (const entry of due) this.fire(entry, now);
		this.arm();
		if (due.length > 0) this.announce();
	}

	private fire(entry: Entry, now: number): void {
		const { wakeup } = entry;
		if (!wakeup.recurring || !entry.schedule) {
			this.entries.delete(wakeup.id);
			wakeup.fired += 1;
			entry.phase = "queued";
			this.sent.set(wakeup.id, entry);
			void Promise.resolve(this.deps.deliver(wakeupMessage(wakeup, { next: null, skipped: 0 }))).then((sent) => {
				if (sent === false && this.sent.get(wakeup.id) === entry) this.sent.delete(wakeup.id);
			});
			return;
		}
		const expiresAt = wakeup.expiresAt ?? now;
		// 电脑睡过了过期时刻才醒：过期了就是过期了，不为一件早该结束的事再开一轮。
		if (now > expiresAt + TICK_MS) {
			this.entries.delete(wakeup.id);
			return;
		}
		const next = nextCronTime(entry.schedule, now, expiresAt);
		if (next === null) this.entries.delete(wakeup.id);
		else wakeup.nextAt = next;
		/*
		 * 上一次开的那一轮还没完：这次跳过。最后一次被跳过时模型听不到「这是最后一次」，但之前每一次
		 * 送达都写着过期时刻。
		 */
		if (entry.phase !== null) {
			entry.skipped += 1;
			return;
		}
		wakeup.fired += 1;
		entry.phase = "queued";
		const skipped = entry.skipped;
		entry.skipped = 0;
		/*
		 * 没送进去就不会有那条消息的 `message_start`，phase 也就永远停在 `queued`：之后每次到点都当成
		 * 「上一次还没看完」跳过，直到过期。已经开跑（`running`）的不动，它的 `agent_end` 会复位。
		 */
		void Promise.resolve(this.deps.deliver(wakeupMessage(wakeup, { next, skipped }))).then((sent) => {
			if (sent === false && entry.phase === "queued") entry.phase = null;
		});
	}
}
