/**
 * 人说的一句话，画成一个气泡——子智能体面板用。
 *
 * 主会话和侧边聊天的气泡（`UserMessage`）多着时间线上那一套：撤回、跳转、技能与引用的胶囊。子智能体
 * 面板要的只是「这句话 + 它带的附件」。它从前把所有文本块直接拼起来摊开——给它发一份文件，气泡里
 * 就是整篇文件正文，前面还顶着一行写给模型看的 `### Attached file: …`。
 */

import type { UserContent, UserMessage } from "@plume/core";

import { SESSION_THUMB_EDGE } from "../../../shared/session-image.ts";
import { translate } from "../../i18n/translate.ts";
import { spokenText } from "../../lib/spoken.ts";
import { TokenGlyph, tokenLook } from "../../ui/fileIcon.tsx";
import { openFromEvent } from "../image/index.ts";
import { BubbleText } from "./BubbleText.tsx";
import { imageBlockSrc } from "./image-block.ts";

type ImageBlock = Extract<UserContent, { type: "image" }>;

export function SpokenBubble({ message, className = "" }: { message: UserMessage; className?: string }) {
	const text = spokenText(message);
	// 大图过 IPC 前停放成了文件（`data` 为空、带 `media`），自己拼 `data:` 地址就是一张裂图。
	const images = message.content
		.filter((block): block is ImageBlock => block.type === "image")
		.flatMap((block) => imageBlockSrc(block, SESSION_THUMB_EDGE) ?? []);
	return (
		<div className={`ly-user-bubble max-w-[88%] rounded-2xl bg-card px-4 py-2.5 text-ink ${className}`} data-spoken-bubble="">
			{text && (
				<BubbleText
					text={text}
					files={message.attachments ?? []}
					className="text-body leading-relaxed"
					/*
					 * 这里的标签只认名字，不带动作：子智能体面板没有能承接「打开」的地方（文件面板属于主窗口），
					 * 先认出它、画成一枚标签，不给一条点了没反应的路。
					 */
					renderFile={(file, at) => {
						const look = tokenLook(file.name, file.kind);
						return (
							<span key={at} className="ly-attachment-token" data-kind={file.kind} data-glyph={look ? "" : undefined}>
								{look && <TokenGlyph look={look} />}
								{file.label ?? file.name}
							</span>
						);
					}}
				/>
			)}
			{images.length > 0 && (
				<div className={`flex flex-wrap gap-1.5 ${text ? "mt-2" : ""}`}>
					{images.map((image, i) => (
						<button
							key={i}
							type="button"
							aria-label={translate("sideMessage.previewImage")}
							onClick={(event) =>
								openFromEvent(
									event,
									images.map(({ full }) => ({ src: full })),
									i,
								)
							}
							className="block overflow-hidden rounded-md border border-line bg-card shadow-xs transition-opacity duration-[var(--ly-t-quick)] hover:opacity-85"
						>
							<img src={image.src} alt={translate("sideMessage.attachedImage")} className="h-14 w-20 object-cover" />
						</button>
					))}
				</div>
			)}
		</div>
	);
}
