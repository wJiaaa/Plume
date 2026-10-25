/**
 * 斜杠命令：在输入框里敲 `/` 能用到什么。
 */

import type { BuiltinCommand } from "@plume/core/commands-builtin";
import type { SlashCommand } from "@plume/core/commands-view";
import { FolderOpen, Plus, RefreshCw, SquareTerminal } from "../../ui/icons/index.ts";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../store/index.ts";
import { ProjectScope } from "./ProjectScope.tsx";
import { Card, PageHeader } from "./layout.tsx";
import { DefinitionToolbar, DiagnosticNotices } from "./definition-page.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import { bridge } from "../../services/index.ts";
import { RowDeleteButton } from "../../ui/primitives/RowDeleteButton.tsx";
import { useDefinitionRemoval } from "./useDefinitionRemoval.tsx";
import { translate, useI18n } from "../../i18n/index.ts";
import { CommandCreateDialog } from "./CommandCreateDialog.tsx";

export function CommandsSettings() {
	const { t } = useI18n();

	return (
		<div className="pt-2">
			<PageHeader title={t("commands.title")} intro={t("commands.intro")} />
			<SlashCommands />
		</div>
	);
}

/** Where a command came from, said the same way the composer says it. */
function originOf(command: SlashCommand): string {
	if (command.origin === "claude") return command.scope === "workspace" ? translate("commands.claudeProject") : translate("commands.claudePersonal");
	return command.scope === "workspace" ? translate("common.project") : translate("common.personal");
}

function matchesQuery(command: { name: string; description?: string; argumentHint?: string }, query: string): boolean {
	if (!query) return true;
	return [command.name, command.description, command.argumentHint].some((value) => value?.toLowerCase().includes(query));
}

/*
 * 布局照钩子页：顶上一行是范围、数量和搜索，下面「已安装」一段，每条一行，点开是编辑器。
 *
 * 新建从前是在列表上方展开一行输入，理由是只要一个名字。后来设置页的新建都进了弹窗，这一条
 * 也跟着进去：除了名字还要说清存在哪、会写出哪个文件，一行输入放不下这些，而列表跟着上下跳。
 */
function SlashCommands() {
	const { t } = useI18n();
	const projects = useApp((s) => s.settings?.projects) ?? [];
	/** null 是用户级；项目被移除后回到用户级，而不是继续读一个已经不在列表里的目录。 */
	const [projectPath, setProjectPath] = useState<string | null>(null);
	const project = projects.find((entry) => entry.path === projectPath) ?? null;
	const cwd = project?.path ?? "";
	const scope = project ? "workspace" : "user";
	const [list, setList] = useState<{ commands: SlashCommand[]; builtins: BuiltinCommand[]; diagnostics: { path: string; message: string }[] } | null>(
		null,
	);
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);

	const refresh = useCallback(() => {
		void bridge.commands.list(cwd).then(setList);
	}, [cwd]);
	const removal = useDefinitionRemoval("command", cwd, refresh);

	useEffect(refresh, [refresh]);

	/*
	 * Re-read when the window is focused again.
	 *
	 * Creating a command opens it in an external editor, so the interesting moment is coming back
	 * from that editor — without this the list still shows the description the template shipped
	 * with, and the page looks like it did not notice the file being written.
	 */
	useEffect(() => {
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	function startCreate() {
		setCreating(true);
	}

	function created(target: "workspace" | "user", path: string) {
		setCreating(false);
		// 建在个人目录里时顶上还停在项目，列表按范围筛，新的那条就不在眼前。
		if (target === "user") setProjectPath(null);
		refresh();
		// Straight into the editor: a new command is an empty file until somebody writes the prompt.
		void bridge.commands.open(path);
	}

	const commands = (list?.commands ?? []).filter((command) => command.scope === scope);
	const needle = query.trim().toLowerCase();
	const visible = commands.filter((command) => matchesQuery(command, needle));
	const builtins = (list?.builtins ?? []).filter((command) => matchesQuery(command, needle));
	/*
	 * Split by whether the file loaded, which the command list already says: a misspelt field or a
	 * `---` never closed still leaves the command in the list, and counting it as failed to load
	 * contradicted its own row. Both headers count files.
	 */
	const loaded = new Set((list?.commands ?? []).map((command) => command.path));
	const diagnostics = (list?.diagnostics ?? []).filter((diagnostic) => !loaded.has(diagnostic.path));
	const warnings = (list?.diagnostics ?? []).filter((diagnostic) => loaded.has(diagnostic.path));
	const failed = new Set(diagnostics.map((diagnostic) => diagnostic.path)).size;
	const warned = new Set(warnings.map((warning) => warning.path)).size;

	return (
		<div data-ly-commands-settings="">
			<DefinitionToolbar scope={<ProjectScope value={project} projects={projects} onChange={setProjectPath} />}
				title={t("commands.title")} count={visible.length} query={query} onQuery={setQuery} placeholder={t("commands.searchPlaceholder")} />

			<DiagnosticNotices className="mt-5"
				problems={diagnostics} problemsTitle={t("commandsSettings.failedToLoad", { n: failed })}
				warnings={warnings} warningsTitle={t("commandsSettings.warnings", { n: warned })} />

			<section className="mt-6">
				<div className="mb-4 flex items-center justify-between gap-3">
					<h2 className="flex h-7 items-center gap-1.5 text-label font-medium text-ink">
						{t("hooks.installed")}
						<span className="text-detail font-normal text-ink-faint">{commands.length}</span>
					</h2>
					<div className="flex items-center gap-1.5">
						<Button
							variant="subtle"
							size="sm"
							icon={<FolderOpen size={13} aria-hidden />}
							label={scope === "workspace" ? t("commands.openProjectDir") : t("commands.openPersonalDir")}
							onClick={() => void bridge.commands.reveal(scope, cwd)}
						/>
						<Button variant="subtle" size="sm" icon={<RefreshCw size={13} aria-hidden />} label={t("common.refresh")} onClick={refresh} />
						<Button size="sm" icon={<Plus size={13} aria-hidden />} onClick={startCreate}>
							{t("common.new")}
						</Button>
					</div>
				</div>

				{commands.length === 0 ? (
					<Card>
						<div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
							<div className="text-label font-medium text-ink">{t("commands.emptyTitle")}</div>
							<p className="max-w-[360px] text-detail text-ink-faint">{t("commands.whatIsIt")}</p>
							<Button variant="primary" className="mt-2" icon={<Plus size={13} aria-hidden />} onClick={startCreate}>
								{t("commands.new")}
							</Button>
						</div>
					</Card>
				) : visible.length === 0 ? (
					<Card>
						<p className="px-6 py-10 text-center text-label text-ink-faint">{t("commands.searchEmpty")}</p>
					</Card>
				) : (
					<Card className="divide-y divide-line-soft">
						{visible.map((command) => (
							<CommandRow
								key={command.path}
								name={command.name}
								argumentHint={command.argumentHint}
								detail={command.description || command.path}
								onOpen={() => void bridge.commands.open(command.path)}
								openLabel={t("commands.editNamed", { name: command.name })}
								actions={
									<>
										<span className="whitespace-nowrap text-detail text-ink-faint">{originOf(command)}</span>
										<RowDeleteButton
											label={t("commands.deleteNamed", { name: command.name })}
											pending={removal.pending.has(command.path)}
											onClick={() => removal.ask(command.name, command.path)}
										/>
									</>
								}
							/>
						))}
					</Card>
				)}
			</section>

			{/*
			 * 内建的单列一段，而且不可编辑。
			 *
			 * 这一页回答的是「有哪些命令可以用」，而它此前漏掉了用得最多的三条——那三条写在
			 * `/` 菜单那个组件里，只有那一个界面知道。一个漏掉三分之一答案的列表，比没有列表
			 * 更误导人。
			 *
			 * 不混进「已安装」：它们没有文件可以打开，也不分个人和项目，而上面每一行点开都是编辑器。
			 */}
			{builtins.length > 0 && (
				<section className="mt-8">
					<h2 className="mb-4 flex h-7 items-center gap-1.5 text-label font-medium text-ink">
						{t("commands.builtin")}
						<span className="text-detail font-normal text-ink-faint">{builtins.length}</span>
					</h2>
					<Card className="divide-y divide-line-soft">
						{builtins.map((command) => (
							<CommandRow key={command.name} name={command.name} detail={command.description} />
						))}
					</Card>
				</section>
			)}
			{removal.element}
			{creating && (
				<CommandCreateDialog
					project={project}
					projects={projects}
					taken={takenNames(list?.commands ?? [])}
					onClose={() => setCreating(false)}
					onCreated={created}
				/>
			)}
		</div>
	);
}

/** 每个范围里 Plume 自己目录下已有的文件名。`.claude` 下的同名命令不挡：新文件不写进那里。 */
function takenNames(commands: readonly SlashCommand[]): Record<"workspace" | "user", Set<string>> {
	const taken = { workspace: new Set<string>(), user: new Set<string>() };
	for (const command of commands) if (command.origin !== "claude") taken[command.scope].add(command.name);
	return taken;
}

/** 一条命令，行的样子跟钩子页的 `HookRow` 一致。 */
function CommandRow({
	name,
	argumentHint,
	detail,
	actions,
	onOpen,
	openLabel,
}: {
	name: string;
	argumentHint?: string;
	detail?: string;
	actions?: React.ReactNode;
	onOpen?: () => void;
	openLabel?: string;
}) {
	return (
		<div
			role={onOpen ? "button" : undefined}
			tabIndex={onOpen ? 0 : undefined}
			aria-label={openLabel}
			data-row-actions=""
			onClick={onOpen}
			onKeyDown={
				onOpen
					? (event) => {
							if (event.target !== event.currentTarget) return;
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								onOpen();
							}
						}
					: undefined
			}
			className={`flex cursor-default items-center gap-3 px-4 py-3 ${onOpen ? "transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover" : ""}`}
		>
			<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-shell text-ink-faint" aria-hidden>
				<SquareTerminal size={16} strokeWidth={1.8} />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate font-mono text-label font-medium text-ink">
						<span className="text-ink-faint">/</span>
						{name}
					</span>
					{argumentHint && <span className="truncate font-mono text-detail text-ink-faint">{argumentHint}</span>}
				</div>
				{detail && <p className="mt-1 truncate text-detail text-ink-faint">{detail}</p>}
			</div>
			{actions && (
				<div className="flex shrink-0 items-center gap-2" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
					{actions}
				</div>
			)}
		</div>
	);
}
