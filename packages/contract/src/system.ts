/**
 * The app and the machine it runs on: opening things with other programs, updating itself, the
 * status bar menu, and the scheduler that runs tasks while nobody is looking.
 */

export interface OpenTarget {
	/** Stable across platforms and versions; this is what settings store. */
	id: string;
	label: string;
	/** A data URL of the application's own icon, where the platform can produce one. */
	icon?: string;
}

/**
 * Where an update's download is, as one value.
 *
 * `received`/`total` ride along on every phase that has them, including the ones that are not
 * moving: a paused download that could not say how far it got would force the window to remember
 * a number the main process already knows, which is the arrangement `ipc/update-download.ts`
 * exists to end.
 *
 * The downloader calls this `DownloadPhase`, its own word for its own state; from the window, the
 * thing being described is "where the update is up to". Same type, and it has to be the same type —
 * the phase crosses the wire verbatim, so two declarations would be two contracts with one of them
 * free to drift.
 */
export type UpdatePhase =
	| { at: "idle" }
	| { at: "downloading"; received: number; total: number }
	| { at: "paused"; received: number; total: number }
	/** Downloaded; unpacking or handing to the OS. Which ending it has is not known yet. */
	| { at: "preparing"; received: number; total: number }
	/** Done. `relaunch` distinguishes an update we can swap in from an installer the OS now has. */
	| { at: "ready"; relaunch: boolean }
	| { at: "failed"; error: string; received: number; total: number };

/**
 * What a menu item asks the renderer to do; see `src/tray-commands.ts`.
 *
 * Strings rather than a richer channel, because the whole contract between a menu that knows
 * nothing about views and a window that knows nothing about menus is the name. `open-session`
 * carries its subject in the name for the same reason — one channel, one shape.
 */
export type TrayCommand =
	| "new-session"
	| "pull-requests"
	| "scheduled"
	| "settings"
	| "updates"
	| `open-session:${string}`;

/**
 * What a task tells the window as it runs, and which task it is about.
 *
 * The sentence alone could only have gone into a corner of the window. With the task's id the window
 * can put it on that task's card; with the session's id it can tell when the run is over — absent
 * when there is no session, as when one could not be created. `kind` is there because the three are
 * not shown alike: a start is a state of the card, while a failure is also worth telling someone who
 * is not looking at the card.
 */
export interface SchedulerNotice {
	taskId: string;
	kind: "started" | "failed" | "cannotStart";
	level: "info" | "error";
	message: string;
	sessionId?: string;
}

export interface SystemApi {
	openPath(path: string): Promise<void>;
	openExternal(url: string): Promise<void>;
	/** The system default browser's name, or "" where the platform cannot tell. */
	defaultBrowser(): Promise<string>;
	/** `target` is an id from `openTargets`; see `electron/open-targets/open-targets.ts`. */
	openIn(target: string, path: string): Promise<void>;
	/**
	 * What 「用什么打开」 can mean on this machine: showing the file where it lives, plus the
	 * editors and terminals actually installed. Never empty — revealing always works.
	 */
	openTargets(): Promise<OpenTarget[]>;
	revealSkillsDir(scope: "workspace" | "user", cwd: string): Promise<string>;
	platform(): Promise<string>;
	/**
	 * Whether anything is at this path.
	 *
	 * Unlike `files.exists`, which resolves against the open projects and so answers `false` for
	 * every path outside them — which is where attached files mostly live. Asked before offering
	 * to open one, so that a file since moved says so instead of doing nothing.
	 */
	pathExists(path: string): Promise<boolean>;
	/**
	 * Whether this path is a folder. A link in a reply can name one (`[目录](素材原图/)`), and a
	 * folder is not something the file panel can read — `openFilePane` asks this after a read fails.
	 */
	isDirectory(path: string): Promise<boolean>;
	/**
	 * An https image as a data URL, or null.
	 *
	 * For pictures a rendered document names. Fetched in the main process because the page's
	 * `img-src` is `self data: blob:` and stays that way — see `system:remoteImage`.
	 */
	remoteImage(url: string): Promise<string | null>;
}

export interface UpdatesApi {
	/** Whether a newer release exists. Never throws: offline is a normal answer, not an error. */
	check(force?: boolean): Promise<{
		current: string;
		latest: string;
		available: boolean;
		/**
		 * Whether GitHub actually answered.
		 *
		 * False means offline, rate-limited, or no releases yet — all of which return the running
		 * version as the newest, which is the same shape as "you are up to date" and must not be
		 * shown as it. The badge is right to treat both as nothing to announce; a surface that was
		 * asked the question directly is not.
		 */
		checked: boolean;
		notes: string;
		url: string;
		publishedAt: number | null;
		asset: { name: string; url: string; size: number } | null;
	}>;
	/**
	 * Where the download is right now, whoever started it.
	 *
	 * The main process owns this, not the window: a download outlives the dialog that began it
	 * and outlives the window itself. Asked once on mount, and kept current by `onProgress`.
	 */
	state(): Promise<UpdatePhase>;
	/**
	 * Start fetching, or carry on from a pause. Resumes from the bytes already on disk.
	 *
	 * Returns the phase it reached, and every change also arrives on `onProgress` — so a caller
	 * may await this or ignore it entirely and just draw what it is told.
	 */
	download(version: string): Promise<UpdatePhase>;
	/** Stop, keeping what has come down. Resuming asks the server only for the rest. */
	pause(): Promise<UpdatePhase>;
	/** Stop and throw the partial away. What 取消 means, as opposed to 暂停. */
	cancel(): Promise<UpdatePhase>;
	/** Put the staged update in place and come back up on it. Does not return if it works. */
	relaunch(): Promise<boolean>;
	/**
	 * Put the downloaded installer back on screen — Windows and Linux, where installing is a
	 * window this app does not own and is easy to dismiss by accident. False if there is none.
	 */
	reopen(): Promise<boolean>;
	/** Opens the release page in the browser. Refuses anything that is not a github.com URL. */
	open(url: string): Promise<boolean>;
	onProgress(listener: (phase: UpdatePhase) => void): () => void;
}

export interface SchedulerApi {
	/** Run a scheduled task immediately, through the same path the timer uses. */
	runNow(taskId: string): Promise<{ ok: boolean; error?: string }>;
	/**
	 * What a task says as it runs: that it has started, that its turn failed, that it could not
	 * start at all. Sent to the main window only — see `notify` where `main.ts` builds the scheduler.
	 */
	onNotice(handler: (notice: SchedulerNotice) => void): () => void;
}
