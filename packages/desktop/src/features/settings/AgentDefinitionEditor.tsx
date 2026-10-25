import { Check, Shuffle } from "../../ui/icons/index.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentDefinitionRecord, AgentDefinitionSave, AgentDraft } from "@plume/core";
import { TextArea } from "../../ui/inputs/TextArea.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { Disclosure } from "../../ui/layout/Disclosure.tsx";
import { AgentAvatar } from "../../ui/avatar/AgentAvatar.tsx";
import { Popover, usePopover } from "../../ui/overlay/Popover.tsx";
import { formatAvatar, freshAvatar, parseAvatar, type Avatar } from "../../lib/agent-avatar.ts";
import type { AvatarOf } from "../../store/agent-avatars.ts";
import { Select } from "../../ui/inputs/Select.tsx";
import { Dialog, DialogAction } from "../../ui/overlay/Dialog.tsx";
import type { Dismiss } from "../../ui/overlay/Overlay.tsx";
import { Segmented, TextInput } from "./controls.tsx";
import { DialogField } from "./dialog-form.tsx";
import { AvatarPicker, avatarName } from "./AvatarPicker.tsx";
import { bridge } from "../../services/index.ts";
import { useI18n } from "../../i18n/index.ts";

// Keep unsaved text through settings navigation without writing instructions to browser storage.
const drafts = new Map<string, { draft: AgentDraft; scope: "user" | "project" }>();
const DEFAULT_TOOLS = ["read", "glob", "grep", "ls"];

/*
 * 新建、复制、编辑都在弹窗里，排法同钩子弹窗：删除在左下，取消、保存在右下。
 * 颜色变量见 `styles/fields.css` 的 `[data-agent-settings]`。
 *
 * 脸放在名字旁边，而且新建时就已经挑好了一张没人用的——它是这个智能体在设置页、`@` 菜单、面板
 * 里被认出来的方式，不该是一个等人想起来才去填的空。不满意就点它换，或者掷一次骰子。
 */
export function AgentDefinitionEditor({ record, copy, projectId, projectName, defaultScope = "user", tools, avatarOf, taken, onClose, onDelete, onSaved }: {
	record?: AgentDefinitionRecord; copy?: boolean; projectId: string | null; projectName?: string;
	/** 新建时存到哪一层：跟着页面上选中的范围。 */
	defaultScope?: "user" | "project";
	tools: string[];
	/** 名单里每个人现在的脸，用来给新来的挑一张没人用的。 */
	avatarOf: AvatarOf;
	/** 除了正在编辑的这一个之外，每个人和他在用的脸。 */
	taken: { name: string; avatar: Avatar }[];
	onClose: () => void; onDelete?: () => void; onSaved: (name: string, warning?: string) => void;
}) {
	const { t } = useI18n();
	const definition = record?.definition;
	const draftKey = JSON.stringify([projectId, record?.id ?? "new", Boolean(copy)]);
	const remembered = drafts.get(draftKey);
	// 新建和复制一张新脸（复制出来的是另一个人）；编辑沿用它现在那张。只在第一次渲染时定下来。
	const [initialAvatar] = useState(() => formatAvatar(record && !copy ? avatarOf(record.definition.name) : freshAvatar(taken.map(other => other.avatar))));
	const original: AgentDraft = { name: copy ? `${definition?.name ?? "agent"}-copy` : definition?.name ?? "", description: definition?.description ?? "", systemPrompt: definition?.systemPrompt ?? "", tools: definition?.tools ?? DEFAULT_TOOLS, avatar: initialAvatar };
	const [draft, setDraft] = useState(remembered?.draft ?? original);
	const [scope, setScope] = useState<"user" | "project">(remembered?.scope ?? (record ? (record.scope === "project" && !copy ? "project" : "user") : defaultScope));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [leaving, setLeaving] = useState(false);
	const [rolls, setRolls] = useState(0);
	const picker = usePopover();
	const dirty = JSON.stringify(draft) !== JSON.stringify(original) || scope !== (record?.scope === "project" && !copy ? "project" : "user");
	useEffect(() => { if (dirty) drafts.set(draftKey, { draft, scope }); else drafts.delete(draftKey); }, [draftKey, draft, scope, dirty]);
	// Esc 和点遮罩照常关掉：没存的字留在 `drafts` 里，下次打开还在。只有「取消」先问一句，因为它读起来像「扔掉」。
	const discard = () => { drafts.delete(draftKey); onClose(); };
	const form = useRef<HTMLFormElement>(null);
	const patch = (next: Partial<AgentDraft>) => setDraft(current => ({ ...current, ...next }));
	const face = parseAvatar(draft.avatar) ?? parseAvatar(initialAvatar) ?? freshAvatar(taken.map(other => other.avatar));
	// 谁在用哪张：选脸的格子据此把别人的那张标出来、不让选，提示里说是谁。
	const owners = useMemo(() => new Map(taken.map(other => [formatAvatar(other.avatar), other.name])), [taken]);
	const editing = Boolean(record && !copy);
	const save = async (dismiss: Dismiss) => {
		if (busy) return;
		setBusy(true); setError("");
		try {
			const input: AgentDefinitionSave = { scope, draft, ...record ? copy ? { copyFrom: record.id } : { id: record.id, revision: record.revision } : {} };
			const result = await bridge.agentDefinitions.save(projectId, input);
			drafts.delete(draftKey); dismiss(() => onSaved(draft.name, result.warning));
		} catch (cause) { setError(String(cause)); }
		finally { setBusy(false); }
	};
	const title = editing && record ? t("agentEditor.editNamed", { name: record.definition.name }) : t("agents.add");
	const selected = draft.tools;
	return <Dialog onClose={onClose} width={640} label={title} title={title}
		detail={record?.scope === "builtin" && !copy ? t("agentEditor.saveAsCustom") : t("agentEditor.intro")}
		bodyClassName="max-h-[min(620px,66dvh)]"
		status={error ? <p role="alert" className="mb-1 text-detail text-danger">{error}</p> : undefined}
		actions={dismiss => {
			/*
			 * 「还有没存的改动」就问在按下取消的那一排：底栏原地换成这句话和两个去处。放在弹窗顶上时，
			 * 人的视线还在右下角，看见的只是取消没反应。
			 */
			if (leaving) return <>
				<span role="alert" className="min-w-0 flex-1 truncate text-detail text-ink">{t("agentEditor.unsaved")}</span>
				<DialogAction autoFocus onClick={() => setLeaving(false)}>{t("agentEditor.keepEditing")}</DialogAction>
				<DialogAction tone="danger" onClick={() => dismiss(discard)} data-agent-discard="">{t("agentEditor.discard")}</DialogAction>
			</>;
			return <>
				{onDelete && <DialogAction tone="danger" disabled={busy} onClick={onDelete}>{t("common.delete")}</DialogAction>}
				<div className="flex-1" />
				<DialogAction disabled={busy} onClick={() => dirty ? setLeaving(true) : dismiss()}>{t("common.cancel")}</DialogAction>
				{/* 按钮在表单外面：走 `requestSubmit`，名字的格式和必填由表单自己拦。 */}
				<DialogAction tone="primary" disabled={busy} onClick={() => form.current?.requestSubmit()} data-agent-save="">{t("common.save")}</DialogAction>
			</>;
		}}>
		{dismiss => <form ref={form} data-agent-settings data-agent-editor className="@container" onSubmit={event => { event.preventDefault(); void save(dismiss); }}>
			<fieldset disabled={busy} className="m-0 min-w-0 space-y-4 border-0 p-0 disabled:opacity-60">
				<div className="flex items-end gap-3">
					{/*
					 * 脸是一块能点的底：点它挑，角上那颗骰子直接换一张没人用的。两颗按钮叠在一块底上而不是
					 * 套在一起——按钮里不能再有按钮。
					 */}
					<div className="relative grid h-[56px] w-[56px] shrink-0 place-items-center rounded-2xl bg-[var(--ly-agent-hover)] transition-colors duration-[var(--ly-t-quick)] hover:bg-[var(--ly-agent-line)]" data-ly-avatar-host="">
						<button type="button" aria-label={t("agentEditor.pickAvatar")} data-ly-tip={`${t("agentEditor.pickAvatar")} · ${avatarName(face, t)}`} aria-haspopup="dialog" aria-expanded={picker.open}
							data-agent-avatar={formatAvatar(face)} onClick={picker.toggle} className="absolute inset-0 rounded-2xl" />
						<AgentAvatar avatar={face} size={38} seed={draft.name || "new"} host="[data-ly-avatar-host]" cheer={rolls || null} className="pointer-events-none" />
						{/*
						 * 骰子是贴在角上的一枚圆章，自带一圈线和一点影子：从前是一块方底的图标按钮压在底座的
						 * 边线上，把边线切出一个方缺口，悬停时又冒出一块灰方片，看上去像贴歪了的补丁。
						 * 圆由外面这层裁出来，按钮自己的方形悬停底色也就跟着是圆的。
						 */}
						<span className="absolute -right-1 -bottom-1 grid overflow-hidden rounded-full bg-float shadow-knob ring-1 ring-[var(--ly-agent-line)]">
							<IconButton size="sm" label={t("agentEditor.shuffleAvatar")} data-agent-shuffle=""
								onClick={() => { patch({ avatar: formatAvatar(freshAvatar([...taken.map(other => other.avatar), face])) }); setRolls(n => n + 1); }}
								icon={<Shuffle size={11} strokeWidth={2.2} aria-hidden />} />
						</span>
					</div>
					<div className="min-w-0 flex-1">
						<DialogField label={t("agentEditor.nameLabel")} htmlFor="ly-agent-name">
							<TextInput id="ly-agent-name" autoFocus={!editing} aria-label={t("agentEditor.callName")} placeholder="code-reviewer" value={draft.name} readOnly={editing} required pattern={editing ? undefined : "[a-z][a-z0-9_-]{0,63}"} onChange={next => patch({ name: next })} mono spellCheck={false} autoComplete="off" />
						</DialogField>
					</div>
					<div className="min-w-0 shrink-0">
						<DialogField label={t("agentEditor.scopeLabel")}>
							{/* 已有的智能体换不了范围（core 只认复制），所以编辑时写成文字：一个点不动的下拉看上去就是坏了。 */}
							{editing
								? <div className="ly-field text-ink-muted" data-ly-tip={t("agentEditor.scopeFixed")}>{scope === "project" ? projectName ?? t("common.currentProject") : t("common.allProjects")}</div>
								: <Select ariaLabel={t("agentEditor.scope")} value={scope} options={[{ value: "user" as const, label: t("common.allProjects") }, ...(projectId ? [{ value: "project" as const, label: projectName ?? t("common.currentProject") }] : [])]} onChange={setScope} />}
						</DialogField>
					</div>
				</div>
				<DialogField label={t("agentEditor.purposeLabel")} htmlFor="ly-agent-purpose">
					<TextInput id="ly-agent-purpose" aria-label={t("agentEditor.purpose")} placeholder={t("agentEditor.purposePlaceholder")} required maxLength={2000} value={draft.description} onChange={next => patch({ description: next })} />
				</DialogField>
				<DialogField label={t("agentEditor.instructionsLabel")} htmlFor="ly-agent-instructions">
					<TextArea id="ly-agent-instructions" aria-label={t("agentEditor.instructions")} placeholder={t("agentEditor.instructionsPlaceholder")} required maxLength={200000} value={draft.systemPrompt} rows={6} resizable className="min-h-16" onChange={next => patch({ systemPrompt: next })} />
				</DialogField>
				<DialogField label={t("agentEditor.allowedTools")} hint={t("agentEditor.toolsNote")}>
					<div className="w-fit">
						<Segmented value={selected === "*" ? "all" : "custom"}
							options={[{ value: "all", label: t("agentEditor.allTools") }, { value: "custom", label: t("agentEditor.customTools") }]}
							onChange={value => patch({ tools: value === "all" ? "*" : selected === "*" ? DEFAULT_TOOLS : selected })} />
					</div>
					{selected !== "*" && <div className="mt-2 rounded-lg border border-[var(--ly-agent-line)] p-1">
						<div className="grid max-h-56 gap-1 overflow-y-auto @md:grid-cols-2 @xl:grid-cols-3">
							{[...new Set([...tools, ...selected])].map(name => <ToolCheckbox key={name} name={name} checked={selected.includes(name)}
								onChange={checked => patch({ tools: checked ? [...selected, name] : selected.filter(tool => tool !== name) })} />)}
						</div>
					</div>}
				</DialogField>
				{definition && <div className="text-label"><Disclosure variant="framed" title={t("agentEditor.advanced")}><p className="mb-2 text-detail text-ink-muted">{t("agentEditor.advancedNote")}</p><pre className="overflow-auto whitespace-pre-wrap break-words text-caption">{JSON.stringify({ model: definition.model, output: definition.output, schemaMode: definition.schemaMode }, null, 2)}</pre></Disclosure></div>}
				<p className="text-caption text-ink-faint">{t("agentEditor.draftNote")}</p>
			</fieldset>
			{picker.open && <Popover anchor={picker.anchor} onClose={picker.close} placement="bottom" align="start" width={316} label={t("agentEditor.pickAvatar")}>
				<AvatarPicker value={face} owners={owners} onChange={next => { patch({ avatar: formatAvatar(next) }); setRolls(n => n + 1); }} />
			</Popover>}
		</form>}
	</Dialog>;
}

/** 工具勾选：整格是按钮，勾上是前景色实底。能改文件、跑命令的几样右边一个红点。 */
function ToolCheckbox({ name, checked, onChange }: { name: string; checked: boolean; onChange: (checked: boolean) => void }) {
	return <button type="button" role="checkbox" aria-checked={checked} onClick={() => onChange(!checked)}
		className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-[var(--ly-t-quick)] hover:bg-[var(--ly-agent-line)]">
		<span className="flex size-6 shrink-0 items-center justify-center">
			<span className={`flex size-4 items-center justify-center rounded-sm border transition-colors duration-[var(--ly-t-quick)] ${checked ? "border-ink bg-ink text-shell" : "border-[var(--ly-agent-line)] bg-float text-transparent"}`}><Check size={14} strokeWidth={2.4} aria-hidden /></span>
		</span>
		<span className="min-w-0 flex-1 truncate text-label font-medium text-ink">{name}</span>
		{RISKY_TOOLS.has(name) && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-danger" />}
	</button>;
}

const RISKY_TOOLS = new Set(["bash", "edit", "write"]);
