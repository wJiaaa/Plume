/**
 * Adding an account, in a dialog: pick a host, say where it is, paste a token.
 *
 * Three fields, and the middle one is the reason this app is not GitHub-only. Every host here runs
 * somewhere other than its own domain — a company GitLab, a self-run Gitea, GitHub Enterprise —
 * and the address is the whole difference between them.
 *
 * The token is the step that loses people, so the link beside it goes to the page that creates one
 * on *their* instance, with the scopes already filled in where the host allows it. Pointing at
 * gitlab.com's token page for somebody signing in to `git.corp` would be worse than no link.
 *
 * Nothing is stored until the host has confirmed who the token belongs to. A rejected token fails
 * here, on the form, while it is still on the clipboard — rather than in a pane somewhere else as
 * an empty list.
 */

import { Check, ExternalLink, ShieldCheck } from "../../ui/icons/index.ts";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { useEffect, useRef, useState } from "react";
import type { ForgeAccount, ForgeKind, ForgeKindInfo } from "@plume/contract";
import { Avatar, useAccountActions } from "../pull-requests/index.ts";
import { SecretInput, TextInput } from "./controls.tsx";
import { bridge } from "../../services/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { Dialog, DialogAction } from "../../ui/overlay/Dialog.tsx";
import { DialogField } from "./dialog-form.tsx";
import { ForgeBrandIcon } from "./ForgeBrandIcon.tsx";

/**
 * Where a host keeps its token page, for the instance actually being signed in to.
 *
 * The hosted instances get the URL from the main process, scopes and all. Anything else gets the
 * path that host uses, appended to whatever address was typed — right for every self-hosted
 * deployment except one served from a sub-path, which is rare enough to be worth the link that
 * lands one click away instead of a link that lands nowhere.
 */
function tokenUrl(info: ForgeKindInfo, baseUrl: string): string | null {
	const base = baseUrl.trim().replace(/\/+$/, "");
	if (!base) return info.tokenUrl || null;
	if (info.baseUrl && base === info.baseUrl) return info.tokenUrl;

	switch (info.kind) {
		case "github":
			return `${base}/settings/tokens/new?scopes=repo,read:org,read:user&description=Plume`;
		case "gitlab":
			return `${base}/-/user_settings/personal_access_tokens?name=Plume&scopes=api`;
		case "gitee":
			return `${base}/personal_access_tokens/new`;
		case "gitea":
			return `${base}/user/settings/applications`;
	}
}

export function ForgeSignIn({ kinds, onClose }: { kinds: ForgeKindInfo[]; onClose: () => void }) {
	const { t } = useI18n();
	const { signIn } = useAccountActions();
	const [kind, setKind] = useState<ForgeKind>("github");
	const [baseUrl, setBaseUrl] = useState(kinds.find((k) => k.kind === "github")?.baseUrl ?? "https://github.com");
	const [token, setToken] = useState("");
	const [label, setLabel] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** 验过了的那个账号。先在弹窗里给一眼「连上的是谁」，再关——令牌贴错号的人在这里就能发现。 */
	const [added, setAdded] = useState<ForgeAccount | null>(null);
	const addedView = useRef<HTMLDivElement>(null);

	/*
	 * 成功页一出来，焦点交给「完成」，回车就能关。
	 *
	 * 那颗按钮上的 `autoFocus` 不管用：它是表单换成成功页时才挂上的，而焦点原先在被卸掉的输入框里，
	 * 实测落回了 body——回车什么也不做。
	 */
	useEffect(() => {
		if (added) addedView.current?.closest("[data-ly-modal]")?.querySelector<HTMLElement>("[data-ly-forge-done]")?.focus();
	}, [added]);

	const info = kinds.find((entry) => entry.kind === kind) ?? kinds[0];
	const help = info ? tokenUrl(info, baseUrl) : null;
	const ready = !busy && Boolean(token.trim()) && Boolean(baseUrl.trim());

	/*
	 * Switching host refills the address, unless it has been edited into something else.
	 *
	 * A blank field after every switch means retyping `https://github.com` to try the obvious
	 * thing; keeping a stale `https://gitlab.com` under a GitHub heading is worse. Comparing
	 * against the defaults distinguishes "never touched it" from "typed my own", which is the
	 * only case where holding on to it is right.
	 */
	const choose = (next: ForgeKind) => {
		const untouched = kinds.some((entry) => entry.baseUrl && entry.baseUrl === baseUrl.trim()) || !baseUrl.trim();
		setKind(next);
		setError(null);
		if (untouched) setBaseUrl(kinds.find((entry) => entry.kind === next)?.baseUrl ?? "");
	};

	const save = async () => {
		if (!ready) return;
		setBusy(true);
		setError(null);
		const result = await signIn({ kind, baseUrl, token, label });
		setBusy(false);
		if (result.error || !result.account) {
			setError(result.error ?? t("forge.verifyFailed"));
			return;
		}
		setAdded(result.account);
	};

	return (
		<Dialog
			onClose={onClose}
			width={500}
			label={t("forge.addTitle")}
			title={t("forge.addTitle")}
			bodyClassName="max-h-[min(580px,66dvh)]"
			actions={(dismiss) => added ? (
				<>
					<div className="flex-1" />
					<DialogAction tone="primary" onClick={() => dismiss()} data-ly-forge-done="">{t("common.done")}</DialogAction>
				</>
			) : (
				/* 动词写在按钮上。这两颗曾经是一个盾牌一个叉，名字挂在 tooltip 上——见 `DialogAction`。 */
				<>
					<div className="flex-1" />
					<DialogAction onClick={() => dismiss()}>{t("common.cancel")}</DialogAction>
					<DialogAction tone="primary" disabled={!ready} onClick={() => void save()} data-ly-forge-verify="">
						{busy && <ActionSpinner size={13} />}
						{busy ? t("forge.verifying") : t("forge.verifyAndSave")}
					</DialogAction>
				</>
			)}
		>
			{added ? (
				<div ref={addedView} className="flex flex-col items-center py-4 text-center" data-ly-forge-added="">
					<span className="relative">
						<Avatar accountId={added.id} login={added.login} url={added.avatarUrl} size={52} />
						<span className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full bg-ok text-shell ring-2 ring-float" aria-hidden>
							<Check size={12} strokeWidth={3} />
						</span>
					</span>
					<div className="mt-3 text-body font-medium text-ink">{added.login}</div>
					<div className="text-detail text-ink-muted">{info?.name} · {host(added.baseUrl)}</div>
				</div>
			) : (
				<form
					data-ly-forge-sign-in=""
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<div>
						<div role="radiogroup" aria-label={t("forge.host")} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(kinds.length, 1)}, minmax(0, 1fr))` }}>
							{kinds.map((entry) => {
								const on = entry.kind === kind;
								return (
									<button
										key={entry.kind}
										type="button"
										role="radio"
										aria-checked={on}
										data-ly-forge-kind={entry.kind}
										onClick={() => choose(entry.kind)}
										className={`flex flex-col items-center gap-2 rounded-lg px-2 pt-3.5 pb-3 ring-inset transition-[box-shadow,background-color] duration-[var(--ly-t-quick)] ${
											on ? "ring-[1.5px] ring-ink/80" : "ring-1 ring-line hover:bg-card-hover"
										}`}
									>
										<span className="grid size-6 place-items-center"><ForgeBrandIcon kind={entry.kind} size={20} /></span>
										<span className="text-label font-medium text-ink">{entry.name}</span>
									</button>
								);
							})}
						</div>
						{/* What is different about this host, said while the choice is still being made. */}
						{info?.note && <p className="mt-2 text-caption leading-relaxed text-ink-faint">{info.note}</p>}
					</div>

					<DialogField label={t("forge.baseUrl")} htmlFor="ly-forge-base" hint={t("forge.baseUrlDetail")}>
						<TextInput id="ly-forge-base" value={baseUrl} onChange={setBaseUrl} placeholder="https://git.example.com" mono spellCheck={false} autoComplete="off" />
					</DialogField>

					<DialogField
						label={(
							<>
								{t("forge.token")}
								{help && (
									<button
										type="button"
										onClick={() => void bridge.system.openExternal(help)}
										className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-caption font-normal text-accent hover:underline"
									>
										{t("forgeSignIn.createToken")}
										<ExternalLink size={11} strokeWidth={2} aria-hidden />
									</button>
								)}
							</>
						)}
					>
						<SecretInput value={token} onChange={(next) => { setToken(next); setError(null); }} placeholder={t("forge.pasteToken")} />
						{/* 被拒的原因贴着令牌说：多半是它的问题，而说在表单最底下的那一行会落进滚动区看不见。 */}
						{error && <p role="alert" className="mt-1.5 break-words text-caption text-danger">{error}</p>}
						{info?.scopes && <p className="mt-1.5 text-caption text-ink-faint">{t("forgeSignIn.needsScopes")} {info.scopes}</p>}
						<p className="mt-1.5 flex items-start gap-1.5 text-caption leading-relaxed text-ink-faint">
							<ShieldCheck size={12} strokeWidth={1.8} className="mt-0.5 shrink-0" aria-hidden />
							{t("forge.tokenStorageInline")}
						</p>
						{/*
						 * 令牌存在哪儿、封到什么程度，说在粘贴框底下。
						 *
						 * 从前它是账号列表页底部常驻的一段小字，登录完之后再没人读——而关心这件事的那一刻
						 * 正是此刻：手里捏着一个刚生成的令牌，在决定要不要交给这个程序。最后那句「介意的话
						 * 给它设一个短一点的有效期」在这里是句能照做的建议，在列表页上只是一句感慨。
						 */}
					</DialogField>

					<DialogField label={t("forge.nickname")} htmlFor="ly-forge-label" hint={t("forge.nicknameDetail")}>
						<TextInput id="ly-forge-label" value={label} onChange={setLabel} placeholder={t("forge.nicknamePlaceholder")} />
					</DialogField>

					<button type="submit" className="hidden" tabIndex={-1} aria-hidden />
				</form>
			)}
		</Dialog>
	);
}

function host(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}
