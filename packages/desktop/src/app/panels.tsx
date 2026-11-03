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

import { Bot, FileDiff, FileText, Folder, GitCompare, Globe, History, ListOrdered, ListTodo, MessageCirclePlus, SquareTerminal } from "../ui/icons/index.ts";

import { BrowserPanel, BrowserTabTitle, browserResidentsOf, closeBrowser, newBrowserPage, subscribeBrowserResidents } from "../features/browser/index.ts";
import { FileBrowser } from "../features/files/index.ts";
import { FilePanel } from "../features/files/index.ts";
import { SubAgentPanel } from "../features/subagents/SubAgentPanel.tsx";
import { FileActions } from "../features/files/index.ts";
import { FileTitle, FileTabTitle, closeFile } from "../features/files/index.ts";
import { GitPanel } from "../features/git/index.ts";
import { SideChat, SideChatTitle, closeSideChat, confirmCloseSideChat } from "../features/sidechat/index.ts";
import { TaskPanel } from "../features/task/TaskPanel.tsx";
import { TerminalPane, TerminalTitle, closeTerminal, confirmCloseTerminal } from "../features/terminal/index.ts";
import { useDeliveryReview } from "../features/conversation/index.ts";
import { TrajectoryPanel } from "../features/trajectory/TrajectoryPanel.tsx";
import { DeliveryPanel, DeliveryTitle } from "../features/conversation/DeliveryPanel.tsx";
import { registerPanels, type PanelDefinition } from "../features/dock/panels/registry.ts";
import { PlanPanel } from "../features/dock/panels/PlanPanel.tsx";

const needsWorkspace = (state: { workspace: boolean }) => (state.workspace ? undefined : "dock.needProject");
const needsSession = (state: { session: boolean }) => (state.session ? undefined : "dock.needSession");

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
