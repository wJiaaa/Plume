/**
 * 添加一个模型供应商：先挑模板，再填 Key。
 *
 * 从前点「添加供应商」就往列表里存一个叫「新供应商」、地址是 `https://` 的空壳，再去右边一格格改；
 * 改到一半切走，空壳就留在列表里。现在填齐了才存。模板把地址和 API 格式替人填好——API 格式是最
 * 容易选错、选错了报错又最看不懂的那一项。
 */

import type { ApiFormat, ProviderConfig } from "@plume/core";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/index.ts";
import { ChevronLeft, Plus } from "../../ui/icons/index.ts";
import { Dialog, DialogAction } from "../../ui/overlay/Dialog.tsx";
import type { Dismiss } from "../../ui/overlay/Overlay.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { SecretInput, Segmented, TextInput, Toggle } from "./controls.tsx";
import { DialogField } from "./dialog-form.tsx";
import { API_OPTIONS } from "./ProviderEditor.tsx";
import { ProviderAvatar } from "./ProviderAvatar.tsx";
import { uniqueProviderName } from "./provider-transfer.ts";

type Draft = Pick<ProviderConfig, "name" | "baseUrl" | "api" | "apiKey">;

type Template = {
	id: string;
	name: string;
	baseUrl: string;
	api: ApiFormat;
	keyPlaceholder: string;
	/** 本机服务和自定义的地址可以不要 Key。 */
	keyless?: boolean;
	local?: boolean;
};

/*
 * 模型目录（`model-catalog.json`）里有每家的地址，没有 API 格式，所以这份短名单是手写的。地址和
 * 目录对过，目录里没有的是硅基流动和本机的 Ollama。只放最常见的几家：列表长到要搜索，就不再是
 * 「挑一个」而是「找一个」了，那时该从目录生成。
 */
const TEMPLATES: Template[] = [
	{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-responses", keyPlaceholder: "sk-…" },
	{ id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic-messages", keyPlaceholder: "sk-ant-…" },
	{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", api: "openai-chat-completions", keyPlaceholder: "sk-…" },
	{ id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", api: "openai-chat-completions", keyPlaceholder: "sk-or-…" },
	{ id: "moonshot", name: "Moonshot", baseUrl: "https://api.moonshot.cn/v1", api: "openai-chat-completions", keyPlaceholder: "sk-…" },
	{ id: "siliconflow", name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", api: "openai-chat-completions", keyPlaceholder: "sk-…" },
	{ id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", api: "openai-chat-completions", keyPlaceholder: "", keyless: true, local: true },
];

const CUSTOM: Template = { id: "custom", name: "", baseUrl: "", api: "openai-chat-completions", keyPlaceholder: "sk-…", keyless: true };

export function ProviderAddDialog({ taken, onClose, onAdd }: {
	/** 已有供应商的名字。同一家加第二个（第二把 Key）时，名字先替人带上序号。 */
	taken: readonly string[];
	onClose: () => void;
	onAdd: (draft: Draft, fetch: boolean) => void;
}) {
	const { t } = useI18n();
	const [template, setTemplate] = useState<Template | null>(null);
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [api, setApi] = useState<ApiFormat>("openai-chat-completions");
	const [apiKey, setApiKey] = useState("");
	const [fetch, setFetch] = useState(true);

	// 挑完模板，光标落在还没填的第一格：多半是 Key；自定义和本机服务是名字。
	useEffect(() => {
		if (!template) return;
		document.getElementById(template.keyless ? "ly-provider-name" : "ly-provider-key")?.focus();
	}, [template]);

	function pick(next: Template) {
		setTemplate(next);
		setName(next.name ? uniqueProviderName(taken, next.name) : "");
		setBaseUrl(next.baseUrl);
		setApi(next.api);
		setApiKey("");
	}

	const url = baseUrl.trim();
	const badUrl = url !== "" && !/^https?:\/\/\S+$/.test(url);
	const ready = template !== null && name.trim() !== "" && url !== "" && !badUrl && (template.keyless || apiKey.trim() !== "");

	function submit(dismiss: Dismiss) {
		if (!ready) return;
		const draft: Draft = { name: name.trim(), baseUrl: url, api, apiKey: apiKey.trim() };
		dismiss(() => {
			onAdd(draft, fetch);
			onClose();
		});
	}

	const title = !template ? (
		t("providerAdd.title")
	) : (
		<>
			<IconButton label={t("providerAdd.back")} onClick={() => setTemplate(null)} className="-my-1 -ml-1.5" icon={<ChevronLeft size={16} strokeWidth={1.8} />} data-ly-provider-back="" />
			{template === CUSTOM ? <CustomMark small /> : <ProviderAvatar name={template.name} size="sm" />}
			{template === CUSTOM ? t("providerAdd.customTitle") : template.name}
		</>
	);

	return (
		<Dialog
			onClose={onClose}
			width={560}
			label={t("providerAdd.title")}
			title={title}
			detail={template ? undefined : t("providerAdd.detail")}
			bodyClassName="max-h-[min(560px,64dvh)]"
			actions={(dismiss) => (
				<>
					<div className="flex-1" />
					<DialogAction onClick={() => dismiss()}>{t("common.cancel")}</DialogAction>
					{template && (
						<DialogAction tone="primary" disabled={!ready} onClick={() => submit(dismiss)} data-ly-provider-add="">
							{t("modelSettings.addProvider")}
						</DialogAction>
					)}
				</>
			)}
		>
			{(dismiss) =>
				!template ? (
					<div className="grid grid-cols-4 gap-2" data-ly-provider-templates="">
						{[...TEMPLATES, CUSTOM].map((one) => (
							<button
								key={one.id}
								type="button"
								data-ly-provider-template={one.id}
								onClick={() => pick(one)}
								className="flex flex-col items-center gap-2 rounded-lg px-1.5 pt-4 pb-3 ring-1 ring-line ring-inset transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover"
							>
								{one === CUSTOM ? <CustomMark /> : <ProviderAvatar name={one.name} size="lg" />}
								<span className="text-detail font-medium text-ink">{one === CUSTOM ? t("providerAdd.custom") : one.name}</span>
								{(one.local || one === CUSTOM) && (
									<span className="-mt-1.5 text-caption text-ink-faint">{one.local ? t("providerAdd.local") : t("providerAdd.customDetail")}</span>
								)}
							</button>
						))}
					</div>
				) : (
					<form
						data-ly-provider-form=""
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							submit(dismiss);
						}}
					>
						<DialogField label={t("providerAdd.name")} htmlFor="ly-provider-name">
							<TextInput id="ly-provider-name" value={name} onChange={setName} placeholder={t("providerAdd.namePlaceholder")} autoComplete="off" />
						</DialogField>
						<DialogField label={t("provider.apiFormat")} hint={t("provider.apiFormatDetail")}>
							{/* 分段控件按字宽排，放进整行的字段里会被撑满。 */}
							<div className="w-fit">
								<Segmented value={api} onChange={setApi} options={API_OPTIONS} />
							</div>
						</DialogField>
						<DialogField label="Base URL" htmlFor="ly-provider-url" error={badUrl ? t("providerAdd.urlInvalid") : null}>
							<TextInput id="ly-provider-url" value={baseUrl} onChange={setBaseUrl} invalid={badUrl} mono placeholder="https://api.example.com/v1" spellCheck={false} autoComplete="off" />
						</DialogField>
						<DialogField label="API Key" htmlFor="ly-provider-key" optional={template.keyless} hint={template.keyless ? t("providerAdd.keyOptionalHint") : null}>
							<SecretInput id="ly-provider-key" value={apiKey} onChange={setApiKey} placeholder={template.keyPlaceholder} />
						</DialogField>
						<div className="flex items-center justify-between gap-4">
							<div className="min-w-0">
								<div className="text-detail font-medium text-ink">{t("providerAdd.fetch")}</div>
								<div className="mt-0.5 text-caption text-ink-faint">{t("providerAdd.fetchDetail")}</div>
							</div>
							<Toggle checked={fetch} onChange={setFetch} ariaLabel={t("providerAdd.fetch")} />
						</div>
						<button type="submit" className="hidden" tabIndex={-1} aria-hidden />
					</form>
				)
			}
		</Dialog>
	);
}

/** 「自定义」没有名字可取首字母，画一个虚线框里的加号，和头像一样大。 */
function CustomMark({ small }: { small?: boolean }) {
	return (
		<span aria-hidden className={`grid shrink-0 place-items-center border border-dashed border-ink-faint text-ink-muted ${small ? "h-5 w-5 rounded-md" : "h-9 w-9 rounded-lg"}`}>
			<Plus size={small ? 12 : 16} strokeWidth={1.8} />
		</span>
	);
}
