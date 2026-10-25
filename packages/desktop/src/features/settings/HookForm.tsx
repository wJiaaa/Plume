/**
 * 新建和编辑一条钩子，在弹窗里。字段：事件、范围、匹配器、运行方式、命令，
 * 进程型再加参数，Shell 型再加 shell 和后台运行；超时、状态消息和原样保留的自定义字段收在「高级」里。
 */

import type { HookDraft, HookEventName, HookScope } from "@plume/core";
import { ChevronRight } from "../../ui/icons/index.ts";
import { useState } from "react";
import type { HookView } from "@plume/contract";
import { useI18n, type MessageKey } from "../../i18n/index.ts";
import { TextArea } from "../../ui/inputs/TextArea.tsx";
import { Select } from "../../ui/inputs/Select.tsx";
import { Dialog, DialogAction } from "../../ui/overlay/Dialog.tsx";
import type { Dismiss } from "../../ui/overlay/Overlay.tsx";
import { Segmented, Toggle } from "./controls.tsx";
import { DialogField } from "./dialog-form.tsx";
import { matcherSubject, type MatcherSubject } from "./hook-matcher.ts";
import { TextInput } from "./inputs.tsx";

const EVENTS: HookEventName[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "SessionEnd"];

/** 匹配器在每种事件上比的是什么，就说什么、举什么例子。 */
const MATCHER_COPY = {
	tool: { hint: "hooks.matcherHintTool", placeholder: "hooks.matcherPlaceholderTool" },
	start: { hint: "hooks.matcherHintStart", placeholder: "hooks.matcherPlaceholderStart" },
	turnEnd: { hint: "hooks.matcherHintTurnEnd", placeholder: "hooks.matcherPlaceholderTurnEnd" },
	sessionEnd: { hint: "hooks.matcherHintSessionEnd", placeholder: "hooks.matcherPlaceholderSessionEnd" },
} as const satisfies Record<MatcherSubject, { hint: MessageKey; placeholder: MessageKey }>;

function parseCustom(text: string): Record<string, unknown> | undefined | null {
	if (!text.trim()) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function HookForm({
	hook,
	scopes,
	defaultScope,
	onSave,
	onClose,
	onDelete,
}: {
	hook?: HookView;
	/** 能存到哪几处。没打开项目时只有用户级。 */
	scopes: { value: HookScope; label: string }[];
	defaultScope: HookScope;
	/** 存好了是 null，存不了是原因——原因说在弹窗里，弹窗不关。 */
	onSave: (scope: HookScope, draft: HookDraft) => Promise<string | null>;
	onClose: () => void;
	/** 删除要先确认，确认框叠在这个弹窗上面；删掉之后由调用方关它。 */
	onDelete?: () => void;
}) {
	const { t } = useI18n();
	const [scope, setScope] = useState<HookScope>(hook?.scope ?? defaultScope);
	const [event, setEvent] = useState<HookEventName>(hook?.event ?? "PreToolUse");
	const [type, setType] = useState<HookDraft["type"]>(hook?.type ?? "process");
	const [matcher, setMatcher] = useState(hook?.matcher ?? "");
	const [command, setCommand] = useState(hook?.command ?? "");
	const [args, setArgs] = useState((hook?.args ?? []).join("\n"));
	const [background, setBackground] = useState(hook?.async ?? false);
	const [shell, setShell] = useState(typeof hook?.shell === "string" ? hook.shell : "");
	const [timeoutText, setTimeoutText] = useState(hook?.timeout === undefined ? "" : String(hook.timeout));
	const [statusMessage, setStatusMessage] = useState(hook?.statusMessage ?? "");
	const [customJson, setCustomJson] = useState(hook?.custom ? JSON.stringify(hook.custom, null, 2) : "");
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const custom = parseCustom(customJson);
	const canSave = Boolean(command.trim()) && custom !== null && !saving;
	const subject = matcherSubject(event);
	const title = hook ? t("hooks.edit") : t("hooks.add");

	async function save(dismiss: Dismiss) {
		if (!canSave) return;
		const seconds = Number.parseInt(timeoutText, 10);
		setSaving(true);
		setFailure(null);
		const problem = await onSave(scope, {
			event,
			// 不看匹配器的事件上不存它：存下去，这条钩子就一次也不会跑。
			...(subject && matcher.trim() ? { matcher: matcher.trim() } : {}),
			type,
			command: command.trim(),
			...(type === "process"
				? { args: args.split("\n").map((arg) => arg.trim()).filter(Boolean) }
				: {
						async: background,
						// 设置文件里写的是 `shell: true`（用系统默认的那个）时，框里是空的，存回去仍是 true。
						...(shell.trim() ? { shell: shell.trim() } : hook?.shell === true ? { shell: true as const } : {}),
					}),
			...(statusMessage.trim() ? { statusMessage: statusMessage.trim() } : {}),
			...(seconds > 0 ? { timeout: seconds } : {}),
			enabled: hook?.enabled ?? true,
			...(custom ? { custom } : {}),
		});
		setSaving(false);
		if (problem) setFailure(problem);
		else dismiss();
	}

	return (
		<Dialog
			onClose={onClose}
			width={560}
			label={title}
			title={title}
			status={failure ? <p role="alert" className="mb-1 text-detail text-danger">{failure}</p> : undefined}
			bodyClassName="max-h-[min(600px,68dvh)]"
			actions={(dismiss) => (
				<>
					{onDelete && <DialogAction tone="danger" onClick={onDelete}>{t("common.delete")}</DialogAction>}
					<div className="flex-1" />
					<DialogAction onClick={() => dismiss()}>{t("common.cancel")}</DialogAction>
					<DialogAction tone="primary" disabled={!canSave} onClick={() => void save(dismiss)} data-ly-hook-save="">
						{hook ? t("common.save") : t("hooks.create")}
					</DialogAction>
				</>
			)}
		>
			{(dismiss) => (
				<form
					data-ly-hook-form=""
					className="grid gap-4"
					onSubmit={(submitted) => {
						submitted.preventDefault();
						void save(dismiss);
					}}
				>
					<div className="grid grid-cols-2 gap-3">
						<DialogField label={t("hooks.event")}>
							<Select value={event} onChange={setEvent} options={EVENTS.map((name) => ({ value: name, label: name }))} ariaLabel={t("hooks.event")} />
						</DialogField>
						<DialogField label={t("hooks.scope")}>
							{/* 编辑时不能换范围：换过去就是另一个文件里的另一条了，先删再建说得更清楚。 */}
							{hook || scopes.length < 2 ? (
								<div className="ly-field w-full text-ink-muted">{scopes.find((entry) => entry.value === scope)?.label ?? scope}</div>
							) : (
								<div className="w-fit"><Segmented value={scope} onChange={setScope} options={scopes} /></div>
							)}
						</DialogField>
					</div>

					<DialogField
						label={t("hooks.matcher")}
						htmlFor="ly-hook-matcher"
						optional={subject !== null}
						disabled={subject === null}
						hint={t(subject ? MATCHER_COPY[subject].hint : "hooks.matcherHintNone")}
					>
						<TextInput
							id="ly-hook-matcher"
							value={subject ? matcher : ""}
							onChange={setMatcher}
							disabled={subject === null}
							placeholder={subject ? t(MATCHER_COPY[subject].placeholder) : ""}
							mono
							spellCheck={false}
						/>
					</DialogField>

					<DialogField label={t("hooks.type")}>
						{/* 分段控件按字宽排，放进整行的字段里会被撑满，选项挤在左边、右边空出一截底。 */}
						<div className="w-fit">
							<Segmented
								value={type}
								onChange={setType}
								options={[
									{ value: "process", label: t("hooks.typeProcess") },
									{ value: "command", label: t("hooks.typeCommand") },
								]}
							/>
						</div>
					</DialogField>

					<DialogField label={t("hooks.command")} htmlFor="ly-hook-command">
						<TextInput id="ly-hook-command" value={command} onChange={setCommand} placeholder={t("hooks.commandPlaceholder")} mono spellCheck={false} />
					</DialogField>

					{type === "process" ? (
						<DialogField label={t("hooks.args")} optional hint={t("hooks.argsHint")}>
							<TextArea value={args} onChange={setArgs} rows={3} className="font-mono" resizable />
						</DialogField>
					) : (
						<div className="grid grid-cols-2 items-end gap-3">
							<DialogField label={t("hooks.shell")} htmlFor="ly-hook-shell">
								<TextInput id="ly-hook-shell" value={shell} onChange={setShell} placeholder={t("hooks.shellPlaceholder")} mono />
							</DialogField>
							<div className="flex h-[var(--ly-control)] items-center justify-between gap-4">
								<span className="text-detail font-medium text-ink">{t("hooks.async")}</span>
								<Toggle checked={background} onChange={setBackground} ariaLabel={t("hooks.async")} />
							</div>
						</div>
					)}

					<details className="group/advanced">
						<summary className="-ml-2 inline-flex h-7 cursor-pointer list-none items-center gap-1 rounded-md px-2 text-detail text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink">
							<ChevronRight size={14} className="transition-transform duration-[var(--ly-t-base)] group-open/advanced:rotate-90" aria-hidden />
							{t("hooks.advanced")}
						</summary>
						<div className="mt-3 grid gap-4">
							<div className="grid grid-cols-2 gap-3">
								<DialogField label={t("hooks.timeout")} hint={t("hooks.timeoutHint")}>
									<TextInput value={timeoutText} onChange={setTimeoutText} inputMode="numeric" placeholder="60" />
								</DialogField>
								<DialogField label={t("hooks.statusMessage")} optional>
									<TextInput value={statusMessage} onChange={setStatusMessage} placeholder={t("hooks.statusMessagePlaceholder")} />
								</DialogField>
							</div>
							<DialogField label={t("hooks.customJson")} optional error={custom === null ? t("hooks.customJsonError") : null}>
								<TextArea value={customJson} onChange={setCustomJson} rows={4} className="font-mono" placeholder={'{\n  "customKey": "value"\n}'} resizable />
							</DialogField>
						</div>
					</details>
					<button type="submit" className="hidden" tabIndex={-1} aria-hidden />
				</form>
			)}
		</Dialog>
	);
}
