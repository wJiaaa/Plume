/**
 * Windows and what lives in them besides the conversation: popped-out panels, the terminal, the
 * built-in browser, and the theme a generated page is drawn in.
 */

/** 链接指着的那几行，从 1 数起，`from <= to`。 */
export interface FileLines {
	from: number;
	to: number;
}

/** 打开时要跳到的那几行；`at` 每次打开换一个，同一行点两次靠它认出是新的一次。见 `OpenFile.reveal`。 */
export interface FileReveal extends FileLines {
	at: number;
}

/** View state crosses windows; disk contents and permissions are read by the receiving host. */
export interface FilePanelState {
	path: string | null;
	tabs: { path: string; name: string }[];
	wrap: boolean;
	showSource: boolean;
	/** 只在这一次打开带着行号时有：弹出去的文件窗口据此跳行。没有就不写这个键，形状和从前一样。 */
	reveal?: FileReveal;
}

export interface FilePanelVersion {
	version: number;
	state: FilePanelState;
}

/**
 * A panel window asking the main window to open a panel: what `windows:openPanelInMain` takes and
 * `windows:open-panel` hands over. The main process rebuilds it field by field in between.
 */
interface PanelInMain {
	kind: string;
	/** The screen the panel was popped out of, where the request was made. */
	scope?: string;
	/** For the file pane: the file to open, and the lines to land on when the link named some. */
	file?: { path: string; name: string; lines?: FileLines };
}

/**
 * Which window this renderer is, and which conversation it was born showing.
 *
 * Read from `additionalArguments` in the preload, not over IPC — the first frame of an
 * auxiliary window has to know its session before `sessions:list` comes back.
 */
export interface BootWindow {
	id: string;
	sessionId: string | null;
	kind: "primary" | "session" | "panel";
	panelKind: string | null;
	panelScope: string | null;
}

export interface WindowsApi {
	keepOnTop(input?: { enabled: boolean }): Promise<{ ok: boolean; enabled: boolean }>;
	/**
	 * What this window is showing inside `rect` (CSS pixels of the calling page), as a PNG data URL.
	 * For a page an agent made: it runs in a frame of another process, which the renderer cannot
	 * read the pixels of, so the window is asked instead. Null when the area is empty or captured nothing.
	 */
	capture(rect: { x: number; y: number; width: number; height: number }): Promise<string | null>;
	open(input: { sessionId: string }): Promise<{ ok: boolean }>;
	list(): Promise<{ sessions: string[]; panels: { kind: string; scope: string; sessionId?: string | null }[] }>;
	openInMain(input: { sessionId: string }): Promise<{ ok: boolean }>;
	openPanel(input: { kind: string; scope: string; sessionId: string | null; fileState?: FilePanelState }): Promise<{ ok: boolean }>;
	/**
	 * Ask the primary window to open a panel, because this window has no dock to open it in.
	 *
	 * A panel window is one panel. Clicking a file in a detached file tree still means "show me
	 * this file" — it just cannot mean "here". The request goes where the docks are.
	 *
	 * `scope` is the screen the panel was popped out of, where the request was made; `file` is the
	 * file to open, which the main window's own open-file store cannot know.
	 */
	openPanelInMain(input: PanelInMain): Promise<{ ok: boolean }>;
	filePanelState(input?: FilePanelVersion): Promise<FilePanelVersion | null>;
	restorePanel(input: { kind: string; scope: string }): Promise<{ ok: boolean }>;
	closePanel(input: { kind: string; scope: string }): Promise<{ ok: boolean }>;
	onChanged(handler: (state: { sessions: string[]; panels?: { kind: string; scope: string; sessionId?: string | null }[] }) => void): () => void;
	onShowSession(handler: (state: { sessionId: string }) => void): () => void;
	onRestorePanel(handler: (state: { kind: string; scope: string; fileState?: FilePanelState }) => void): () => void;
	/** The primary window's half of `openPanelInMain`. */
	onOpenPanel(handler: (state: PanelInMain) => void): () => void;
	onClosePanel(handler: () => void): () => void;
	onFilePanelState(handler: (input: FilePanelVersion & { previous?: FilePanelState }) => void): () => void;
}

/** One shell in a directory, as the tab strip lists it. */
export interface TerminalTab {
	id: string;
	title: string;
	/** The program in the foreground when it is not the shell; `null` at the prompt and on Windows. */
	process?: string | null;
}

/** What a pane gets back when it connects to a shell. */
interface AttachedTerminal {
	id: string;
	title: string;
	pid: number;
	/** This connection's number, to be quoted back to `detach`. */
	epoch: number;
	/** Everything the shell has written, for redrawing a pane that came back. */
	replay: string;
}

/** A real pseudo-terminal, one per tab. */
export interface TerminalApi {
	/** Every shell this directory already has. */
	list(cwd: string): Promise<TerminalTab[]>;
	/**
	 * Every shell there is — the pane's tabs.
	 *
	 * Not filed under the current project: leaving a project is not a reason to stop showing a
	 * terminal that is still running. Where a *new* shell starts is the only thing the project
	 * decides. See `listAll` in `terminal-registry.ts`.
	 */
	listAll(): Promise<TerminalTab[]>;
	/** Start another shell here. Always a new one: this is what the tab strip's `+` does. */
	open(cwd: string, cols: number, rows: number): Promise<AttachedTerminal>;
	/**
	 * Start the app's first shell now, so opening the pane later costs nothing.
	 *
	 * Does nothing if any shell is already running. The shell is left unattached, so it does
	 * not send anything to a pane that is not showing it — it only records, and the first
	 * `attach` replays that recording into a prompt that is already finished.
	 */
	prewarm(cwd: string, cols: number, rows: number): void;
	/**
	 * Connect to a shell that already exists.
	 *
	 * `replay` is everything it has written so far, for redrawing a pane that was unmounted
	 * while the shell kept running. `null` if that shell is gone — it may have exited while
	 * the pane was away.
	 */
	attach(id: string, cols: number, rows: number): Promise<AttachedTerminal | null>;
	/**
	 * Stop listening. The shell keeps running, and `attach` picks it up again.
	 *
	 * `epoch` is the one `attach` returned: a cleanup that has already been superseded by a
	 * newer connection must not mute a shell that pane is still watching.
	 */
	detach(id: string, epoch: number): void;
	write(id: string, data: string): void;
	resize(id: string, cols: number, rows: number): void;
	kill(id: string): void;
	onData(handler: (payload: { id: string; data: string }) => void): () => void;
	onExit(handler: (payload: { id: string; code: number }) => void): () => void;
	/** The foreground program changed — see `TerminalTab.process`. */
	onProcess(handler: (payload: { id: string; process: string | null }) => void): () => void;
}

export interface BrowserViewport { width: number; height: number }

export interface BrowserPointer { x: number; y: number; action: "click" | "type" | "hover" | "scroll" | "press"; sequence: number }

export interface BrowserTab {
	id: string;
	sessionId: string | null;
	url: string;
	title: string;
	loading: boolean;
	error?: string;
	/**
	 * This page did not load, or its process stopped and will not come back by itself: what is in the
	 * tab is not the page. Cleared when the tab starts loading a document again.
	 *
	 * Apart from `error`, which is a remark beside a page that still works (a popup it was not allowed
	 * to open), because only this one covers the page.
	 *
	 * `blocked`: the page sent the tab to an address that is not a web page (`lark://…` to wake a
	 * desktop client), which this browser refuses. `detail` is that address, `url` the web page that
	 * led there — the one to hand the system browser, which can ask whether to open the client.
	 */
	failure?: { kind: "load" | "crash"; detail: string } | { kind: "blocked"; detail: string; url: string };
	canGoBack: boolean;
	canGoForward: boolean;
	zoom: number;
	viewport: BrowserViewport | null;
	pointer?: BrowserPointer;
	/**
	 * The main process is waiting for this tab's page to exist.
	 *
	 * Tabs belonging to conversations you are not looking at are unmounted to get their renderer
	 * processes back, which is fine until an agent in one of them reaches for its own tab. This is
	 * how it asks for it back: set before the wait, cleared once the page attaches.
	 */
	wanted?: boolean;
}

export interface BrowserState { tabs: BrowserTab[]; activeId: string | null }

export interface BrowserSelection {
	url: string;
	title: string;
	selector: string;
	html: string;
	text: string;
	styles: Record<string, string>;
	bounds: { x: number; y: number; width: number; height: number };
	screenshot: string;
}

export type BrowserCommand =
	| { type: "open"; url: string; sessionId: string | null; newTab?: boolean }
	| { type: "navigate"; id: string; url: string }
	| { type: "select" | "close" | "back" | "forward" | "reload" | "devtools" | "external"; id: string }
	/** What the address bar holds but has not opened yet, for the system's browser. */
	| { type: "external"; url: string }
	| { type: "zoom"; id: string; factor: number }
	| { type: "resize"; id: string; width: number; height: number }
	| { type: "viewport"; id: string; viewport: BrowserViewport | null };

export interface BrowserApi {
	state(): Promise<BrowserState>;
	command(command: BrowserCommand): Promise<BrowserState>;
	attach(id: string, contentsId: number): Promise<void>;
	inspect(id: string, mode: "element" | "region"): Promise<BrowserSelection | null>;
	cancelInspect(id: string): Promise<void>;
	onChanged(handler: (state: BrowserState & { reveal: boolean }) => void): () => void;
}

export interface PreviewTheme {
	scheme: "dark" | "light";
	/** Custom property name → value, every name starting with `--`. */
	vars: Record<string, string>;
}
