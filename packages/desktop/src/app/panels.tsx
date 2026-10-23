/**
 * The panels that ship with the app.
 *
 * Registered like any other set, so there is nothing special about them beyond loading first —
 * which is exactly the property that lets a plugin replace one.
 *
 * In the shell, not in `dock/`: this list imports nearly every feature, and nearly every feature
 * imports `dock` to open a panel. While `dock/index` pulled this file in, each of those imports
 * closed a cycle back through it — 64 of the 108 in the baseline. `App.tsx` imports it once.
 *
 * A panel that only this list draws is imported from its file, not its domain's index: on the index
 * it is carried into every domain that wanted something small from it — `SubAgentBar` for the
 * composer, `TaskList` for the conversation — and those panels lead back to both.
 */

import { Bot, FileDiff, FileText, Folder, GitCompare, Globe, History, ListOrdered, ListTodo, MessageCirclePlus, SquareTerminal, Undo2 } from "../ui/icons/index.ts";

import { BrowserPanel, BrowserTabTitle, browserResidentsOf, closeBrowser, newBrowserPage, subscribeBrowserResidents } from "../features/browser/index.ts";
import { FileBrowser } from "../features/files/index.ts";
import { FilePanel } from "../features/files/index.ts";
import { SubAgentPanel } from "../features/subagents/SubAgentPanel.tsx";
import { FileActions } from "../features/files/index.ts";
import { FileTitle, FileTabTitle, closeFile } from "../features/files/index.ts";
import { DiffView, GitPanel } from "../features/git/index.ts";
import { SideChat, SideChatTitle, closeSideChat, confirmCloseSideChat } from "../features/sidechat/index.ts";
import { TaskPanel } from "../features/task/TaskPanel.tsx";
import { TerminalPane, TerminalTitle, closeTerminal, confirmCloseTerminal } from "../features/terminal/index.ts";
import { TrajectoryPanel, useDeliveryReview, useDeliveryUndo, useSharedDeliveryTarget, useTurnDelivery } from "../features/conversation/index.ts";
import { usePathMenu } from "../features/markdown/index.ts";
import { useI18n } from "../i18n/index.ts";
import { relativeTo } from "../lib/paths.ts";
import { PanelEmpty } from "../ui/layout/PanelEmpty.tsx";
import { IconButton } from "../ui/primitives/IconButton.tsx";
import { Scroller } from "../ui/scroll/Scroller.tsx";
import { closeNow } from "../features/dock/index.ts";
import { useDockScope, useScopedProjectPath, useScopedSessionId } from "./session-scope.tsx";
import { registerPanels, type PanelDefinition } from "../features/dock/panels/registry.ts";
import { PlanPanel } from "../features/dock/panels/PlanPanel.tsx";

const needsWorkspace = (state: { workspace: boolean }) => (state.workspace ? undefined : "dock.needProject");
const needsSession = (state: { session: boolean }) => (state.session ? undefined : "dock.needSession");

function deliveryCounts(added: number, removed: number) {
	return <span className="flex shrink-0 items-center gap-1.5 tabular-nums"><span className="text-ok">+{added}</span><span className="text-danger">−{removed}</span></span>;
}

function deliveryName(path: string) {
	const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
	return <span className="min-w-0 flex-1 truncate"><span className="text-ink-muted">{path.slice(0, split)}</span><span className="text-ink">{path.slice(split)}</span></span>;
}

/**
 * This turn's recorded diffs, in a dock pane.
 *
 * Lives next to the other built-in renders so conversation/index does not
 * have to export a panel that pulls git and dock back into itself.
 */
function DeliveryTitle() {
	const { t } = useI18n();
	const owner = useScopedSessionId();
	const path = useDeliveryReview((state) => (owner ? (state.reviews[owner]?.target.path ?? null) : null));
	const name = path ? path.split(/[\\/]/).pop() : null;
	return (
		<span className="flex min-w-0 items-center gap-1 py-0.5 pl-1 text-detail">
			<FileDiff size={12.5} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
			<span className="min-w-0 truncate text-ink">{name ?? t("delivery.fileChanges")}</span>
		</span>
	);
}

function DeliveryPanel() {
	const { t } = useI18n();
	// Named from the project of this screen's conversation; the live slot's is the focused screen's.
	const workspace = useScopedProjectPath();
	// The conversation whose screen this panel is in — not whichever one has the focus.
	const owner = useScopedSessionId();
	const scope = useDockScope();
	// A popped-out pane starts with an empty store; the turn it shows is on the shared record.
	useSharedDeliveryTarget(owner);
	// Right-click on a file's header: the same menu as the file's row on the card, minus 打开 — this
	// pane is the turn's recorded diff, and opening the file's current contents is the card's to offer.
	const pathMenu = usePathMenu(workspace);
	// That conversation's own review: one opened under another screen is that screen's, and leaves this one be.
	const target = useDeliveryReview((state) => (owner ? (state.reviews[owner]?.target ?? null) : null));
	// The same entry the turn's card reads, so an undo on either — or in another window — shows on both.
	const data = useTurnDelivery(target?.sessionId ?? null, target?.timestamp ?? null);
	const { undoing, ask, element: confirmElement } = useDeliveryUndo(target?.sessionId ?? null, target?.timestamp ?? null, (value) => {
		if (value.files.length || !target) return;
		if (scope) closeNow(scope, "delivery");
		else useDeliveryReview.getState().close(target.sessionId);
	});

	if (!target) return <PanelEmpty icon={FileDiff} title={t("delivery.fileChanges")} />;
	const files = (data?.files ?? []).filter((file) => !target.path || file.path === target.path);
	if (!files.length) return <PanelEmpty icon={FileDiff} title={t("delivery.fileChanges")} />;
	const relative = (path: string) => workspace ? relativeTo(workspace, path) : path;

	return <>
		{/* No top fade: a file's header is always pinned at the top once scrolled, so the fade would only dissolve the header itself. */}
		<Scroller top="none">
			{files.map((file) => (
				<section key={file.path} data-delivery-diff={file.path} className="mb-1">
					<div className="ly-pin sticky top-0 z-10">
						<div className="flex min-w-0 items-center gap-3 px-3 py-2 text-label" onContextMenu={(event) => pathMenu.onContextMenu(event, { path: file.path })}>
							{deliveryName(relative(file.path))}
							{deliveryCounts(file.added, file.removed)}
							<IconButton
								size="sm"
								icon={<Undo2 size={14} />}
								label={file.canUndo ? t("delivery.revertOne") : t("delivery.cannotRevert")}
								explainDisabled
								disabled={!file.canUndo || undoing}
								onClick={() => ask(file.path)}
							/>
						</div>
					</div>
					<DiffView path={file.path} hunks={file.hunks} maxLines={Infinity} />
				</section>
			))}
		</Scroller>
		{confirmElement}
		{pathMenu.element}
	</>;
}

const BUILTIN_PANELS: PanelDefinition[] = [
	{
		kind: "files",
		label: "common.files",
		icon: Folder,
		shortcut: "⌘P",
		unavailable: needsWorkspace,
		render: FileBrowser,
	},
	/*
	 * The open file, in a tab of its own rather than inside the tree.
	 *
	 * Opened by clicking a file rather than from the menu, most of the time — but it is listed
	 * there like any other pane, because once you have closed it the menu is how you say you want
	 * it back without having to find a file to click.
	 */
	{
		kind: "file",
		label: "dock.fileContents",
		icon: FileText,
		shortcut: "⌥⌘P",
		unavailable: needsWorkspace,
		// The open file and how it is being read move with it — `file-panel-handoff.ts` is that code.
		detach: "handoff",
		render: FilePanel,
		/*
		 * The file's name in place of the pane's, with the tree behind it.
		 *
		 * 「文件内容」 names a category nobody was in doubt about, on the one row that could have said
		 * which file — and this pane is very often the one left open after the tree has been
		 * closed, at which point it had neither a name nor a way to reach another file. See `FileTitle`.
		 */
		header: FileTitle,
		actions: FileActions,
		// 每个打开的文件是顶上的一个标签，写它的文件名——见 `openFilePane`。
		tabTitle: FileTabTitle,
		onClose: closeFile,
	},
	/*
	 * Delegated work, in a pane of its own.
	 *
	 * Beside 「侧边聊天」 because it is the same shape — a conversation that is not the main one —
	 * and deliberately not inside it: the side chat is yours to ask questions in, a sub-agent is
	 * the main agent's own worker. Merging them would put two different relationships in one pane.
	 */
	{
		kind: "subagents",
		label: "subAgent.title",
		icon: Bot,
		shortcut: "⌥⌘U",
		unavailable: needsSession,
		render: SubAgentPanel,
	},
	{
		kind: "chat",
		label: "dock.sideChat",
		icon: MessageCirclePlus,
		shortcut: "⌥⌘S",
		unavailable: needsSession,
		render: SideChat,
		tabTitle: SideChatTitle,
		onClose: closeSideChat,
		confirmClose: confirmCloseSideChat,
	},
	{
		kind: "terminal",
		label: "common.terminal",
		icon: SquareTerminal,
		shortcut: "⌃`",
		/*
		 * No availability rule: a shell needs a directory and there is always one.
		 *
		 * With a project open it starts there; without, the registry falls back to the home
		 * directory — the same thing every other terminal on the machine does.
		 */
		render: TerminalPane,
		tabTitle: TerminalTitle,
		onClose: closeTerminal,
		confirmClose: confirmCloseTerminal,
	},
	{ kind: "tasks", label: "common.tasks", icon: ListTodo, shortcut: "⌘J", render: TaskPanel },
	{
		kind: "trajectory",
		label: "trajectory.title",
		icon: History,
		shortcut: "⌘L",
		unavailable: needsSession,
		render: TrajectoryPanel,
	},
	/*
	 * No window of its own: a `<webview>` cannot be moved between documents.
	 *
	 * The tab list is in the main process, so the *rows* would survive — but the page would be
	 * loaded again from its URL in the new window, which throws away scroll position, anything
	 * typed into a form, and whatever the page itself was holding. A button that silently reloads
	 * your page is worse than no button.
	 */
	{ kind: "browser", label: "browser.title", icon: Globe, shortcut: "⌘T", detach: "none", render: BrowserPanel, tabTitle: BrowserTabTitle, create: newBrowserPage, residents: { subscribe: subscribeBrowserResidents, get: browserResidentsOf }, onClose: closeBrowser },
	{ kind: "review", label: "common.git", icon: GitCompare, shortcut: "⌘⇧R", unavailable: needsWorkspace, render: GitPanel },
	/*
	 * This turn's recorded diffs — opened from the delivery card, not the +
	 * menu. Git stays `review`; the file pane stays current contents.
	 */
	{
		kind: "delivery",
		label: "delivery.fileChanges",
		icon: FileDiff,
		shortcut: "",
		listed: false,
		ephemeral: true,
		unavailable: needsSession,
		render: DeliveryPanel,
		header: DeliveryTitle,
		// 关掉就不再审阅这一轮：卡片上「正在看」的标记和弹出窗口读的那份记录一起清掉。
		onClose: (scope) => { if (scope !== "@draft") useDeliveryReview.getState().close(scope); },
		/*
		 * "self", said rather than defaulted: which turn and which file the pane shows is renderer state
		 * (`useDeliveryReview`), but it is also kept per conversation in localStorage, which every window
		 * shares — so a popped-out pane reads it itself and follows it (`useSharedDeliveryTarget`), and the
		 * diff it then fetches comes from the main process. Undeclared, it popped out as an empty pane.
		 */
		detach: "self",
	},
	/*
	 * 计划模式交上来的计划。计划交上来时审批卡替人打开；这场对话交过计划以后，「面板」菜单和「+」里
	 * 一直有它，没交过就不列——空的计划面板没有可看的。
	 *
	 * 正文从会话历史里读（`currentPlan`），所以重启、换会话回来都还在，布局里留着它也不会开出一格空的。
	 * 评论只在这个渲染进程的内存里（`store/plan-review.ts`），弹出去的窗口拿不到，所以不给弹出。
	 */
	{
		kind: "plan",
		label: "plan.title",
		icon: ListOrdered,
		shortcut: "",
		unavailable: (state) => needsSession(state) ?? (state.plan ? undefined : "plan.none"),
		detach: "none",
		render: PlanPanel,
	},
];

registerPanels(BUILTIN_PANELS);
