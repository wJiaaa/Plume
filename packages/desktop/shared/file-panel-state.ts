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

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function count(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

/** 另一个渲染进程递过来的行号：正整数、起不大于止，否则当它没给。 */
export function readFileLines(value: unknown): FileLines | null {
	if (!record(value) || !count(value.from) || !count(value.to) || value.from > value.to) return null;
	return { from: value.from, to: value.to };
}

function readFileReveal(value: unknown): FileReveal | null {
	const lines = readFileLines(value);
	return lines && record(value) && count(value.at) ? { ...lines, at: value.at } : null;
}

/** `reveal` 键只在有值时出现。 */
function withReveal(state: Omit<FilePanelState, "reveal">, reveal: FileReveal | null | undefined): FilePanelState {
	return reveal ? { ...state, reveal } : state;
}

export function readFilePanelState(value: unknown): FilePanelState | null {
	if (!record(value) || !Array.isArray(value.tabs)) return null;
	if (value.path !== null && !text(value.path)) return null;
	if (typeof value.wrap !== "boolean" || typeof value.showSource !== "boolean") return null;
	const tabs: FilePanelState["tabs"] = [];
	const paths = new Set<string>();
	for (const tab of value.tabs) {
		if (!record(tab) || !text(tab.path) || !text(tab.name) || paths.has(tab.path)) return null;
		paths.add(tab.path);
		tabs.push({ path: tab.path, name: tab.name });
	}
	if (value.path !== null && !paths.has(value.path)) return null;
	const reveal = value.reveal === undefined ? null : readFileReveal(value.reveal);
	if (value.reveal !== undefined && !reveal) return null;
	return withReveal({ path: value.path, tabs, wrap: value.wrap, showSource: value.showSource }, reveal);
}

/**
 * Opening from the source adds its tabs to the detached pane's, and switches to the requested file.
 *
 * 跳行跟着这一次请求走：请求没带就没有，不沿用上一次的——那一次已经跳过了。带着行号打开时以源码看，
 * Markdown 渲染出来的页面上没有行，同 `useOpenFile.open`。
 */
export function requestFilePanel(current: FilePanelState, requested: FilePanelState): FilePanelState {
	const known = new Set(current.tabs.map((tab) => tab.path));
	const { reveal: _previous, ...rest } = current;
	return withReveal({
		...rest,
		path: requested.path ?? current.path,
		tabs: [...current.tabs, ...requested.tabs.filter((tab) => !known.has(tab.path))],
		showSource: requested.reveal ? true : requested.path === current.path ? current.showSource : requested.showSource,
	}, requested.reveal);
}

/** Apply only this host's changes, retaining tabs another host opened meanwhile. */
export function mergeFilePanelChanges(before: FilePanelState, next: FilePanelState, current: FilePanelState): FilePanelState {
	const oldPaths = new Set(before.tabs.map((tab) => tab.path));
	const nextPaths = new Set(next.tabs.map((tab) => tab.path));
	const tabs = current.tabs.filter((tab) => !oldPaths.has(tab.path) || nextPaths.has(tab.path));
	const kept = new Set(tabs.map((tab) => tab.path));
	for (const tab of next.tabs) if (!kept.has(tab.path)) tabs.push(tab);
	const path = current.path === before.path ? next.path : current.path;
	// 跨过 IPC 的对象不再是同一个，跳行认 `at`。
	const reveal = (current.reveal?.at ?? 0) === (before.reveal?.at ?? 0) ? next.reveal : current.reveal;
	return withReveal({
		path: tabs.some((tab) => tab.path === path) ? path : next.path,
		tabs,
		wrap: current.wrap === before.wrap ? next.wrap : current.wrap,
		showSource: current.showSource === before.showSource ? next.showSource : current.showSource,
	}, reveal);
}
