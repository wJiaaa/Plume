import type { AppearanceSettings as Appearance, ChatBackgroundEffect } from "@plume/core";
import { useState } from "react";
import { ImagePlus } from "../../ui/icons/index.ts";
import { Button } from "../../ui/primitives/Button.tsx";
import { BACKDROP_EFFECTS, BACKDROP_OPACITY } from "../../lib/chat-backdrop.ts";
import { bridge } from "../../services/index.ts";
import { useI18n, type MessageKey } from "../../i18n/index.ts";
import { BackdropLayer, useChatBackdropImage } from "../conversation/index.ts";
import { Card, Row, SectionTitle, Segmented, Toggle } from "./controls.tsx";
import { Slider } from "./pickers.tsx";

const EFFECT_KEYS: Record<ChatBackgroundEffect, { label: MessageKey; detail: MessageKey }> = {
	none: { label: "appearance.chatBackgroundEffectNone", detail: "appearance.chatBackgroundEffectNoneDetail" },
	dither: { label: "appearance.chatBackgroundEffectDither", detail: "appearance.chatBackgroundEffectDitherDetail" },
	ascii: { label: "appearance.chatBackgroundEffectAscii", detail: "appearance.chatBackgroundEffectAsciiDetail" },
	halftone: { label: "appearance.chatBackgroundEffectHalftone", detail: "appearance.chatBackgroundEffectHalftoneDetail" },
	scanlines: { label: "appearance.chatBackgroundEffectScanlines", detail: "appearance.chatBackgroundEffectScanlinesDetail" },
	haze: { label: "appearance.chatBackgroundEffectHaze", detail: "appearance.chatBackgroundEffectHazeDetail" },
};

const percent = (opacity: number) => Math.round(opacity * 100);

/**
 * 外观页里「会话背景」那一节：开关、选图、换效果、调浓淡，上面一块按新对话的样子实时预览。
 *
 * 关掉时只剩开关那一行：图还在，其余几项都是在调一个看不见的东西。
 */
export function ChatBackgroundSettings({ appearance, patch }: { appearance: Appearance; patch: (next: Partial<Appearance>) => void }) {
	const { t } = useI18n();
	const url = useChatBackdropImage();
	const [busy, setBusy] = useState(false);
	const [tooLarge, setTooLarge] = useState(false);
	const hasImage = Boolean(appearance.chatBackground);
	const shown = hasImage && appearance.chatBackgroundEnabled;

	const choose = async () => {
		setBusy(true);
		try {
			const picked = await bridge.chatBackground.pick();
			setTooLarge(picked !== null && "error" in picked);
			// 一并打开：关着的时候选了图却看不见，像是没选上。
			if (picked && "name" in picked) patch({ chatBackground: picked.name, chatBackgroundEnabled: true });
		} finally {
			setBusy(false);
		}
	};
	const remove = async () => {
		setBusy(true);
		try {
			await bridge.chatBackground.remove();
			patch({ chatBackground: null });
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<SectionTitle>{t("appearance.chatBackground")}</SectionTitle>
			<p className="-mt-1.5 mb-3 text-caption text-ink-muted">{t("appearance.chatBackgroundDetail")}</p>
			<Card className="mb-8" data-ly-chat-background-settings="">
				{hasImage && (
					<Row
						title={t("appearance.chatBackgroundEnabled")}
						control={<Toggle checked={appearance.chatBackgroundEnabled} onChange={(chatBackgroundEnabled) => patch({ chatBackgroundEnabled })} />}
					/>
				)}
				{(!hasImage || shown) && (
					<div className={hasImage ? "border-t border-line-soft p-4" : "p-4"}>
						{hasImage ? (
							<>
								<div data-ly-chat-background-preview="" className="relative isolate h-36 overflow-hidden rounded-lg border border-line-float bg-shell">
									{url && <BackdropLayer url={url} effect={appearance.chatBackgroundEffect} opacity={appearance.chatBackgroundOpacity} />}
									<span className="pointer-events-none absolute bottom-2 left-2.5 text-caption text-ink-faint">
										{t("appearance.chatBackgroundPreview", { percent: percent(appearance.chatBackgroundOpacity) })}
									</span>
								</div>
								<div className="mt-3 flex items-center justify-end gap-2">
									<Button size="sm" onClick={() => void choose()} loading={busy}>
										{t("appearance.chatBackgroundChange")}
									</Button>
									<Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy}>
										{t("common.remove")}
									</Button>
								</div>
							</>
						) : (
							<button
								type="button"
								onClick={() => void choose()}
								disabled={busy}
								className="flex h-36 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:border-ink-faint hover:bg-card-hover hover:text-ink disabled:opacity-45"
							>
								<ImagePlus size={18} strokeWidth={1.8} aria-hidden />
								<span className="text-label">{t("appearance.chatBackgroundChoose")}</span>
							</button>
						)}
						{tooLarge && <p className="mt-2 text-caption text-danger">{t("appearance.chatBackgroundTooLarge")}</p>}
					</div>
				)}
				{shown && (
					<div className="border-t border-line-soft">
						<Row
							title={t("appearance.chatBackgroundEffect")}
							detail={t(EFFECT_KEYS[appearance.chatBackgroundEffect].detail)}
							control={
								<Segmented
									value={appearance.chatBackgroundEffect}
									onChange={(chatBackgroundEffect) => patch({ chatBackgroundEffect })}
									options={BACKDROP_EFFECTS.map((effect) => ({ value: effect, label: t(EFFECT_KEYS[effect].label) }))}
								/>
							}
						/>
						<Row
							title={t("appearance.chatBackgroundOpacity")}
							detail={t("appearance.chatBackgroundOpacityDetail")}
							control={
								<div className="flex items-center gap-3">
									<Slider
										value={percent(appearance.chatBackgroundOpacity)}
										onChange={(value) => patch({ chatBackgroundOpacity: value / 100 })}
										min={percent(BACKDROP_OPACITY.min)}
										max={percent(BACKDROP_OPACITY.max)}
										label={t("appearance.chatBackgroundOpacity")}
									/>
									<span className="min-w-[2.6em] shrink-0 text-right font-mono text-label whitespace-nowrap text-ink tabular-nums">{percent(appearance.chatBackgroundOpacity)}%</span>
								</div>
							}
						/>
					</div>
				)}
			</Card>
		</>
	);
}
