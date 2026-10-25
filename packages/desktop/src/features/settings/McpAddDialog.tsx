/**
 * 手动添加一台 MCP 服务。入口在设置 › 插件 › MCP 标签右侧的 ⋯。
 *
 * 从前是点一下就往列表里塞一张叫「新建 stdio 服务」、命令是 `npx` 的空卡片，再去卡片里改；
 * 什么都没填的那张卡片已经存进了设置，开着、连着，连接失败挂在列表里。现在先填，填齐了才存。
 */

import type { McpServerConfig } from "@plume/core";
import { useState } from "react";
import { useI18n } from "../../i18n/index.ts";
import { Globe, SquareTerminal } from "../../ui/icons/index.ts";
import { Input } from "../../ui/inputs/NativeField.tsx";
import { Select } from "../../ui/inputs/Select.tsx";
import { Dialog, DialogAction } from "../../ui/overlay/Dialog.tsx";
import type { Dismiss } from "../../ui/overlay/Overlay.tsx";
import { Segmented } from "./controls.tsx";
import { DialogField } from "./dialog-form.tsx";
import { TextInput } from "./inputs.tsx";
import { EnvRows } from "./McpSettings.tsx";

type Kind = "stdio" | "http";

export function McpAddDialog({ transport, taken, onClose, onAdd }: {
	/** 从菜单的哪一项进来的。弹窗里还能换，填过的字不丢。 */
	transport: Kind;
	/** 已有服务的名字。工具在对话里叫 `mcp__名字__工具`，重名的两台会抢同一个前缀。 */
	taken: readonly string[];
	onClose: () => void;
	onAdd: (server: McpServerConfig) => void;
}) {
	const { t } = useI18n();
	const [kind, setKind] = useState<Kind>(transport);
	const [name, setName] = useState("");
	const [command, setCommand] = useState("");
	const [args, setArgs] = useState("");
	const [url, setUrl] = useState("");
	const [wire, setWire] = useState<"http" | "sse">("http");
	const [env, setEnv] = useState<Record<string, string>>({});

	const clean = name.trim();
	const duplicate = taken.some((existing) => existing.trim().toLowerCase() === clean.toLowerCase());
	const badUrl = url.trim() !== "" && !/^https?:\/\/\S+$/.test(url.trim());
	const ready = clean !== "" && !duplicate && (kind === "stdio" ? command.trim() !== "" : url.trim() !== "" && !badUrl);

	function submit(dismiss: Dismiss) {
		if (!ready) return;
		const id = `mcp-${Date.now().toString(36)}`;
		const server: McpServerConfig =
			kind === "stdio"
				? { id, name: clean, transport: "stdio", command: command.trim(), args: args.split(" ").filter(Boolean), env, enabled: true }
				: { id, name: clean, transport: wire, url: url.trim(), env, enabled: true };
		// 传了回调的 `dismiss` 不再调 `onClose`，所以两件事都写在这里。
		dismiss(() => {
			onAdd(server);
			onClose();
		});
	}

	/** 回车提交只挂在单行框上：环境变量那一行自己用回车加变量。 */
	const enter = (dismiss: Dismiss) => (event: React.KeyboardEvent) => {
		if (event.key === "Enter") submit(dismiss);
	};

	return (
		<Dialog
			onClose={onClose}
			width={520}
			label={t("mcp.addTitle")}
			title={t("mcp.addTitle")}
			bodyClassName="max-h-[min(560px,64dvh)]"
			actions={(dismiss) => (
				<>
					<div className="flex-1" />
					<DialogAction onClick={() => dismiss()}>{t("common.cancel")}</DialogAction>
					<DialogAction tone="primary" disabled={!ready} onClick={() => submit(dismiss)} data-ly-mcp-add="">
						{t("mcp.add")}
					</DialogAction>
				</>
			)}
		>
			{(dismiss) => (
				<div className="grid gap-4" data-ly-mcp-dialog="">
					<div className="w-fit">
						<Segmented
							value={kind}
							onChange={setKind}
							options={[
								{ value: "stdio", label: t("mcp.kindStdio") },
								{ value: "http", label: t("mcp.kindHttp") },
							]}
						/>
					</div>

					<DialogField
						label={t("mcpSettings.name")}
						htmlFor="ly-mcp-name"
						hint={t("mcp.nameHint")}
						error={duplicate ? t("mcp.nameTaken", { name: clean }) : null}
					>
						<TextInput id="ly-mcp-name" autoFocus value={name} onChange={setName} invalid={duplicate} placeholder="github" spellCheck={false} autoComplete="off" onKeyDown={enter(dismiss)} />
					</DialogField>

					{kind === "stdio" ? (
						<>
							<DialogField label={t("mcpSettings.command")} htmlFor="ly-mcp-command">
								<div className="ly-field gap-2 font-mono">
									<SquareTerminal size={14} strokeWidth={1.8} className="shrink-0 text-ink-faint" aria-hidden />
									<Input
										id="ly-mcp-command"
										value={command}
										onChange={(event) => setCommand(event.target.value)}
										onKeyDown={enter(dismiss)}
										placeholder="npx"
										spellCheck={false}
										autoComplete="off"
										className="h-full min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-faint"
									/>
								</div>
							</DialogField>
							<DialogField label={t("mcp.args")} htmlFor="ly-mcp-args" optional hint={t("mcp.argsDetail")}>
								<TextInput id="ly-mcp-args" value={args} onChange={setArgs} mono placeholder="-y @modelcontextprotocol/server-github" spellCheck={false} onKeyDown={enter(dismiss)} />
							</DialogField>
						</>
					) : (
						<div className="grid grid-cols-[1fr_auto] items-start gap-3">
							<DialogField label="URL" htmlFor="ly-mcp-url" hint={t("mcp.urlHint")} error={badUrl ? t("mcp.urlInvalid") : null}>
								<div className="ly-field gap-2 font-mono">
									<Globe size={14} strokeWidth={1.8} className="shrink-0 text-ink-faint" aria-hidden />
									<Input
										id="ly-mcp-url"
										value={url}
										onChange={(event) => setUrl(event.target.value)}
										onKeyDown={enter(dismiss)}
										placeholder="https://mcp.example.com/mcp"
										spellCheck={false}
										autoComplete="off"
										className="h-full min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-faint"
									/>
								</div>
							</DialogField>
							<DialogField label={t("mcp.transport")}>
								<Select
									value={wire}
									onChange={setWire}
									ariaLabel={t("mcp.transport")}
									options={[
										{ value: "http", label: "Streamable HTTP" },
										{ value: "sse", label: "SSE" },
									]}
								/>
							</DialogField>
						</div>
					)}

					<DialogField label={t("mcpSettings.env")} optional hint={t("mcpSettings.envHint")}>
						<EnvRows env={env} onChange={setEnv} />
					</DialogField>
				</div>
			)}
		</Dialog>
	);
}
