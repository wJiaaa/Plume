/**
 * 新建一条斜杠命令：起个名字、选存在哪，文件建好就进编辑器写正文。
 */

import type { ProjectEntry } from "@plume/core";
import { useState } from "react";
import { commandFileName } from "../../../shared/command-name.ts";
import { useI18n } from "../../i18n/index.ts";
import { folderChoiceName } from "../../lib/project-identity.ts";
import { bridge } from "../../services/index.ts";
import { FileText } from "../../ui/icons/index.ts";
import { Input } from "../../ui/inputs/NativeField.tsx";
import { Dialog, DialogAction } from "../../ui/overlay/Dialog.tsx";
import type { Dismiss } from "../../ui/overlay/Overlay.tsx";
import { ChoiceCards, DialogField, EnterSubmits } from "./dialog-form.tsx";

type Scope = "workspace" | "user";

export function CommandCreateDialog({ project, projects, taken, onClose, onCreated }: {
	/** 页面顶上选着的项目。没选项目时「项目」那张卡片用不了：不知道该写进哪个仓库。 */
	project: ProjectEntry | null;
	projects: readonly ProjectEntry[];
	/** 每个范围里已有的文件名，重名在打字时就说，不必等按下创建。 */
	taken: Record<Scope, ReadonlySet<string>>;
	onClose: () => void;
	onCreated: (scope: Scope, path: string) => void;
}) {
	const { t, resolvedLocale } = useI18n();
	const [name, setName] = useState("");
	const [scope, setScope] = useState<Scope>(project ? "workspace" : "user");
	const [failure, setFailure] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const file = commandFileName(name);
	const problem = !name.trim()
		? null
		: !file
			? t("commands.nameInvalid")
			: taken[scope].has(file)
				? t("commands.nameTaken", { name: file })
				: null;
	const ready = file !== null && problem === null && !busy;
	const folder = project ? folderChoiceName(projects, project.path, resolvedLocale) : "";
	const directory = scope === "workspace" ? `${folder}/.plume/commands/` : "~/.plume/commands/";

	async function submit(dismiss: Dismiss) {
		if (!ready) return;
		setBusy(true);
		setFailure(null);
		const result = await bridge.commands.create(scope, file, project?.path ?? "");
		setBusy(false);
		if (!result.ok) {
			setFailure(result.error);
			return;
		}
		dismiss(() => onCreated(scope, result.path));
	}

	return (
		<Dialog
			onClose={onClose}
			width={480}
			label={t("commands.new")}
			title={t("commands.new")}
			detail={t("commands.whatIsIt")}
			bodyClassName="max-h-[min(520px,62dvh)]"
			actions={(dismiss) => (
				<>
					<div className="flex-1" />
					<DialogAction onClick={() => dismiss()}>{t("common.cancel")}</DialogAction>
					<DialogAction tone="primary" disabled={!ready} onClick={() => void submit(dismiss)} data-ly-command-create="">
						{t("commands.createAndEdit")}
					</DialogAction>
				</>
			)}
		>
			{(dismiss) => (
				<form
					data-ly-command-dialog=""
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void submit(dismiss);
					}}
				>
					<DialogField label={t("commands.nameLabel")} htmlFor="ly-command-name" hint={t("commands.nameHint")} error={problem ?? failure}>
						<div className={`ly-field gap-0.5 font-mono ${problem || failure ? "ly-field-invalid" : ""}`}>
							<span className="text-ink-faint" aria-hidden>/</span>
							<Input
								id="ly-command-name"
								autoFocus
								value={name}
								onChange={(event) => {
									setName(event.target.value);
									setFailure(null);
								}}
								placeholder="review-diff"
								spellCheck={false}
								autoComplete="off"
								className="h-full min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-faint"
							/>
						</div>
					</DialogField>
					<DialogField label={t("commands.whereLabel")}>
						<ChoiceCards
							label={t("commands.whereLabel")}
							value={scope}
							onChange={(next) => {
								setScope(next);
								setFailure(null);
							}}
							options={[
								{
									value: "workspace",
									title: project ? t("commands.scopeProjectNamed", { name: folder }) : t("common.project"),
									detail: project ? t("commands.scopeProjectDetail") : t("commands.scopeNeedsProject"),
									disabled: !project,
								},
								{ value: "user", title: t("common.personal"), detail: t("commands.scopePersonalDetail") },
							]}
						/>
						<div className="mt-3 flex min-w-0 items-center gap-2 rounded-lg bg-card px-3 py-2 text-detail text-ink-muted" data-ly-command-path="">
							<FileText size={14} strokeWidth={1.8} className="shrink-0" aria-hidden />
							<span className="min-w-0 truncate font-mono">
								{directory}
								<span className={file ? "text-ink" : "text-ink-faint"}>{file ?? t("commands.nameLabel")}</span>
								.md
							</span>
						</div>
					</DialogField>
					<EnterSubmits />
				</form>
			)}
		</Dialog>
	);
}
