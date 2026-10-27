/**
 * Everything the renderer may ask the main process to do.
 *
 * One interface, grouped by subject, and the only description of the boundary there is — the
 * preload builds `window.plume` against it and the handlers are registered against the same
 * channel names (`methods.ts`), so a call that is not written here does not exist.
 *
 * Each group's calls, and the values they pass, are in the file for its subject; this file only
 * puts them together, in the order `window.plume` has always had them.
 */

import type { AgentApi, DeliveryApi, ServicesApi, SideChatApi, SubAgentsApi, TasksApi, WakeupsApi } from "./agent.ts";
import type { AgentDefinitionsApi, CapabilitiesApi, CommandsApi, HooksApi, PluginsApi, SkillsApi } from "./extensions.ts";
import type { ClipboardApi, FilesApi, WorkspaceApi } from "./files.ts";
import type { ForgeApi } from "./forge.ts";
import type { DiffApi, GitApi } from "./git.ts";
import type { PinnedShotApi, ScreenshotApi } from "./screenshot.ts";
import type { SessionsApi } from "./sessions.ts";
import type { ChatBackgroundApi, IndexApi, MemoryApi, ProjectMemoryApi, ProvidersApi, SettingsApi } from "./settings.ts";
import type { SchedulerApi, SystemApi, TrayCommand, UpdatesApi } from "./system.ts";
import type { GalleryApi, UsageApi } from "./usage.ts";
import type { BootWindow, BrowserApi, PreviewTheme, TerminalApi, WindowsApi } from "./windows.ts";
import type { WorktreeApi } from "./worktree.ts";

/**
 * Node's `process.platform`, spelled out.
 *
 * The preload hands over `process.platform` as it is; written here rather than borrowed from
 * `NodeJS.Platform` so that the contract does not need Node's types to be read.
 */
export type Platform = "aix" | "android" | "cygwin" | "darwin" | "freebsd" | "haiku" | "linux" | "netbsd" | "openbsd" | "sunos" | "win32";

export interface PlumeApi {
	agentDefinitions: AgentDefinitionsApi;
	services: ServicesApi;
	delivery: DeliveryApi;
	browser: BrowserApi;
	/**
	 * Which operating system this is, available before the first paint.
	 *
	 * `system.platform()` answers the same question over IPC, which is a round trip later — and the
	 * window's top row is drawn from this: macOS keeps its traffic lights at the top left, Windows
	 * and Linux paint their own controls at the top right, and a layout that starts out wrong and
	 * corrects itself is a visible jump on every launch.
	 */
	platform: Platform;
	/**
	 * The operating system's own version, `process.getSystemVersion()` — "10.0.22631" on Windows 11.
	 *
	 * Read by the terminal, which has to tell xterm which build of ConPTY it is drawing for (see
	 * `windowsPtyFor`).
	 */
	systemVersion?: string;
	bootWindow: BootWindow;
	windows: WindowsApi;
	settings: SettingsApi;
	chatBackground: ChatBackgroundApi;
	hooks: HooksApi;
	usage: UsageApi;
	gallery: GalleryApi;
	worktree: WorktreeApi;
	workspace: WorkspaceApi;
	sessions: SessionsApi;
	agent: AgentApi;
	subAgents: SubAgentsApi;
	sideChat: SideChatApi;
	tasks: TasksApi;
	wakeups: WakeupsApi;
	files: FilesApi;
	clipboard: ClipboardApi;
	terminal: TerminalApi;
	providers: ProvidersApi;
	commands: CommandsApi;
	plugins: PluginsApi;
	/**
	 * Tell the window itself what the theme is.
	 *
	 * Two things depend on it: the OS-drawn controls on Windows and Linux, and — on every
	 * platform — the window's own backing colour, which is what a fast resize exposes before
	 * the renderer catches up.
	 *
	 * 两个底色，不是一个。`color` 是窗口自己那层底，`headerColor` 是页面顶上那条 header 的底——
	 * 系统画的那三颗按钮落在 header 里，所以它们身下那块要跟 header 同色，而不是跟窗口同色。
	 */
	setWindowTheme(colors: { color: string; headerColor: string; symbolColor: string }): void;
	/** The theme a generated page is given, for the one place that loads it without a card — `preview-inspect.ts`. */
	setPreviewTheme(theme: PreviewTheme): void;
	/**
	 * Native full screen, reported by the window because the page cannot detect it.
	 *
	 * macOS hides the traffic lights in full screen, and everything inset to clear them has to
	 * stop reserving that space. Fires on entry, on exit, and once after load.
	 */
	onFullScreenChange(handler: (fullScreen: boolean) => void): () => void;
	/**
	 * The window was minimized or restored, reported by the window because the page cannot detect it.
	 *
	 * With `backgroundThrottling` off a minimized page still reads `visibilityState` as visible and
	 * keeps getting animation frames, so decorative animations would go on repainting unseen.
	 */
	onMinimizedChange(handler: (minimized: boolean) => void): () => void;
	/**
	 * A menu item on the status bar icon was chosen.
	 *
	 * Sent only once the window can receive it, so a command given while the app was closed still
	 * lands — the renderer never has to care whether it was already running.
	 */
	/**
	 * What the status bar menu asked for. Typed, so a menu item cannot be added without the window
	 * being made to answer it — see `tray-menu.ts` and `src/tray-commands.ts`.
	 */
	onTrayCommand(handler: (command: TrayCommand) => void): () => void;
	/**
	 * Something failed in the main process with nowhere to report it.
	 *
	 * Surfaced rather than swallowed: an error the window cannot see is one the user cannot act on,
	 * and the alternative — Electron's own modal crash dialog — takes the whole app hostage over
	 * what is usually a dropped connection. Quiet I/O codes never get this far; see `QUIET_IO`.
	 */
	onMainError(handler: (payload: { origin: string; message: string }) => void): () => void;
	updates: UpdatesApi;
	system: SystemApi;
	screenshot: ScreenshotApi;
	pinnedShot: PinnedShotApi;
	index: IndexApi;
	scheduler: SchedulerApi;
	capabilities: CapabilitiesApi;
	skills: SkillsApi;
	forge: ForgeApi;
	git: GitApi;
	memory: MemoryApi;
	projectMemory: ProjectMemoryApi;
	diff: DiffApi;
}
